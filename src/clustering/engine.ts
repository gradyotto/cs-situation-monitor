import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { SupportEvent, Cluster } from '../types';
import { query, queryOne } from '../db/client';
import { embedContent, generateClusterLabel } from './embedder';
import { broadcast } from '../ws';

// Counters for dashboard status card
let clusteredToday = 0;
let labelsAppliedToday = 0;
let lastResetDate = new Date().toDateString();

function checkDailyReset(): void {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    clusteredToday = 0;
    labelsAppliedToday = 0;
    lastResetDate = today;
  }
}

export function getClusteringStats() {
  checkDailyReset();
  return { clusteredToday, labelsAppliedToday };
}

/** Cosine similarity between two equal-length vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Rolling average: update centroid with new embedding */
function updateCentroid(centroid: number[], newVec: number[], count: number): number[] {
  return centroid.map((c, i) => (c * (count - 1) + newVec[i]) / count);
}

/** Format a label as a Chatwoot-compatible slug (lowercase, dashes, max 32 chars) */
function labelToSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 32);
}

/** Compute severity based on cluster conversation count within the last 4 hours */
async function computeSeverity(clusterId: string): Promise<'high' | 'medium' | 'low'> {
  const result = await queryOne<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM support_events
     WHERE cluster_id = $1 AND received_at >= NOW() - INTERVAL '4 hours'`,
    [clusterId]
  );
  const cnt = parseInt(result?.cnt ?? '0', 10);
  if (cnt >= 10) return 'high';
  if (cnt >= 4) return 'medium';
  return 'low';
}

/** Write the cluster label back to Chatwoot for chat events */
async function applyLabelToChatwoot(event: SupportEvent, slug: string): Promise<void> {
  if (event.source !== 'chatwoot' || !config.chatwoot.apiToken || !config.chatwoot.accountId) return;

  const url = `${config.chatwoot.baseUrl}/api/v1/accounts/${config.chatwoot.accountId}/conversations/${event.externalId}/labels`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_access_token': config.chatwoot.apiToken,
      },
      body: JSON.stringify({ labels: [slug] }),
    });
    if (resp.ok) labelsAppliedToday++;
  } catch (err) {
    console.error('Failed to apply label to Chatwoot:', err);
  }
}

/** Persist a new SupportEvent to the DB — embedding is not stored after cluster
 *  assignment to avoid accumulating large vector data (1536 floats per row). */
async function persistEvent(event: SupportEvent): Promise<void> {
  await query(
    `INSERT INTO support_events
       (id, source, channel, external_id, contact_name, content, status, embedding, cluster_id, severity, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10)`,
    [
      event.id,
      event.source,
      event.channel,
      event.externalId,
      event.contactName,
      event.content,
      event.status,
      event.clusterId,
      event.severity,
      event.receivedAt,
    ]
  );
}

/** Main entry: embed → compare → assign or create → persist → broadcast */
export async function processEvent(event: SupportEvent): Promise<void> {
  checkDailyReset();

  // 1. Embed
  const embedding = await embedContent(event.content);

  // 2. Find best matching cluster by comparing against all cluster centroids
  interface ClusterRow {
    id: string;
    label: string;
    slug: string;
    centroid: string;
    conversation_count: number;
  }

  const clusters = await query<ClusterRow>(
    `SELECT id, label, slug, centroid::text, conversation_count FROM clusters`
  );

  let bestClusterId: string | null = null;
  let bestClusterLabel: string | null = null;
  let bestSlug: string | null = null;
  let bestSimilarity = -1;

  for (const cluster of clusters) {
    if (!cluster.centroid) continue;
    // Parse pgvector string format: [f1,f2,...]
    const centroidStr = cluster.centroid.replace(/^\[/, '').replace(/\]$/, '');
    const centroid = centroidStr.split(',').map(Number);
    const sim = cosineSimilarity(embedding, centroid);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestClusterId = cluster.id;
      bestClusterLabel = cluster.label;
      bestSlug = cluster.slug;
    }
  }

  let assignedClusterId: string;
  let assignedClusterLabel: string;

  if (bestSimilarity >= config.clustering.threshold && bestClusterId) {
    // 3a. Assign to existing cluster
    assignedClusterId = bestClusterId;
    assignedClusterLabel = bestClusterLabel!;

    // Update centroid (rolling average) and increment count
    const clusterRow = clusters.find((c) => c.id === bestClusterId)!;
    const oldCentroid = clusterRow.centroid
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map(Number);
    const newCount = clusterRow.conversation_count + 1;
    const newCentroid = updateCentroid(oldCentroid, embedding, newCount);
    const severity = await computeSeverity(assignedClusterId);

    await query(
      `UPDATE clusters
       SET centroid = $1::vector, conversation_count = $2, severity = $3
       WHERE id = $4`,
      [`[${newCentroid.join(',')}]`, newCount, severity, assignedClusterId]
    );
  } else {
    // 3b. Create new cluster
    const label = await generateClusterLabel(event.content);
    const slug = labelToSlug(label);
    assignedClusterId = uuidv4();
    assignedClusterLabel = label;

    // Handle slug collision by appending a short suffix
    let finalSlug = slug;
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM clusters WHERE slug = $1`,
      [slug]
    );
    if (existing) {
      finalSlug = `${slug.slice(0, 28)}-${assignedClusterId.slice(0, 4)}`;
    }
    bestSlug = finalSlug;

    await query(
      `INSERT INTO clusters (id, label, slug, centroid, conversation_count, severity)
       VALUES ($1, $2, $3, $4::vector, 1, 'low')`,
      [assignedClusterId, label, finalSlug, `[${embedding.join(',')}]`]
    );
  }

  // Update event with cluster assignment
  event.clusterId = assignedClusterId;
  event.clusterLabel = assignedClusterLabel;
  event.severity = await computeSeverity(assignedClusterId);

  // 4. Persist event (embedding discarded after cluster assignment)
  await persistEvent(event);

  clusteredToday++;

  // 5. Write label back to Chatwoot
  if (bestSlug) {
    await applyLabelToChatwoot(event, bestSlug);
  }

  // 6. Broadcast updated state to dashboard WebSocket clients
  const updatedCluster = await queryOne<Cluster>(
    `SELECT id, label, slug, conversation_count, severity, created_at, updated_at
     FROM clusters WHERE id = $1`,
    [assignedClusterId]
  );

  if (updatedCluster) {
    broadcast({ type: 'event', payload: event });
    broadcast({ type: 'cluster_update', payload: updatedCluster });
  }
}
