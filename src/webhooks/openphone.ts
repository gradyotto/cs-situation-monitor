import { Router, Request, Response } from 'express';
import { createHmac } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { SupportEvent } from '../types';
import { processEvent } from '../clustering/engine';
import { queryOne, setLastWebhookReceived } from '../db/client';

function openphoneSegment(data: Record<string, unknown>): 'customer' | 'driver' {
  const id = (data.phoneNumberId ?? (data.object as Record<string, unknown> | undefined)?.phoneNumberId) as string | undefined;
  return config.openphone.driverNumberId && id === config.openphone.driverNumberId
    ? 'driver'
    : 'customer';
}

const router = Router();

function verifySignature(req: Request): boolean {
  if (!config.openphone.webhookSecret) return true;
  const signature = req.headers['x-openphone-signature'] as string;
  if (!signature) return false;
  const expected = createHmac('sha256', config.openphone.webhookSecret)
    .update(JSON.stringify(req.body))
    .digest('hex');
  return signature === expected;
}

router.post('/', async (req: Request, res: Response) => {
  if (!verifySignature(req)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  const body = req.body;
  const eventType: string = body.type ?? body.event ?? '';

  try {
    let event: SupportEvent | null = null;

    if (eventType === 'call.completed' || eventType === 'call.summary.completed') {
      const data = body.data ?? body;
      const summary: string = data.summary ?? data.object?.summary ?? '';

      if (!summary.trim()) {
        setLastWebhookReceived(new Date());
        res.status(200).json({ ignored: true, reason: 'no_summary' });
        return;
      }

      const externalId = String(data.id ?? data.object?.id ?? uuidv4());
      const existing = await queryOne<{ id: string }>(
        `SELECT id FROM support_events WHERE external_id = $1 AND source = 'openphone' LIMIT 1`,
        [externalId]
      );
      if (existing) {
        res.status(200).json({ ignored: true, reason: 'already_clustered' });
        return;
      }

      const seg = openphoneSegment(data);
      event = {
        id: uuidv4(),
        source: 'openphone',
        channel: 'call',
        externalId,
        contactName: data.from ?? data.object?.from ?? 'Unknown Caller',
        content: summary,
        status: 'resolved',
        receivedAt: new Date(data.completedAt ?? data.object?.completedAt ?? Date.now()),
        clusterId: null,
        clusterLabel: null,
        severity: null,
        inboxName: seg === 'driver' ? 'Driver Phone' : 'Phone',
        labels: [],
        segment: seg,
      };
    } else if (eventType === 'message.received') {
      const data = body.data ?? body;
      const msgBody: string = data.body ?? data.object?.body ?? '';
      if (!msgBody.trim()) {
        res.status(200).json({ ignored: true });
        return;
      }

      const externalId = String(data.id ?? data.object?.id ?? uuidv4());
      const existing = await queryOne<{ id: string }>(
        `SELECT id FROM support_events WHERE external_id = $1 AND source = 'openphone' LIMIT 1`,
        [externalId]
      );
      if (existing) {
        res.status(200).json({ ignored: true, reason: 'already_clustered' });
        return;
      }

      const seg = openphoneSegment(data);
      event = {
        id: uuidv4(),
        source: 'openphone',
        channel: 'sms',
        externalId,
        contactName: data.from ?? data.object?.from ?? 'Unknown',
        content: msgBody,
        status: 'open',
        receivedAt: new Date(data.receivedAt ?? data.object?.receivedAt ?? Date.now()),
        clusterId: null,
        clusterLabel: null,
        severity: null,
        inboxName: seg === 'driver' ? 'Driver Phone' : 'Phone',
        labels: [],
        segment: seg,
      };
    } else {
      res.status(200).json({ ignored: true });
      return;
    }

    if (!event) {
      res.status(200).json({ ignored: true });
      return;
    }

    setLastWebhookReceived(new Date());
    processEvent(event).catch((err) =>
      console.error('Clustering error for openphone event:', err)
    );

    res.status(200).json({ ok: true, eventId: event.id });
  } catch (err) {
    console.error('OpenPhone webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
