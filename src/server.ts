import http from 'http';
import path from 'path';
import express, { Request, Response } from 'express';
import { config } from './config';
import { getPool, checkConnection, getLastWebhookReceived } from './db/client';
import { initWss } from './ws';
import { startEmailScheduler } from './email/scheduler';
import { sendDailySummary } from './email/daily';
import { sendWeeklySummary } from './email/weekly';
import chatwootRouter from './webhooks/chatwoot';
import openphoneRouter from './webhooks/openphone';
import { getAvgEmbedLatencyMs } from './clustering/embedder';
import { getClusteringStats } from './clustering/engine';
import { query } from './db/client';
import { broadcast } from './ws';
import { DashboardState } from './types';

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Static dashboard ---
app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// --- Webhook routes ---
app.use('/webhooks/chatwoot', chatwootRouter);
app.use('/webhooks/openphone', openphoneRouter);

// --- Health check ---
app.get('/health', async (_req: Request, res: Response) => {
  const dbOk = await checkConnection();
  const { clusteredToday, labelsAppliedToday } = getClusteringStats();
  res.json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'connected' : 'disconnected',
    lastWebhookReceived: getLastWebhookReceived()?.toISOString() ?? null,
    clustering: {
      model: 'claude-haiku-4-5-20251001',
      threshold: config.clustering.threshold,
      avgEmbedLatencyMs: getAvgEmbedLatencyMs(),
      clusteredToday,
      labelsAppliedToday,
    },
  });
});

// --- Dev-only email test endpoints ---
if (config.nodeEnv !== 'production') {
  app.post('/test/daily-email', async (_req: Request, res: Response) => {
    try {
      await sendDailySummary();
      res.json({ ok: true, message: 'Daily email sent' });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/test/weekly-email', async (_req: Request, res: Response) => {
    try {
      await sendWeeklySummary();
      res.json({ ok: true, message: 'Weekly email sent' });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
}

// --- API: get full dashboard state (used by WS on reconnect) ---
app.get('/api/state', async (_req: Request, res: Response) => {
  try {
    const state = await buildDashboardState();
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

async function buildDashboardState(): Promise<DashboardState> {
  interface ClusterRow {
    id: string; label: string; slug: string;
    conversation_count: number; severity: string;
    created_at: Date; updated_at: Date;
  }
  interface EventRow {
    id: string; source: string; channel: string; external_id: string;
    contact_name: string; content: string; status: string;
    cluster_id: string; severity: string; received_at: Date; inbox_name: string | null;
  }

  const clusters = await query<ClusterRow>(
    `SELECT id, label, slug, conversation_count, severity, created_at, updated_at
     FROM clusters ORDER BY conversation_count DESC`
  );

  const recentEvents = await query<EventRow>(
    `SELECT id, source, channel, external_id, contact_name, content, status,
            cluster_id, severity, received_at, inbox_name
     FROM support_events ORDER BY received_at DESC LIMIT 20`
  );

  const openCount = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM support_events WHERE status = 'open'`
  );
  const criticalCount = clusters.filter((c) => c.severity === 'high').length;
  const { clusteredToday, labelsAppliedToday } = getClusteringStats();

  const mapEvent = (e: EventRow) => ({
    id: e.id,
    source: e.source as 'chatwoot' | 'openphone',
    channel: e.channel as 'chat' | 'call' | 'sms',
    externalId: e.external_id,
    contactName: e.contact_name ?? 'Unknown',
    content: e.content,
    status: e.status as 'open' | 'pending' | 'resolved',
    receivedAt: e.received_at,
    clusterId: e.cluster_id ?? null,
    clusterLabel: null,
    severity: (e.severity as 'high' | 'medium' | 'low') ?? null,
    inboxName: e.inbox_name ?? null,
  });

  // Fetch events per cluster (last 10 each)
  const clustersWithEvents = await Promise.all(
    clusters.map(async (c) => {
      const events = await query<EventRow>(
        `SELECT id, source, channel, external_id, contact_name, content, status,
                cluster_id, severity, received_at, inbox_name
         FROM support_events WHERE cluster_id = $1
         ORDER BY received_at DESC LIMIT 10`,
        [c.id]
      );
      return {
        id: c.id,
        label: c.label,
        slug: c.slug,
        centroid: null,
        conversationCount: c.conversation_count,
        severity: (c.severity as 'high' | 'medium' | 'low') ?? null,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        events: events.map(mapEvent),
      };
    })
  );

  return {
    clusters: clustersWithEvents,
    metrics: {
      openConversations: parseInt(openCount[0]?.cnt ?? '0', 10),
      activeClusters: clusters.length,
      criticalClusters: criticalCount,
      avgFirstResponseMinutes: 0,
    },
    recentEvents: recentEvents.map(mapEvent),
    clusteringStatus: {
      model: 'claude-haiku-4-5-20251001',
      threshold: config.clustering.threshold,
      avgEmbedLatencyMs: getAvgEmbedLatencyMs(),
      clusteredToday,
      labelsAppliedToday,
    },
  };
}

// --- Periodic state broadcast to WS clients ---
async function broadcastState(): Promise<void> {
  try {
    const state = await buildDashboardState();
    broadcast({ type: 'state', payload: state });
  } catch (err) {
    console.error('Failed to broadcast state:', err);
  }
}

// --- Server bootstrap ---
async function start(): Promise<void> {
  // Verify DB connection
  const pool = getPool();
  try {
    await pool.query('SELECT 1');
    console.log('Database connected');
  } catch (err) {
    console.error('Database connection failed:', err);
    console.warn('Continuing without DB — webhooks will fail until DB is available');
  }

  const server = http.createServer(app);
  initWss(server);

  server.listen(config.port, () => {
    console.log(`OmniCommerce Support Dashboard running on http://localhost:${config.port}`);
    console.log(`WebSocket endpoint: ws://localhost:${config.port}/ws`);
  });

  // Send full state to clients every 30 seconds
  setInterval(broadcastState, 30_000);

  // Start cron email jobs
  startEmailScheduler();
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

export default app;
