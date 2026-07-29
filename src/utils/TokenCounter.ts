import tiktoken from 'tiktoken';
import { RouterConfig } from './RouterConfig.js';

// Initialize tiktoken encoder
const encoding = tiktoken.get_encoding('o200k_base');

// Token counting class
class TokenCounter {
  private config: RouterConfig;
  
  constructor(config: RouterConfig) {
    this.config = config;
  }
  
  // Estimate prompt tokens
  estimatePromptTokens(body: any): number {
    let totalTokens = 0;
    
    // Encode text content
    const textContent = this.extractTextContent(body);
    totalTokens += encoding.encode(textContent).length;
    
    // Add fixed overhead for framing
    totalTokens += 10; // Approximate framing overhead
    
    // Add tool schemas if present
    if (body.tools) {
      totalTokens += encoding.encode(JSON.stringify(body.tools)).length;
    }
    
    // Add image/document allowances
    if (body.image_url || body.image) {
      totalTokens += this.config.imageTokenAllowance;
    }
    
    if (body.document || body.documents) {
      totalTokens += this.config.documentTokenAllowance;
    }
    
    // Apply safety margin
    return Math.ceil(totalTokens * (1 + this.config.tokenSafetyMargin));
  }
  
  // Extract text content from the request body
  private extractTextContent(body: any): string {
    let content = '';
    
    // Handle role/message framing
    if (body.choices && body.choices[0]?.message) {
      content += body.choices[0].message.content;
    } else if (body.input) {
      content += body.input;
    }
    
    // Handle tool usage
    if (body.tools) {
      content += JSON.stringify(body.tools);
    }
    
    return content;
  }
  
  // Estimate output tokens (split logic)
  estimateOutputTokens(body: any, expectedOutputTokens: number): number {
    const maxTokens = body.max_tokens || expectedOutputTokens;
    return Math.min(maxTokens, expectedOutputTokens);
  }
}

export { TokenCounter };