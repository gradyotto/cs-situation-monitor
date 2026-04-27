import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { SupportEvent } from '../types';
import { processEvent } from '../clustering/engine';
import { query, queryOne, setLastWebhookReceived } from '../db/client';

const router = Router();

function mapStatus(status: string): SupportEvent['status'] {
  if (status === 'resolved') return 'resolved';
  if (status === 'pending') return 'pending';
  return 'open';
}

/** Map Chatwoot's internal channel class names to friendly display names */
function friendlyInboxName(
  inboxName: string | undefined,
  channelType: string | undefined
): string {
  if (inboxName?.trim()) return inboxName.trim();
  const type = channelType ?? '';
  if (type.includes('WebWidget')) return 'Web Chat';
  if (type.includes('Instagram')) return 'Instagram';
  if (type.includes('Whatsapp')) return 'WhatsApp';
  if (type.includes('Twitter')) return 'Twitter';
  if (type.includes('Email')) return 'Email';
  if (type.includes('Sms')) return 'SMS';
  if (type.includes('Api')) return 'API';
  if (type.includes('Facebook')) return 'Facebook';
  if (type.includes('Telegram')) return 'Telegram';
  return 'Chat';
}

router.post('/', async (req: Request, res: Response) => {
  const body = req.body;
  const eventType: string = body.event;

  if (!['message_created', 'conversation_status_changed'].includes(eventType)) {
    res.status(200).json({ ignored: true });
    return;
  }

  try {
    if (eventType === 'message_created') {
      const messageType = body.message_type;
      const isIncoming = messageType === 0 || messageType === '0' || messageType === 'incoming';

      console.log(`[chatwoot] message_created — type: ${JSON.stringify(messageType)}, private: ${body.private}, content: ${String(body.content ?? '').slice(0, 60)}`);

      // Only process incoming customer messages, not agent replies or activity
      if (!isIncoming || body.private === true) {
        res.status(200).json({ ignored: true, reason: `message_type=${messageType}` });
        return;
      }

      const content: string = body.content ?? '';
      if (!content.trim()) {
        res.status(200).json({ ignored: true, reason: 'empty_content' });
        return;
      }

      const conversationId = String(body.conversation?.id ?? '');
      if (!conversationId) {
        res.status(200).json({ ignored: true, reason: 'no_conversation_id' });
        return;
      }

      // Only cluster the first customer message per conversation
      const existing = await queryOne<{ id: string }>(
        `SELECT id FROM support_events WHERE external_id = $1 AND source = 'chatwoot' LIMIT 1`,
        [conversationId]
      );
      if (existing) {
        res.status(200).json({ ignored: true, reason: 'already_clustered' });
        return;
      }

      const inboxName = friendlyInboxName(
        body.inbox?.name,
        body.conversation?.meta?.channel
      );

      const event: SupportEvent = {
        id: uuidv4(),
        source: 'chatwoot',
        channel: 'chat',
        externalId: conversationId,
        contactName: body.conversation?.meta?.sender?.name ?? body.sender?.name ?? 'Unknown',
        content,
        status: mapStatus(body.conversation?.status ?? 'open'),
        receivedAt: new Date(Number.isFinite(Number(body.created_at)) ? Number(body.created_at) * 1000 : Date.now()),
        clusterId: null,
        clusterLabel: null,
        severity: null,
        inboxName,
      };

      setLastWebhookReceived(new Date());
      processEvent(event).catch((err) =>
        console.error('Clustering error for chatwoot event:', err)
      );

      res.status(200).json({ ok: true, eventId: event.id });
      return;
    }

    if (eventType === 'conversation_status_changed') {
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

    res.status(200).json({ ignored: true });
  } catch (err) {
    console.error('Chatwoot webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
