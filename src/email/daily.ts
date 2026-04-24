import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { query } from '../db/client';
import { sendEmail } from './sender';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

interface DailyStats {
  byChannel: { chat: number; call: number; sms: number };
  byStatus: { open: number; resolved: number; pending: number };
  topClusters: { label: string; count: number; severity: string }[];
  incidents: { label: string; count: number; windowMinutes: number }[];
  avgFirstResponseMinutes: number;
}

async function gatherDailyStats(): Promise<DailyStats> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);

  // Channel breakdown
  const channelRows = await query<{ channel: string; cnt: string }>(
    `SELECT channel, COUNT(*) AS cnt FROM support_events
     WHERE received_at >= $1 GROUP BY channel`,
    [since]
  );
  const byChannel = { chat: 0, call: 0, sms: 0 };
  for (const r of channelRows) {
    if (r.channel in byChannel) byChannel[r.channel as keyof typeof byChannel] = parseInt(r.cnt, 10);
  }

  // Status breakdown
  const statusRows = await query<{ status: string; cnt: string }>(
    `SELECT status, COUNT(*) AS cnt FROM support_events
     WHERE received_at >= $1 GROUP BY status`,
    [since]
  );
  const byStatus = { open: 0, resolved: 0, pending: 0 };
  for (const r of statusRows) {
    if (r.status in byStatus) byStatus[r.status as keyof typeof byStatus] = parseInt(r.cnt, 10);
  }

  // Top 3 clusters by volume today
  const clusterRows = await query<{ label: string; cnt: string; severity: string }>(
    `SELECT c.label, COUNT(e.id) AS cnt, c.severity
     FROM clusters c
     JOIN support_events e ON e.cluster_id = c.id
     WHERE e.received_at >= $1
     GROUP BY c.id, c.label, c.severity
     ORDER BY cnt DESC LIMIT 3`,
    [since]
  );
  const topClusters = clusterRows.map((r) => ({
    label: r.label,
    count: parseInt(r.cnt, 10),
    severity: r.severity ?? 'low',
  }));

  // Spike detection: clusters that grew by 5+ conversations within any 2-hour window today
  const spikeRows = await query<{ label: string; cnt: string }>(
    `SELECT c.label, COUNT(e.id) AS cnt
     FROM support_events e
     JOIN clusters c ON c.id = e.cluster_id
     WHERE e.received_at >= NOW() - INTERVAL '2 hours'
     GROUP BY c.id, c.label
     HAVING COUNT(e.id) >= 5`,
    []
  );
  const incidents = spikeRows.map((r) => ({
    label: r.label,
    count: parseInt(r.cnt, 10),
    windowMinutes: 120,
  }));

  return {
    byChannel,
    byStatus,
    topClusters,
    incidents,
    avgFirstResponseMinutes: 0, // Requires agent reply timestamps; placeholder
  };
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

export async function sendDailySummary(): Promise<void> {
  console.log('Generating daily summary email...');
  const stats = await gatherDailyStats();
  const today = new Date();

  const statsJson = JSON.stringify(stats, null, 2);

  const narrativeResp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system:
      'You are a customer support analytics writer for OmniCommerce Technologies. Write clear, professional plain-English summaries based on support data. Be concise and actionable.',
    messages: [
      {
        role: 'user',
        content: `Write a 3-4 paragraph summary of today's customer support activity based on this data:

${statsJson}

Then on a new line write exactly: ---RECOMMENDATION---
Then write a 1-2 sentence recommendation or heads-up for the day ahead.`,
      },
    ],
  });

  const fullText =
    narrativeResp.content[0].type === 'text' ? narrativeResp.content[0].text : '';
  const [narrative, recommendation] = fullText.split('---RECOMMENDATION---');

  const total = stats.byStatus.open + stats.byStatus.resolved + stats.byStatus.pending;
  const topIssuesHtml = stats.topClusters
    .map(
      (c, i) =>
        `<tr><td style="padding:4px 8px">${i + 1}. ${c.label}</td><td style="padding:4px 8px">${c.count} conversations</td><td style="padding:4px 8px"><span style="padding:2px 6px;border-radius:3px;font-size:11px;background:${c.severity === 'high' ? '#fee2e2' : c.severity === 'medium' ? '#fef3c7' : '#dcfce7'};color:${c.severity === 'high' ? '#991b1b' : c.severity === 'medium' ? '#92400e' : '#166534'}">${c.severity.toUpperCase()}</span></td></tr>`
    )
    .join('');

  const incidentHtml = stats.incidents.length
    ? `<p style="background:#fff3cd;border-left:4px solid #f59e0b;padding:8px 12px;margin:12px 0">
        ⚠️ <strong>Incident Alert:</strong> ${stats.incidents.map((i) => `"${i.label}" spiked to ${i.count} conversations in the last 2 hours`).join('; ')}
       </p>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OmniCommerce Support Digest</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin-top:0;border-bottom:2px solid #e5e7eb;padding-bottom:8px">
    OmniCommerce Support Daily Digest &mdash; ${formatDate(today)}
  </h2>

  <div style="white-space:pre-line;line-height:1.6">${(narrative ?? '').trim()}</div>

  ${incidentHtml}

  <h3 style="margin-top:24px;border-bottom:1px solid #e5e7eb;padding-bottom:4px">Key Metrics</h3>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    <tr style="background:#f9fafb">
      <td style="padding:6px 8px">Total conversations</td><td style="padding:6px 8px"><strong>${total}</strong></td>
      <td style="padding:6px 8px">Resolved</td><td style="padding:6px 8px"><strong>${stats.byStatus.resolved}</strong></td>
    </tr>
    <tr>
      <td style="padding:6px 8px">Open</td><td style="padding:6px 8px"><strong>${stats.byStatus.open}</strong></td>
      <td style="padding:6px 8px">Pending</td><td style="padding:6px 8px"><strong>${stats.byStatus.pending}</strong></td>
    </tr>
    <tr style="background:#f9fafb">
      <td style="padding:6px 8px">Chat</td><td style="padding:6px 8px"><strong>${stats.byChannel.chat}</strong></td>
      <td style="padding:6px 8px">Calls</td><td style="padding:6px 8px"><strong>${stats.byChannel.call}</strong></td>
    </tr>
    <tr>
      <td style="padding:6px 8px">SMS</td><td style="padding:6px 8px"><strong>${stats.byChannel.sms}</strong></td>
      <td style="padding:6px 8px">Avg response</td><td style="padding:6px 8px"><strong>${stats.avgFirstResponseMinutes > 0 ? `${stats.avgFirstResponseMinutes}m` : 'N/A'}</strong></td>
    </tr>
  </table>

  <h3 style="margin-top:24px;border-bottom:1px solid #e5e7eb;padding-bottom:4px">Top Issues Today</h3>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    ${topIssuesHtml || '<tr><td style="padding:4px 8px;color:#6b7280">No clusters yet today</td></tr>'}
  </table>

  ${recommendation ? `<div style="margin-top:20px;padding:12px;background:#f0f9ff;border-left:4px solid #0ea5e9;line-height:1.5"><strong>Recommendation:</strong> ${recommendation.trim()}</div>` : ''}

  <p style="margin-top:24px;font-size:12px;color:#6b7280">
    <a href="${config.dashboardUrl}" style="color:#3b82f6">View Live Dashboard</a>
  </p>
</body>
</html>`;

  await sendEmail({
    subject: `OmniCommerce Support Daily Digest — ${formatDate(today)}`,
    html,
  });
}
