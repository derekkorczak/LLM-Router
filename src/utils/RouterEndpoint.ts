import fastify from 'fastify';
import { RouterConfig } from './RouterConfig.js';
import { CatalogStore } from '../models/Catalog.js';
import { GatewayClient } from './GatewayClient.js';
import pino from 'pino';
import { z } from 'zod';
import { TokenCounter } from './TokenCounter.js';

// Define Zod schemas for request validation
const ChatCompletionsSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    role: z.string(),
    content: z.string().optional(),
    image_url: z.string().optional(),
    tools: z.array(z.object({
      type: z.string(),
      parameters: z.record(z.string()).optional(),
    })).optional(),
  })),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop: z.array(z.string()).optional(),
  response_format: z.object({
    type: z.string(),
  }).optional(),
  stream: z.boolean().default(false),
  tools: z.array(z.object({
    type: z.string(),
    parameters: z.record(z.string()).optional(),
  })).optional(),
  tool_choice: z.object({
    type: z.string(),
    value: z.string().optional(),
  }).optional(),
  vendor: z.string().optional(),
  vendors: z.array(z.string()).optional(),
  service_tier: z.string().optional(),
  tags: z.array(z.string()).optional(),
  project_id: z.string().optional(),
});

// Router endpoint class
class RouterEndpoint {
  private app: fastify.FastifyInstance;
  private catalogStore: CatalogStore;
  private gatewayClient: GatewayClient;
  private config: RouterConfig;
  private logger: pino.Logger;
  private tokenCounter: TokenCounter;
  
  constructor(
    app: fastify.FastifyInstance,
    catalogStore: CatalogStore,
    gatewayClient: GatewayClient,
    config: RouterConfig,
    logger: pino.Logger
  ) {
    this.app = app;
    this.catalogStore = catalogStore;
    this.gatewayClient = gatewayClient;
    this.config = config;
    this.logger = logger;
    this.tokenCounter = new TokenCounter(config);
    
    // Register routes
    this.registerRoutes();
  }
  
  // Register routes
  private registerRoutes(): void {
    // Proxy endpoint
    this.app.post('/v1/chat/completions', this.handleChatCompletions.bind(this));
    
    // Admin endpoints
    this.app.post('/admin/refresh', this.handleRefresh.bind(this));
    this.app.get('/admin/routes', this.handleRoutes.bind(this));
    this.app.post('/admin/explain', this.handleExplain.bind(this));
    
    // Health checks
    this.app.get('/healthz', this.healthz.bind(this));
    this.app.get('/readyz', this.readyz.bind(this));
    
    // OpenAPI models list
    this.app.get('/v1/models', this.modelsList.bind(this));
  }
  
  // Handle chat completions
  async handleChatCompletions(request: any, reply: any): Promise<void> {
    try {
      const body = ChatCompletionsSchema.parse(request.body);
      
      // Determine profile
      const profile = this.getProfile(body.model);
      
      // Check if catalog is expired
      if (this.catalogStore.isExpired()) {
        return reply.code(503).send({
          error: 'Catalog is expired. Please refresh the catalog first.',
        });
      }
      
      // Infer requirements
      const requirements = this.inferRequirements(body, profile);
      
      // Filter and rank candidates
      const candidates = this.filterAndRankCandidates(profile, requirements);
      
      if (candidates.length === 0) {
        return reply.code(503).send({
          error: 'No candidates match the requirements.',
        });
      }
      
      // Execute the cheapest candidate
      const response = await this.executeCandidate(candidates[0], body, request.body.stream);
      
      // Set response headers
      reply.header('X-Router-Model', candidates[0].model);
      reply.header('X-Router-Vendor', candidates[0].vendor);
      reply.header('X-Router-Tier', candidates[0].tier);
      reply.header('X-Router-Estimated-Cost', this.calculateEstimatedCost(body, profile));
      
      // Send response
      reply.send(response);
    } catch (error) {
      this.logger.error('Error in handleChatCompletions:', error);
      reply.code(500).send({ error: 'Internal server error' });
    }
  }
  
  // Get profile from model alias
  private getProfile(model: string): any {
    if (!model) return this.config.profiles.default;
    
    const profileAlias = model.split(':').pop() || 'default';
    
    if (profileAlias === 'auto') return this.config.profiles.default;
    if (profileAlias.startsWith('auto:')) return this.config.profiles[profileAlias.slice(5)] || this.config.profiles.default;
    
    return this.config.profiles[profileAlias] || this.config.profiles.default;
  }
  
  // Infer requirements from request body
  private inferRequirements(body: any, profile: any): any {
    const requirements = { ...profile.requires };
    
    // Add image requirement if present
    if (body.messages && body.messages.some(msg => msg.image_url || msg.content?.includes('image'))) {
      requirements.input.push('image');
    }
    
    // Add document requirement if present
    if (body.messages && body.messages.some(msg => msg.content?.includes('document'))) {
      requirements.input.push('document');
    }
    
    // Add tool-calling requirement if present
    if (body.tools || body.tool_choice?.type === 'required') {
      requirements.input.push('tool_calling');
    }
    
    // Add structured output requirement if present
    if (body.response_format?.type === 'json_object') {
      requirements.input.push('structured_outputs');
    }
    
    // Add streaming requirement if present
    if (body.stream) {
      requirements.input.push('streaming');
    }
    
    return requirements;
  }
  
  // Filter and rank candidates
  private filterAndRankCandidates(profile: any, requirements: any): any[] {
    const catalog = this.catalogStore.getCatalog();
    
    // Filter candidates
    const filteredCandidates = catalog.filter(candidate => {
      // Check capability flags
      const vendorInfo = candidate.vendors[candidate.vendor];
      if (!vendorInfo.capabilities) return false;
      
      const satisfiesCapabilities = requirements.input.every(input => {
        return vendorInfo.capabilities.input.includes(input);
      });
      
      if (!satisfiesCapabilities) return false;
      
      // Check context and output tokens
      const promptTokens = this.tokenCounter.estimatePromptTokens({ messages: [] });
      const outputCeiling = this.tokenCounter.estimateOutputTokens({ max_tokens: 32000 }, profile.expectedOutputTokens);
      
      if (promptTokens + outputCeiling > candidate.contextWindow) return false;
      if (outputCeiling > candidate.maxOutputTokens) return false;
      
      // Check deny globs
      if (profile.deny.some(denyPattern => new RegExp(denyPattern).test(candidate.model))) {
        return false;
      }
      
      // Check input price floor
      if (profile.minInputPerMillion && candidate.inputPerMillion < profile.minInputPerMillion) {
        return false;
      }
      
      // Check tier
      if (candidate.tier !== profile.allowFlex && candidate.tier !== 'standard') {
        return false;
      }
      
      return true;
    });
    
    // Rank candidates
    return filteredCandidates.sort((a, b) => {
      const costA = this.calculateEstimatedCost({ messages: [] }, profile);
      const costB = this.calculateEstimatedCost({ messages: [] }, profile);
      
      // Adjust for output tokens
      const outputExpectedA = this.tokenCounter.estimateOutputTokens({ max_tokens: 32000 }, profile.expectedOutputTokens);
      const outputExpectedB = this.tokenCounter.estimateOutputTokens({ max_tokens: 32000 }, profile.expectedOutputTokens);
      
      const adjustedCostA = costA * (1 + (outputExpectedA / 1e6) / (32000 / 1e6));
      const adjustedCostB = costB * (1 + (outputExpectedB / 1e6) / (32000 / 1e6));
      
      return adjustedCostA - adjustedCostB;
    });
    
    // For simplicity, use direct cost ranking
    return filteredCandidates.sort((a, b) => {
      const costA = (this.tokenCounter.estimatePromptTokens({ messages: [] }) / 1e6) * a.inputPerMillion + (this.tokenCounter.estimateOutputTokens({ max_tokens: 32000 }, profile.expectedOutputTokens) / 1e6) * a.outputPerMillion;
      const costB = (this.tokenCounter.estimatePromptTokens({ messages: [] }) / 1e6) * b.inputPerMillion + (this.tokenCounter.estimateOutputTokens({ max_tokens: 32000 }, profile.expectedOutputTokens) / 1e6) * b.outputPerMillion;
      
      return costA - costB;
    });
  }
  
  // Execute the selected candidate
  private async executeCandidate(candidate: any, body: any, stream: boolean): Promise<any> {
    try {
      const response = await this.gatewayClient.execute(candidate, body, { stream });
      return response;
    } catch (error) {
      if (this.gatewayClient.isRetryable(error)) {
        throw error; // Retry logic handled by caller
      }
      throw error;
    }
  }
  
  // Handle refresh admin endpoint
  async handleRefresh(request: any, reply: any): Promise<void> {
    try {
      await this.catalogStore.refresh();
      reply.send({
        status: 'success',
        fetchedAt: this.catalogStore.fetchedAt.toISOString(),
        routeCount: this.catalogStore.getCatalog().length,
      });
    } catch (error) {
      this.logger.error('Error refreshing catalog:', error);
      reply.code(500).send({ error: 'Failed to refresh catalog' });
    }
  }
  
  // Handle routes admin endpoint
  async handleRoutes(request: any, reply: any): Promise<void> {
    try {
      const routes = this.catalogStore.getCatalog();
      reply.send(routes);
    } catch (error) {
      this.logger.error('Error fetching routes:', error);
      reply.code(500).send({ error: 'Failed to fetch routes' });
    }
  }
  
  // Handle explain admin endpoint
  async handleExplain(request: any, reply: any): Promise<void> {
    try {
      const body = ChatCompletionsSchema.parse(request.body);
      const profile = this.getProfile(body.model);
      
      const requirements = this.inferRequirements(body, profile);
      const candidates = this.filterAndRankCandidates(profile, requirements);
      
      reply.send({
        profile: profile,
        requirements: requirements,
        candidates: candidates,
        filteredCount: candidates.length,
      });
    } catch (error) {
      this.logger.error('Error explaining request:', error);
      reply.code(500).send({ error: 'Failed to explain request' });
    }
  }
  
  // Health check
  async healthz(request: any, reply: any): Promise<void> {
    reply.code(200).send('OK');
  }
  
  // Ready check
  async readyz(request: any, reply: any): Promise<void> {
    if (this.catalogStore.isExpired()) {
      reply.code(503).send('Catalog not ready');
    } else {
      reply.code(200).send('OK');
    }
  }
  
  // Models list endpoint
  async modelsList(request: any, reply: any): Promise<void> {
    const profiles = Object.keys(this.config.profiles).map(alias => {
      return {
        id: alias,
        object: 'list',
        data: [
          {
            id: alias,
            object: 'model',
            name: alias,
          }
        ],
      };
    });
    
    reply.send(profiles);
  }
  
  // Calculate estimated cost
  private calculateEstimatedCost(body: any, profile: any): number {
    const promptTokens = this.tokenCounter.estimatePromptTokens(body);
    const outputExpected = this.tokenCounter.estimateOutputTokens(body, profile.expectedOutputTokens);
    
    return (promptTokens / 1e6) * profile.minInputPerMillion || 0 + (outputExpected / 1e6) * profile.outputPerMillion || 0;
  }
}

export { RouterEndpoint };