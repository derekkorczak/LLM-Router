import { RouterConfig } from './RouterConfig.js';
import pino from 'pino';
import { TokenCounter } from './TokenCounter.js';

// Gateway client class
class GatewayClient {
  private config: RouterConfig;
  private logger: pino.Logger;
  private tokenCounter: TokenCounter;
  
  constructor(config: RouterConfig, logger: pino.Logger) {
    this.config = config;
    this.logger = logger;
    this.tokenCounter = new TokenCounter(config);
  }
  
  // Execute a request through Merge
  async execute(candidate: any, body: any, { stream }: { stream: boolean }): Promise<any> {
    const apiKey = process.env.MERGE_API_KEY;
    if (!apiKey) {
      throw new Error('MERGE_API_KEY environment variable is not set.');
    }
    
    const requestBody = {
      model: candidate.model,
      vendor: candidate.vendor,
      service_tier: candidate.tier,
      service_tier_fallback: true,
      include_routing_metadata: true,
      ...body,
    };
    
    const response = await fetch('https://api-gateway.merge.dev/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      this.logger.error(`Merge API error: ${response.status} - ${errorData.message || response.statusText}`);
      throw new Error(`Merge API error: ${response.status} - ${errorData.message || response.statusText}`);
    }
    
    const responseData = await response.json();
    
    if (stream) {
      return this.handleStreamingResponse(responseData);
    }
    
    return responseData;
  }
  
  // Handle streaming response
  private async handleStreamingResponse(responseData: any): Promise<IterableIterator<any>> {
    const chunks: any[] = [];
    
    for await (const chunk of responseData.stream) {
      chunks.push(chunk);
    }
    
    // Parse final chunk for usage
    const finalChunk = chunks[chunks.length - 1];
    const parsedUsage = finalChunk.usage || { cost: null, input_tokens: 0, output_tokens: 0 };
    
    this.logger.info(`Final usage: input=${parsedUsage.input_tokens}, output=${parsedUsage.output_tokens}, cost=${parsedUsage.cost}`);
    
    return chunks;
  }
  
  // Check if a candidate is retryable
  isRetryable(error: Error): boolean {
    const errorCode = error.message.split(': ')[1]?.split(' ')[0];
    return errorCode?.includes('429') || errorCode?.includes('5xx');
  }
}

export { GatewayClient };