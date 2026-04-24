# OmniCommerce Support Intelligence Dashboard — Claude Code Build Prompt

## Project Overview

Build a production-ready **Customer Support Monitoring Dashboard** for OmniCommerce Technologies. The system ingests real-time support events from Chatwoot (chat) and OpenPhone (calls/SMS), uses Claude's API to cluster similar conversations by underlying issue, and serves a live dashboard UI. It also sends a daily summary email and a weekly trend analysis email to a configurable recipient list.

---

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript
- **Framework**: Express.js (REST + WebSocket via `ws`)
- **AI**: Anthropic Claude API (`claude-haiku-4-5-20251001` for clustering, `claude-sonnet-4-6` for email narrative generation)
- **Vector store**: pgvector extension on PostgreSQL (use `pg` driver)
- **Email**: Nodemailer with SMTP (configurable; default to SendGrid SMTP relay)
- **Scheduler**: `node-cron` for daily/weekly email jobs
- **Frontend**: Single-file vanilla HTML/CSS/JS served from Express (no build step)
- **Environment**: `.env` file using `dotenv`

---

## Project Structure

```
omnicommerce-support-dashboard/
├── src/
│   ├── server.ts              # Express app + WebSocket server
│   ├── webhooks/
│   │   ├── chatwoot.ts        # Chatwoot webhook handler
│   │   └── openphone.ts       # OpenPhone webhook handler
│   ├── clustering/
│   │   ├── embedder.ts        # Claude embeddings via API
│   │   └── engine.ts          # Cosine similarity + cluster assignment
│   ├── db/
│   │   ├── schema.sql         # Postgres schema including pgvector tables
│   │   └── client.ts          # pg Pool setup
│   ├── email/
│   │   ├── scheduler.ts       # node-cron daily + weekly jobs
│   │   ├── daily.ts           # Daily summary email generator
│   │   ├── weekly.ts          # Weekly trend analysis email generator
│   │   └── sender.ts          # Nodemailer transport wrapper
│   ├── dashboard/
│   │   └── index.html         # Single-file dashboard UI (inline CSS + JS)
│   └── config.ts              # Typed env config
├── .env.example
├── package.json
└── README.md
```

---

## Detailed Feature Requirements

### 1. Webhook Ingestion

**Chatwoot** (`POST /webhooks/chatwoot`):
- Accept and verify `api_access_token` header
- Handle event types: `conversation_created`, `message_created`, `conversation_status_changed`
- Extract: `conversation_id`, `contact.name`, `inbox_id`, message `content`, `created_at`, `status`
- Ignore `private: true` messages (internal agent notes)

**OpenPhone** (`POST /webhooks/openphone`):
- Handle event types: `message.received`, `call.completed`
- For calls: extract `from`, `to`, `duration`, `summary` (if provided by OpenPhone), `completedAt`
- For SMS: extract `from`, `body`, `receivedAt`
- Normalize both into the same internal event schema as Chatwoot messages

**Shared internal event schema**:
```typescript
interface SupportEvent {
  id: string;           // uuid generated on ingest
  source: 'chatwoot' | 'openphone';
  channel: 'chat' | 'call' | 'sms';
  externalId: string;   // conversation_id or call/message ID
  contactName: string;
  content: string;      // message body or call summary
  status: 'open' | 'pending' | 'resolved';
  receivedAt: Date;
  clusterId: string | null;
  clusterLabel: string | null;
  severity: 'high' | 'medium' | 'low' | null;
}
```

### 2. AI Clustering Engine

On every new inbound `SupportEvent`:

1. **Embed** the `content` field using the Anthropic API messages endpoint. Use `claude-haiku-4-5-20251001`. Prompt the model to return a JSON array of 1536 floats representing the semantic embedding of the support message. Store the embedding in the `support_events` pgvector column.

2. **Compare** against existing cluster centroids stored in the `clusters` table (also pgvector). Use cosine similarity. Threshold: `0.82`.

3. **Assign or create**:
   - If similarity >= 0.82: assign to matching cluster, update centroid (rolling average of member embeddings), increment `conversation_count`
   - If similarity < 0.82: create a new cluster. Use `claude-haiku-4-5-20251001` to generate a 3–5 word cluster label from the message content (e.g., "checkout payment failures", "login account access")

4. **Write label back to Chatwoot** for chat events: call `POST /api/v1/accounts/{account_id}/conversations/{conversation_id}/labels` with the cluster label slug.

5. **Determine severity** based on cluster size thresholds:
   - `high`: 10+ conversations in the cluster within the last 4 hours
   - `medium`: 4–9 conversations
   - `low`: 1–3 conversations

6. **Broadcast** the updated cluster state to all connected dashboard WebSocket clients.

### 3. Database Schema

```sql
-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  centroid vector(1536),
  conversation_count INTEGER DEFAULT 0,
  severity TEXT CHECK (severity IN ('high', 'medium', 'low')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE support_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  contact_name TEXT,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  embedding vector(1536),
  cluster_id UUID REFERENCES clusters(id),
  severity TEXT,
  received_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON support_events USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX ON support_events (cluster_id);
CREATE INDEX ON support_events (received_at);
```

### 4. Dashboard UI (`src/dashboard/index.html`)

Single HTML file served at `GET /`. Connects to the WebSocket server at `ws://localhost:{PORT}/ws`. Renders:

- **Top metrics bar**: open conversations, active clusters, avg first response time, critical clusters count — all updating live via WebSocket
- **Cluster panel** (left, ~65% width): expandable rows sorted by `conversation_count` descending. Each row shows cluster label, conversation count, severity badge, and a fill bar. Expanding reveals individual conversation rows with channel badge (`chat`/`call`/`sms`), contact name, message preview, and timestamp.
- **Right panel** with three tabs — Live Feed (last 20 events in real time), Channels breakdown (Chatwoot vs OpenPhone with bar), Agent load (if Chatwoot agent assignment data is available)
- **Clustering engine status card**: model name, similarity threshold, embed latency (track rolling average), messages clustered today, auto-labels applied today

Use monospace font. Color scheme: dark-on-light. No external CSS frameworks. Keep it under 500 lines.

### 5. Daily Summary Email

**Trigger**: `node-cron` schedule `0 7 * * *` (7:00 AM daily, timezone configurable via `EMAIL_TIMEZONE` env var)

**Generation**: Use `claude-sonnet-4-6` to write a 3–4 paragraph plain-English summary of the day's support activity. Pass it the following stats as context:

- Total conversations by channel (chat / call / sms)
- Conversations by status (open / resolved / pending) at end of day
- Top 3 clusters by volume with conversation counts
- Any cluster that spiked (grew by 5+ conversations in under 2 hours) — flag as "incident"
- Average first response time (compute from `received_at` of first message vs. first agent reply timestamp)
- CSAT score if available from Chatwoot Reports API

**Email format**: HTML email with inline styles. Structure:

```
Subject: OmniCommerce Support Daily Digest — {Day, Month Date}

[Claude-generated narrative paragraph — what happened today, notable patterns]

--- KEY METRICS ---
Total conversations: X  |  Resolved: X  |  Open: X  |  Pending: X
Avg first response: Xm  |  CSAT: X%

--- TOP ISSUES TODAY ---
1. {cluster label} — X conversations  [{severity}]
2. {cluster label} — X conversations  [{severity}]
3. {cluster label} — X conversations  [{severity}]

[Claude-generated 1-2 sentence recommendation or heads-up for the day ahead]

[Link to live dashboard]
```

### 6. Weekly Trend Analysis Email

**Trigger**: `node-cron` schedule `0 8 * * 1` (8:00 AM every Monday)

**Generation**: Use `claude-sonnet-4-6` with the full week's aggregated data. The model should produce a proper trend analysis, not just a summary. Pass it:

- Day-by-day conversation volume for the past 7 days (for each channel)
- Cluster trajectory: which clusters grew week-over-week, which resolved, which are new
- Top recurring issues (clusters that appeared 3+ days in the week)
- Busiest day and hour of the week
- Resolution rate trend (was it improving or declining?)
- Agent workload distribution (if data available)

**Prompt the model explicitly** to identify: (1) a primary trend, (2) an emerging issue to watch, (3) a positive signal, and (4) one operational recommendation.

**Email format**: HTML email, richer layout than the daily. Sections:

```
Subject: OmniCommerce Support Weekly Trends — Week of {Month Date}

[Executive summary paragraph from Claude — 4–6 sentences]

--- THIS WEEK VS LAST WEEK ---
Total volume: X (+/-X%)  |  Avg response time: Xm (+/-Xm)  |  Resolution rate: X% (+/-X%)

--- TREND ANALYSIS ---
[Claude-generated section: primary trend observed]
[Claude-generated section: emerging issue to watch]
[Claude-generated section: positive signal]

--- CLUSTER BREAKDOWN ---
[Table: cluster name | this week | last week | trend arrow]

--- OPERATIONAL RECOMMENDATION ---
[Claude-generated 2–3 sentence recommendation]

[Link to live dashboard]
```

---

## Environment Variables (`.env.example`)

```bash
# Chatwoot
CHATWOOT_API_TOKEN=
CHATWOOT_ACCOUNT_ID=
CHATWOOT_BASE_URL=https://app.chatwoot.com

# OpenPhone
OPENPHONE_WEBHOOK_SECRET=

# Anthropic
ANTHROPIC_API_KEY=

# PostgreSQL
DATABASE_URL=postgresql://user:password@localhost:5432/omnicommerce_support

# Email
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=
EMAIL_FROM=support-alerts@omnicommerce.com
EMAIL_RECIPIENTS=grady@omnicommerce.com,team@omnicommerce.com
EMAIL_TIMEZONE=America/Phoenix

# App
PORT=3000
NODE_ENV=development
CLUSTERING_THRESHOLD=0.82
```

---

## Implementation Notes for Claude Code

1. Start by creating the project scaffold and `package.json`, then the DB schema and client, then webhooks, then clustering engine, then email jobs, then dashboard UI last.

2. The Anthropic API does not have a native embeddings endpoint — use the Messages API with `claude-haiku-4-5-20251001` and prompt it: `"Return ONLY a JSON array of 1536 floats that semantically represents this support message. No explanation, no markdown. Message: {content}"`. Parse the response directly.

3. For the WebSocket broadcast, keep a `Set<WebSocket>` of connected clients and broadcast updated cluster state as JSON on every clustering event.

4. Nodemailer + SendGrid SMTP is the simplest production-ready email path. The SMTP credentials from SendGrid work without any SDK dependency.

5. When writing label slugs back to Chatwoot, lowercase the cluster label, replace spaces with dashes, and truncate to 32 characters (Chatwoot label slug limit).

6. For the daily and weekly emails, build the data aggregation queries in raw SQL (not an ORM) for clarity and performance. Pass the result set as a structured JSON block in the Claude prompt context.

7. Include a `GET /health` endpoint that returns DB connection status, last webhook received timestamp, and clustering engine status.

8. Write a `README.md` that covers: local setup, required Postgres setup (`pgvector` install instructions), how to register webhooks in Chatwoot and OpenPhone, and how to test the email jobs manually via a `POST /test/daily-email` and `POST /test/weekly-email` endpoint (dev-only).
