# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start with hot reload (ts-node-dev)
npm run build        # tsc + copy src/dashboard/index.html → dist/dashboard/
npm start            # Run compiled output (production)
npx tsc --noEmit     # Type check only, no output
```

The `db:migrate` script requires `psql` to be installed locally. For this project the schema is applied directly via Supabase's SQL editor instead.

## Architecture

This is a Node.js/TypeScript Express server that ingests support events from Chatwoot (chat) and OpenPhone (calls/SMS), clusters them using AI embeddings, and serves a live dashboard over WebSocket.

### Request flow

```
Chatwoot/OpenPhone webhook
  → src/webhooks/{chatwoot,openphone}.ts   (normalize to SupportEvent)
  → src/clustering/engine.ts               (embed → compare → assign/create cluster)
  → src/db/client.ts                       (persist to Supabase/pgvector)
  → src/ws.ts                              (broadcast cluster_update + event to dashboard)
```

### Key design decisions

**Embedding**: Uses OpenAI `text-embedding-3-small` (1536 dims). Embeddings are discarded after cluster assignment — only the cluster centroid is stored, not per-event embeddings. This keeps Supabase storage minimal.

**Clustering**: Full centroid scan on every event (no ANN index). Cosine similarity threshold is `CLUSTERING_THRESHOLD` (default 0.82). Centroids update as rolling averages. At 500+ clusters, switch to pgvector's ivfflat index via SQL instead.

**Chatwoot deduplication**: Only the first customer message per conversation is clustered. `message_type === 0` (or `'incoming'`) identifies customer messages. Subsequent messages in the same conversation are ignored. The `external_id` field stores the Chatwoot conversation ID.

**Severity**: Recomputed on every cluster update based on conversation count in the last 4 hours: high ≥ 10, medium ≥ 4, low < 4.

**Dashboard state**: The server broadcasts full state to WebSocket clients every 30 seconds. Individual events and cluster updates are also pushed immediately on ingest. The dashboard HTML (`src/dashboard/index.html`) is a single file with inline CSS/JS — no build step, copied verbatim to `dist/` during build.

**Email**: Two Claude Sonnet jobs via `node-cron` — daily at 07:00 and weekly Monday 08:00, both in `EMAIL_TIMEZONE`. Test endpoints `POST /test/daily-email` and `POST /test/weekly-email` are available in non-production environments.

### Schema state

The live Supabase schema has two columns not in `src/db/schema.sql` (added via manual migration):
- `support_events.inbox_name TEXT` — stores the Chatwoot inbox/channel name (e.g. "Web Chat", "Instagram")
- `clusters.archived_at TIMESTAMPTZ` — NULL = active, non-NULL = dismissed from dashboard

When making schema changes, apply them in Supabase SQL editor directly and update `schema.sql` to match.

### Environment

Deployed on Railway. All env vars are set in Railway's Variables panel — the local `.env` file is not committed. Key vars: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DATABASE_URL` (Supabase session pooler URL), `CHATWOOT_API_TOKEN`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_BASE_URL=https://cs.omnigreen.ai`.

### Chatwoot webhook configuration

Registered at `https://cs-situation-monitor-production.up.railway.app/webhooks/chatwoot`. Only two events should be checked: **Message Created** and **Conversation Status Changed**. The `api_access_token` header is NOT sent by Chatwoot on outbound webhooks — it is only used when calling the Chatwoot API (e.g. writing labels back).
