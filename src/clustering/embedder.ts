import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../config';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
const openai = new OpenAI({ apiKey: config.openai.apiKey });

// Rolling average embed latency tracker
let totalLatencyMs = 0;
let totalEmbeds = 0;

export function getAvgEmbedLatencyMs(): number {
  return totalEmbeds === 0 ? 0 : Math.round(totalLatencyMs / totalEmbeds);
}

/**
 * Generate a 1536-dimensional embedding using OpenAI text-embedding-3-small.
 */
export async function embedContent(content: string): Promise<number[]> {
  const start = Date.now();

  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: content,
    dimensions: 1536,
  });

  totalLatencyMs += Date.now() - start;
  totalEmbeds++;

  return response.data[0].embedding;
}

/**
 * Ask Claude Haiku to generate a concise 3-5 word cluster label from message content.
 */
export async function generateClusterLabel(content: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32,
    system:
      'You generate concise cluster labels for customer support messages. Return ONLY 3-5 lowercase words that describe the core issue (e.g. "checkout payment failures", "login account access"). No punctuation, no explanation.',
    messages: [
      {
        role: 'user',
        content: `Generate a 3-5 word cluster label for: ${content}`,
      },
    ],
  });

  const label =
    response.content[0].type === 'text'
      ? response.content[0].text.trim().toLowerCase()
      : 'uncategorized support issue';

  return label;
}
