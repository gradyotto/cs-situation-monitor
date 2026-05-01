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

// In-memory centroid cache — avoids fetching large vector data from Supabase on every event
interface CentroidEntry {
  id: string;
  label: string;
  slug: string;
  centroid: number[];
  conversationCount: number;
  segment: 'customer' | 'driver';
}

const centroidCache = new Map<string, CentroidEntry>();
let cacheLoaded = false;

async function ensureCacheLoaded(): Promise<void> {
  if (cacheLoaded) return;
  const rows = await query<{
    id: string; label: string; slug: string;
    centroid: string; conversation_count: number; segment: string;
  }>(`SELECT id, label, slug, centroid::text, conversation_count, segment FROM clusters WHERE archived_at IS NULL`);
  for (const row of rows) {
    if (!row.centroid) continue;
    centroidCache.set(row.id, {
      id: row.id,
      label: row.label,
      slug: row.slug,
      centroid: parseCentroid(row.centroid),
      conversationCount: row.conversation_count,
      segment: row.segment as 'customer' | 'driver',
    });
  }
  cacheLoaded = true;
}

function parseCentroid(raw: string): number[] {
  return raw.replace(/^\[/, '').replace(/\]$/, '').split(',').map(Number);
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
       (id, source, channel, external_id, contact_name, content, status, embedding, cluster_id, severity, received_at, inbox_name, labels, segment)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11, $12, $13)`,
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
      event.inboxName ?? null,
      event.labels,
      event.segment,
    ]
  );
}

/** Main entry: embed → compare → assign or create → persist → broadcast */
export async function processEvent(event: SupportEvent): Promise<void> {
  checkDailyReset();

  // 1. Load centroid cache on first call (avoids repeated large vector fetches from Supabase)
  await ensureCacheLoaded();

  // 2. Embed — include agent labels in text so they influence cluster similarity
  const textToEmbed = event.labels.length > 0
    ? `${event.content}\nAgent labels: ${event.labels.join(', ')}`
    : event.content;
  const embedding = await embedContent(textToEmbed);

  // 3. Find best matching cluster from cache (same segment only)
  let bestClusterId: string | null = null;
  let bestClusterLabel: string | null = null;
  let bestSlug: string | null = null;
  let bestSimilarity = -1;
  let bestEntry: CentroidEntry | null = null;

  for (const entry of centroidCache.values()) {
    if (entry.segment !== event.segment) continue;
    const sim = cosineSimilarity(embedding, entry.centroid);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestClusterId = entry.id;
      bestClusterLabel = entry.label;
      bestSlug = entry.slug;
      bestEntry = entry;
    }
  }

  let assignedClusterId: string;
  let assignedClusterLabel: string;

  if (bestSimilarity >= config.clustering.threshold && bestClusterId && bestEntry) {
    // 3a. Assign to existing cluster
    assignedClusterId = bestClusterId;
    assignedClusterLabel = bestClusterLabel!;

    const newCount = bestEntry.conversationCount + 1;
    const newCentroid = updateCentroid(bestEntry.centroid, embedding, newCount);
    const severity = await computeSeverity(assignedClusterId);

    await query(
      `UPDATE clusters SET centroid = $1::vector, conversation_count = $2, severity = $3 WHERE id = $4`,
      [`[${newCentroid.join(',')}]`, newCount, severity, assignedClusterId]
    );

    // Update cache in place
    centroidCache.set(assignedClusterId, {
      ...bestEntry,
      centroid: newCentroid,
      conversationCount: newCount,
    });
  } else {
    // 3b. Create new cluster
    const label = await generateClusterLabel(event.content, event.labels);
    const slug = labelToSlug(label);
    assignedClusterId = uuidv4();
    assignedClusterLabel = label;

    // Slug collision check against cache (no DB round trip needed)
    let finalSlug = slug;
    const slugExists = [...centroidCache.values()].some((e) => e.slug === slug);
    if (slugExists) {
      finalSlug = `${slug.slice(0, 28)}-${assignedClusterId.slice(0, 4)}`;
    }
    bestSlug = finalSlug;

    await query(
      `INSERT INTO clusters (id, label, slug, centroid, conversation_count, severity, segment)
       VALUES ($1, $2, $3, $4::vector, 1, 'low', $5)`,
      [assignedClusterId, label, finalSlug, `[${embedding.join(',')}]`, event.segment]
    );

    // Add to cache
    centroidCache.set(assignedClusterId, {
      id: assignedClusterId,
      label,
      slug: finalSlug,
      centroid: embedding,
      conversationCount: 1,
      segment: event.segment,
    });
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

  // 6. Broadcast updated cluster to dashboard
  const updatedCluster = await queryOne<Cluster>(
    `SELECT id, label, slug, conversation_count, severity, created_at, updated_at, segment
     FROM clusters WHERE id = $1`,
    [assignedClusterId]
  );

  if (updatedCluster) {
    broadcast({ type: 'event', payload: event });
    broadcast({ type: 'cluster_update', payload: updatedCluster });
  }
}
