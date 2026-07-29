import { get_encoding, type TiktokenEncoding } from 'tiktoken';
import type { Config, Profile } from './config.js';

let encoder: ReturnType<typeof get_encoding> | null = null;

function getEncoder() {
  if (!encoder) {
    try {
      encoder = get_encoding('o200k_base' as TiktokenEncoding);
    } catch {
      encoder = get_encoding('cl100k_base' as TiktokenEncoding);
    }
  }
  return encoder;
}

interface ChatMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string; image_url?: unknown; source?: unknown }>;
  tool_calls?: unknown[];
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
}

const MESSAGE_FRAMING_TOKENS = 4;

export function estimatePromptTokens(
  body: ChatRequest,
  config: Config,
): number {
  let total = 0;
  const enc = getEncoder();

  for (const msg of body.messages) {
    total += MESSAGE_FRAMING_TOKENS;

    if (typeof msg.content === 'string') {
      total += enc.encode(msg.content).length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) {
          total += enc.encode(part.text).length;
        } else if (part.type === 'image_url') {
          total += config.imageTokenAllowance;
        } else if (part.type === 'file' || part.type === 'document') {
          const source = part.source as { data?: string } | undefined;
          if (source?.data) {
            const byteLength = Math.ceil(Buffer.from(source.data, 'base64').length);
            total += Math.max(config.documentTokenAllowance, Math.ceil(byteLength / 4));
          } else {
            total += config.documentTokenAllowance;
          }
        }
      }
    }

    if (msg.tool_calls) {
      total += enc.encode(JSON.stringify(msg.tool_calls)).length;
    }
  }

  if (body.tools && body.tools.length > 0) {
    total += enc.encode(JSON.stringify(body.tools)).length;
  }

  return Math.ceil(total * (1 + config.tokenSafetyMargin));
}

export function computeOutputBounds(
  body: ChatRequest,
  profile: Profile,
): { ceiling: number; expected: number } {
  const maxTokens = body.max_tokens;
  const expectedDefault = profile.expectedOutputTokens;

  const ceiling = maxTokens ?? expectedDefault;
  const expected = maxTokens != null ? Math.min(maxTokens, expectedDefault) : expectedDefault;

  return { ceiling, expected };
}
