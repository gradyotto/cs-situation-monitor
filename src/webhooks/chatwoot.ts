import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { SupportEvent } from '../types';
import { processEvent } from '../clustering/engine';
import { query, setLastWebhookReceived } from '../db/client';

const router = Router();

function mapStatus(status: string): SupportEvent['status'] {
  if (status === 'resolved') return 'resolved';
  if (status === 'pending') return 'pending';
  return 'open';
}

router.post('/', async (req: Request, res: Response) => {
  const body = req.body;
  const eventType: string = body.event;

  // Only cluster on new conversations (first message). message_created fires for every
  // reply in the thread — we don't re-embed those. conversation_status_changed is
  // acknowledged but triggers no clustering.
  if (!['conversation_created', 'conversation_status_changed'].includes(eventType)) {
    res.status(200).json({ ignored: true });
    return;
  }

  try {
    let event: SupportEvent | null = null;

    if (eventType === 'conversation_created') {
      const firstMessage: string = body.messages?.[0]?.content ?? body.content ?? '';
      if (!firstMessage.trim()) {
        res.status(200).json({ ignored: true });
        return;
      }

      event = {
        id: uuidv4(),
        source: 'chatwoot',
        channel: 'chat',
        externalId: String(body.id ?? ''),
        contactName: body.meta?.sender?.name ?? 'Unknown',
        content: firstMessage,
        status: mapStatus(body.status ?? 'open'),
        receivedAt: new Date(body.created_at ? body.created_at * 1000 : Date.now()),
        clusterId: null,
        clusterLabel: null,
        severity: null,
      };
    } else if (eventType === 'conversation_status_changed') {
      const conversationId = String(body.id ?? '');
      const newStatus = mapStatus(body.status ?? 'open');
      if (conversationId) {
        await query(
          `UPDATE support_events SET status = $1 WHERE external_id = $2 AND source = 'chatwoot'`,
          [newStatus, conversationId]
        );
      }
      setLastWebhookReceived(new Date());
      res.status(200).json({ ok: true });
      return;
    }

    if (!event) {
      res.status(200).json({ ignored: true });
      return;
    }

    setLastWebhookReceived(new Date());
    // Fire-and-forget clustering; respond immediately
    processEvent(event).catch((err) =>
      console.error('Clustering error for chatwoot event:', err)
    );

    res.status(200).json({ ok: true, eventId: event.id });
  } catch (err) {
    console.error('Chatwoot webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
