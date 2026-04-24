import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { query } from '../db/client';
import { sendEmail } from './sender';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

interface WeeklyStats {
  dailyVolume: { date: string; chat: number; call: number; sms: number; total: number }[];
  clusterTrajectory: { label: string; thisWeek: number; lastWeek: number; daysActive: number }[];
  busiest: { day: string; hour: number };
  resolutionRateThisWeek: number;
  resolutionRateLastWeek: number;
  totalThisWeek: number;
  totalLastWeek: number;
}

async function gatherWeeklyStats(): Promise<WeeklyStats> {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);
  weekStart.setHours(0, 0, 0, 0);
  const twoWeeksStart = new Date(now);
  twoWeeksStart.setDate(now.getDate() - 14);
  twoWeeksStart.setHours(0, 0, 0, 0);

  // Day-by-day volume for the past 7 days
  const dailyRows = await query<{ day: string; channel: string; cnt: string }>(
    `SELECT DATE(received_at AT TIME ZONE $1)::text AS day, channel, COUNT(*) AS cnt
     FROM support_events
     WHERE received_at >= $2
     GROUP BY day, channel
     ORDER BY day`,
    [config.email.timezone, weekStart]
  );

  const dayMap = new Map<string, { chat: number; call: number; sms: number }>();
  for (const r of dailyRows) {
    if (!dayMap.has(r.day)) dayMap.set(r.day, { chat: 0, call: 0, sms: 0 });
    const d = dayMap.get(r.day)!;
    if (r.channel === 'chat') d.chat += parseInt(r.cnt, 10);
    else if (r.channel === 'call') d.call += parseInt(r.cnt, 10);
    else if (r.channel === 'sms') d.sms += parseInt(r.cnt, 10);
  }
  const dailyVolume = Array.from(dayMap.entries()).map(([date, v]) => ({
    date,
    ...v,
    total: v.chat + v.call + v.sms,
  }));

  // This week vs last week totals
  const thisWeekRows = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM support_events WHERE received_at >= $1`,
    [weekStart]
  );
  const lastWeekRows = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM support_events WHERE received_at >= $1 AND received_at < $2`,
    [twoWeeksStart, weekStart]
  );
  const totalThisWeek = parseInt(thisWeekRows[0]?.cnt ?? '0', 10);
  const totalLastWeek = parseInt(lastWeekRows[0]?.cnt ?? '0', 10);

  // Cluster trajectory: this week vs last week
  const clusterRows = await query<{
    label: string; this_week: string; last_week: string; days_active: string;
  }>(
    `SELECT
       c.label,
       COUNT(CASE WHEN e.received_at >= $1 THEN 1 END) AS this_week,
       COUNT(CASE WHEN e.received_at >= $2 AND e.received_at < $1 THEN 1 END) AS last_week,
       COUNT(DISTINCT DATE(e.received_at)) AS days_active
     FROM clusters c
     JOIN support_events e ON e.cluster_id = c.id
     WHERE e.received_at >= $2
     GROUP BY c.id, c.label
     ORDER BY this_week DESC
     LIMIT 15`,
    [weekStart, twoWeeksStart]
  );
  const clusterTrajectory = clusterRows.map((r) => ({
    label: r.label,
    thisWeek: parseInt(r.this_week, 10),
    lastWeek: parseInt(r.last_week, 10),
    daysActive: parseInt(r.days_active, 10),
  }));

  // Busiest day/hour
  const busiestRows = await query<{ day: string; hour: string; cnt: string }>(
    `SELECT
       TO_CHAR(received_at AT TIME ZONE $1, 'Day') AS day,
       EXTRACT(HOUR FROM received_at AT TIME ZONE $1)::text AS hour,
       COUNT(*) AS cnt
     FROM support_events WHERE received_at >= $2
     GROUP BY day, hour ORDER BY cnt DESC LIMIT 1`,
    [config.email.timezone, weekStart]
  );
  const busiest = {
    day: busiestRows[0]?.day?.trim() ?? 'N/A',
    hour: parseInt(busiestRows[0]?.hour ?? '0', 10),
  };

  // Resolution rates
  const resThisWeek = await query<{ total: string; resolved: string }>(
    `SELECT COUNT(*) AS total, COUNT(CASE WHEN status='resolved' THEN 1 END) AS resolved
     FROM support_events WHERE received_at >= $1`,
    [weekStart]
  );
  const resLastWeek = await query<{ total: string; resolved: string }>(
    `SELECT COUNT(*) AS total, COUNT(CASE WHEN status='resolved' THEN 1 END) AS resolved
     FROM support_events WHERE received_at >= $1 AND received_at < $2`,
    [twoWeeksStart, weekStart]
  );
  const calcRate = (r: { total: string; resolved: string }[]): number => {
    const t = parseInt(r[0]?.total ?? '0', 10);
    const res = parseInt(r[0]?.resolved ?? '0', 10);
    return t === 0 ? 0 : Math.round((res / t) * 100);
  };

  return {
    dailyVolume,
    clusterTrajectory,
    busiest,
    resolutionRateThisWeek: calcRate(resThisWeek),
    resolutionRateLastWeek: calcRate(resLastWeek),
    totalThisWeek,
    totalLastWeek,
  };
}

function pct(a: number, b: number): string {
  if (b === 0) return '+0%';
  const diff = Math.round(((a - b) / b) * 100);
  return diff >= 0 ? `+${diff}%` : `${diff}%`;
}

function trendArrow(thisWeek: number, lastWeek: number): string {
  if (thisWeek > lastWeek) return '↑';
  if (thisWeek < lastWeek) return '↓';
  return '→';
}

export async function sendWeeklySummary(): Promise<void> {
  console.log('Generating weekly trend analysis email...');
  const stats = await gatherWeeklyStats();
  const today = new Date();
  const weekOf = new Date(today);
  weekOf.setDate(today.getDate() - 7);

  const statsJson = JSON.stringify(stats, null, 2);

  const analysisResp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system:
      'You are a customer support analytics expert for OmniCommerce Technologies. Write a structured weekly trend analysis based on support data. Be specific, data-driven, and actionable.',
    messages: [
      {
        role: 'user',
        content: `Analyze this week's customer support data and write:

1. An executive summary paragraph (4-6 sentences)
2. Then exactly: ---PRIMARY_TREND---
3. A paragraph on the primary trend observed
4. Then exactly: ---EMERGING_ISSUE---
5. A paragraph on an emerging issue to watch
6. Then exactly: ---POSITIVE_SIGNAL---
7. A paragraph on a positive signal
8. Then exactly: ---RECOMMENDATION---
9. A 2-3 sentence operational recommendation

Data:
${statsJson}`,
      },
    ],
  });

  const fullText =
    analysisResp.content[0].type === 'text' ? analysisResp.content[0].text : '';

  const [execSummary, rest1 = ''] = fullText.split('---PRIMARY_TREND---');
  const [primaryTrend, rest2 = ''] = rest1.split('---EMERGING_ISSUE---');
  const [emergingIssue, rest3 = ''] = rest2.split('---POSITIVE_SIGNAL---');
  const [positiveSignal, recommendation = ''] = rest3.split('---RECOMMENDATION---');

  const volumeChange = pct(stats.totalThisWeek, stats.totalLastWeek);
  const resChange = pct(stats.resolutionRateThisWeek, stats.resolutionRateLastWeek);

  const clusterTableRows = stats.clusterTrajectory
    .map(
      (c) =>
        `<tr>
          <td style="padding:4px 8px">${c.label}</td>
          <td style="padding:4px 8px;text-align:center">${c.thisWeek}</td>
          <td style="padding:4px 8px;text-align:center">${c.lastWeek}</td>
          <td style="padding:4px 8px;text-align:center;font-size:16px">${trendArrow(c.thisWeek, c.lastWeek)}</td>
        </tr>`
    )
    .join('');

  const weekLabel = weekOf.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OmniCommerce Weekly Trends</title></head>
<body style="font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin-top:0;border-bottom:2px solid #e5e7eb;padding-bottom:8px">
    OmniCommerce Support Weekly Trends &mdash; Week of ${weekLabel}
  </h2>

  <div style="white-space:pre-line;line-height:1.7;margin-bottom:20px">${(execSummary ?? '').trim()}</div>

  <h3 style="border-bottom:1px solid #e5e7eb;padding-bottom:4px">This Week vs Last Week</h3>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    <tr style="background:#f9fafb">
      <td style="padding:6px 8px">Total volume</td>
      <td style="padding:6px 8px"><strong>${stats.totalThisWeek}</strong> <span style="color:#6b7280;font-size:12px">(${volumeChange})</span></td>
      <td style="padding:6px 8px">Resolution rate</td>
      <td style="padding:6px 8px"><strong>${stats.resolutionRateThisWeek}%</strong> <span style="color:#6b7280;font-size:12px">(${resChange})</span></td>
    </tr>
    <tr>
      <td style="padding:6px 8px">Busiest day</td>
      <td style="padding:6px 8px"><strong>${stats.busiest.day}</strong></td>
      <td style="padding:6px 8px">Peak hour</td>
      <td style="padding:6px 8px"><strong>${stats.busiest.hour}:00</strong></td>
    </tr>
  </table>

  <h3 style="margin-top:24px;border-bottom:1px solid #e5e7eb;padding-bottom:4px">Trend Analysis</h3>

  <div style="margin:12px 0;padding:12px;background:#f0f9ff;border-left:4px solid #3b82f6">
    <strong>Primary Trend</strong><br>
    <div style="margin-top:6px;line-height:1.6">${(primaryTrend ?? '').trim()}</div>
  </div>

  <div style="margin:12px 0;padding:12px;background:#fef3c7;border-left:4px solid #f59e0b">
    <strong>Emerging Issue to Watch</strong><br>
    <div style="margin-top:6px;line-height:1.6">${(emergingIssue ?? '').trim()}</div>
  </div>

  <div style="margin:12px 0;padding:12px;background:#f0fdf4;border-left:4px solid #22c55e">
    <strong>Positive Signal</strong><br>
    <div style="margin-top:6px;line-height:1.6">${(positiveSignal ?? '').trim()}</div>
  </div>

  <h3 style="margin-top:24px;border-bottom:1px solid #e5e7eb;padding-bottom:4px">Cluster Breakdown</h3>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    <thead>
      <tr style="background:#f9fafb;font-weight:600">
        <th style="padding:6px 8px;text-align:left">Cluster</th>
        <th style="padding:6px 8px;text-align:center">This Week</th>
        <th style="padding:6px 8px;text-align:center">Last Week</th>
        <th style="padding:6px 8px;text-align:center">Trend</th>
      </tr>
    </thead>
    <tbody>
      ${clusterTableRows || '<tr><td colspan="4" style="padding:8px;color:#6b7280">No clusters this week</td></tr>'}
    </tbody>
  </table>

  <h3 style="margin-top:24px;border-bottom:1px solid #e5e7eb;padding-bottom:4px">Operational Recommendation</h3>
  <div style="padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;line-height:1.6">
    ${(recommendation ?? '').trim()}
  </div>

  <p style="margin-top:24px;font-size:12px;color:#6b7280">
    <a href="${config.dashboardUrl}" style="color:#3b82f6">View Live Dashboard</a>
  </p>
</body>
</html>`;

  await sendEmail({
    subject: `OmniCommerce Support Weekly Trends — Week of ${weekLabel}`,
    html,
  });
}
