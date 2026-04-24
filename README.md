# OmniCommerce Support Intelligence Dashboard

Real-time customer support monitoring for Chatwoot (chat) and OpenPhone (calls/SMS). Uses Claude AI to cluster similar conversations, serves a live dashboard, and sends daily/weekly email digests.

---

## Prerequisites

- Node.js 20+
- PostgreSQL 14+ with [pgvector](https://github.com/pgvector/pgvector) extension
- Anthropic API key
- Chatwoot account (optional but recommended)
- OpenPhone account (optional)
- SMTP credentials (SendGrid recommended)

---

## Local Setup

### 1. Install dependencies

```bash
cd omnicommerce-support-dashboard
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Set up PostgreSQL with pgvector

**macOS (Homebrew):**
```bash
brew install postgresql@16
brew install pgvector
# Or compile from source:
# git clone https://github.com/pgvector/pgvector.git && cd pgvector && make && make install
```

**Ubuntu/Debian:**
```bash
sudo apt install postgresql-16-pgvector
```

**Create the database:**
```bash
createdb omnicommerce_support
```

### 4. Run the database migration

```bash
npm run db:migrate
```

> **Note:** The `ivfflat` index on `support_events.embedding` requires at least ~100 rows before PostgreSQL will use it efficiently. For an empty database, the index creation will succeed but the planner may not use it until data is present.

### 5. Start the server

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start
```

Dashboard available at: `http://localhost:3000`

---

## Registering Webhooks

### Chatwoot

1. Go to **Settings → Integrations → Webhooks**
2. Click **Add new webhook**
3. URL: `https://your-domain.com/webhooks/chatwoot`
4. Select events: `Conversation Created`, `Message Created`, `Conversation Status Changed`
5. Set `CHATWOOT_API_TOKEN` in `.env` to your account API token (Settings → API Access Token)
6. Set `CHATWOOT_ACCOUNT_ID` to your account ID (visible in the URL: `/app/accounts/{id}/`)

### OpenPhone

1. Go to **Settings → API & Webhooks → Webhooks**
2. Add webhook URL: `https://your-domain.com/webhooks/openphone`
3. Select events: `message.received`, `call.completed`
4. Copy the signing secret → set `OPENPHONE_WEBHOOK_SECRET` in `.env`

---

## Testing Email Jobs Manually

These endpoints are only available when `NODE_ENV !== 'production'`:

```bash
# Trigger daily summary email immediately
curl -X POST http://localhost:3000/test/daily-email

# Trigger weekly trend analysis email immediately
curl -X POST http://localhost:3000/test/weekly-email
```

---

## Health Check

```bash
curl http://localhost:3000/health
```

Returns:
```json
{
  "status": "ok",
  "db": "connected",
  "lastWebhookReceived": "2024-01-15T14:30:00.000Z",
  "clustering": {
    "model": "claude-haiku-4-5-20251001",
    "threshold": 0.82,
    "avgEmbedLatencyMs": 1243,
    "clusteredToday": 47,
    "labelsAppliedToday": 44
  }
}
```

---

## Architecture Notes

### Embedding approach
The Anthropic API does not have a native embeddings endpoint. This project prompts `claude-haiku-4-5-20251001` to return a JSON array of 1536 floats representing the semantic content of each support message. This is functional but:
- **Slow**: ~1–2 seconds per message
- **Expensive**: consumes significant token budget
- **Non-deterministic**: embeddings may vary between calls for the same content

For production at high volume, consider replacing this with a dedicated embedding model (e.g. OpenAI `text-embedding-3-small`, Cohere `embed-v3`, or a self-hosted model).

### Clustering
- Cosine similarity against all cluster centroids (full scan)
- Threshold: 0.82 (configurable via `CLUSTERING_THRESHOLD`)
- Centroids updated as rolling averages on each new assignment
- At high cluster counts (1000+), consider switching to ANN search with the ivfflat index

### Email schedule
- Daily digest: 07:00 in `EMAIL_TIMEZONE`
- Weekly trends: 08:00 every Monday in `EMAIL_TIMEZONE`

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `CHATWOOT_API_TOKEN` | Chatwoot account API token | — |
| `CHATWOOT_ACCOUNT_ID` | Chatwoot account ID | — |
| `CHATWOOT_BASE_URL` | Chatwoot base URL | `https://app.chatwoot.com` |
| `OPENPHONE_WEBHOOK_SECRET` | OpenPhone signing secret | — |
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `SMTP_HOST` | SMTP server hostname | `smtp.sendgrid.net` |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_USER` | SMTP username | `apikey` |
| `SMTP_PASS` | SMTP password / API key | — |
| `EMAIL_FROM` | Sender address | `support-alerts@omnicommerce.com` |
| `EMAIL_RECIPIENTS` | Comma-separated recipient list | — |
| `EMAIL_TIMEZONE` | Timezone for email schedule | `America/Phoenix` |
| `PORT` | HTTP server port | `3000` |
| `NODE_ENV` | Environment | `development` |
| `CLUSTERING_THRESHOLD` | Cosine similarity threshold | `0.82` |
| `DASHBOARD_URL` | Public dashboard URL (used in emails) | `http://localhost:3000` |
