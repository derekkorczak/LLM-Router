import type { Logger } from 'pino';
import type { RouteEntry } from './catalog.js';

function parseSSEResponse(raw: string): any {
  const lines = raw.split('\n');
  let lastData: any = null;
  // Accumulate tool_calls and arguments across chunks — tool call args can be
  // split across multiple SSE chunks and the final chunk often has
  // delta.tool_calls=null with only finish_reason set.
  const accumulatedToolCalls: Map<number, any> = new Map();

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const json = line.slice(6).trim();
      if (json === '[DONE]') continue;
      try {
        lastData = JSON.parse(json);
        const choice = lastData?.choices?.[0];
        if (!choice) continue;
        const deltaTCs = choice.delta?.tool_calls;
        if (deltaTCs == null) continue;
        // Null means this chunk has no tool_calls delta — skip
        // (the final chunk often carries only finish_reason)
        for (const tc of deltaTCs) {
          const idx = tc.index;
          const existing = accumulatedToolCalls.get(idx);
          if (!existing) {
            accumulatedToolCalls.set(idx, { ...tc });
          } else {
            // Merge: accumulate arguments string
            if (tc.function?.arguments != null) {
              existing.function = existing.function || {};
              existing.function.arguments =
                (existing.function.arguments || '') + tc.function.arguments;
            }
            // Other fields (id, name) from later chunks win
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.function.name = tc.function.name;
          }
        }
      } catch {
        // skip unparseable chunks
      }
    }
  }

  // Attach accumulated tool_calls to the final message so extractToolCalls finds them
  if (lastData?.choices?.[0]?.message && accumulatedToolCalls.size > 0) {
    const tcs = Array.from(accumulatedToolCalls.values()).sort(
      (a, b) => a.index - b.index,
    );
    lastData.choices[0].message.tool_calls = tcs;
  }

  return lastData || {};
}

function extractContent(data: any): string {
  const choice = data.choices?.[0];
  if (!choice) return '';

  if (choice.message?.content != null) return choice.message.content;
  if (choice.delta?.content != null) return choice.delta.content;

  return '';
}

function extractToolCalls(data: any): any[] | undefined {
  const choice = data.choices?.[0];
  if (!choice) return undefined;

  if (choice.message?.tool_calls != null) return choice.message.tool_calls;
  if (choice.delta?.tool_calls != null) return choice.delta.tool_calls;

  return undefined;
}

export interface ExecutionResult {
  model: string;
  vendor: string;
  tier: string;
  output: string;
  toolCalls: any[] | undefined;
  finishReason: string;
  streamingResponse: string | null;
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
    public skipCandidate: boolean = false,
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
        this.isRetryable(res.status, errorBody),
        this.isSkipCandidate(res.status, errorBody),
        this.shouldStripParams(res.status, errorBody),
      );
    }

    const contentType = res.headers.get('content-type') || '';
    const rawText = await res.text();

    let data: any;

    if (contentType.includes('text/event-stream') || rawText.trimStart().startsWith('data:')) {
      data = parseSSEResponse(rawText);
      return {
        model: data.model || candidate.model,
        vendor: candidate.vendor,
        tier: candidate.tier,
        output: extractContent(data),
        toolCalls: extractToolCalls(data),
        finishReason: data.choices?.[0]?.finish_reason ?? 'stop',
        streamingResponse: rawText,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
          totalTokens: data.usage?.total_tokens ?? 0,
          cost: data.usage?.cost ?? null,
        },
      };
    }

    data = JSON.parse(rawText);

    return {
      model: data.model || candidate.model,
      vendor: candidate.vendor,
      tier: candidate.tier,
      output: extractContent(data),
      toolCalls: extractToolCalls(data),
      finishReason: data.choices?.[0]?.finish_reason ?? 'stop',
      streamingResponse: null,
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
      if (lower.includes('tool_call') || lower.includes('parameter')) return true;
    }
    if (status === 401 || status === 403) return false;
    return false;
  }

  private isSkipCandidate(status: number, body: string): boolean {
    if (status !== 400) return false;
    const lower = body.toLowerCase();
    // Hard model-incapability errors — retry the next candidate, not this one.
    return lower.includes('only') && (
      lower.includes('tool_call') ||
      lower.includes('capability') ||
      lower.includes('feature')
    );
  }

  private shouldStripParams(status: number, body: string): boolean {
    if (status !== 400) return false;
    const lower = body.toLowerCase();
    return lower.includes('temperature') || lower.includes('top_p');
  }
}
