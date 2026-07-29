import type { Logger } from 'pino';
import type { RouteEntry } from './catalog.js';

function parseSSEResponse(raw: string): any {
  const lines = raw.split('\n');
  let lastData: any = null;

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const json = line.slice(6).trim();
      if (json === '[DONE]') continue;
      try {
        lastData = JSON.parse(json);
      } catch {
        // skip unparseable chunks
      }
    }
  }

  return lastData || {};
}

export interface ExecutionResult {
  model: string;
  vendor: string;
  tier: string;
  output: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number | null;
  };
}

export class GatewayError extends Error {
  constructor(
    message: string,
    public statusCode: number | null,
    public retryable: boolean,
    public stripParams: boolean = false,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export class GatewayClient {
  private apiKey: string;
  private logger: Logger;

  constructor(apiKey: string, logger: Logger) {
    this.apiKey = apiKey;
    this.logger = logger;
  }

  async execute(
    candidate: RouteEntry,
    body: any,
    options: { stripSampling?: boolean } = {},
  ): Promise<ExecutionResult> {
    const requestBody: any = {
      ...body,
      model: candidate.model,
      service_tier: candidate.tier,
      service_tier_fallback: true,
      include_routing_metadata: true,
    };

    if (candidate.vendor) {
      requestBody.vendors = [candidate.vendor];
    }

    if (options.stripSampling) {
      delete requestBody.temperature;
      delete requestBody.top_p;
    }

    if (requestBody.stream !== true) {
      requestBody.stream = false;
    }

    const url = 'https://api-gateway.merge.dev/v1/openai/chat/completions';

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      const retryable = this.isRetryable(res.status, errorBody);
      const stripParams = this.shouldStripParams(res.status, errorBody);

      throw new GatewayError(
        `Merge API ${res.status}: ${errorBody.slice(0, 200)}`,
        res.status,
        retryable,
        stripParams,
      );
    }

    const contentType = res.headers.get('content-type') || '';
    const rawText = await res.text();

    let data: any;

    if (contentType.includes('text/event-stream') || rawText.trimStart().startsWith('data:')) {
      data = parseSSEResponse(rawText);
    } else {
      data = JSON.parse(rawText);
    }

    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? '';

    return {
      model: data.model || candidate.model,
      vendor: candidate.vendor,
      tier: candidate.tier,
      output: content,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
        cost: data.usage?.cost ?? null,
      },
    };
  }

  private isRetryable(status: number, body: string): boolean {
    if (status === 429) return true;
    if (status >= 500) return true;
    if (status === 400) {
      const lower = body.toLowerCase();
      if (lower.includes('temperature') || lower.includes('top_p')) return true;
      if (lower.includes('unsupported') || lower.includes('not supported')) return true;
      if (lower.includes('capability') || lower.includes('feature')) return true;
    }
    if (status === 401 || status === 403) return false;
    return false;
  }

  private shouldStripParams(status: number, body: string): boolean {
    if (status !== 400) return false;
    const lower = body.toLowerCase();
    return lower.includes('temperature') || lower.includes('top_p');
  }
}
