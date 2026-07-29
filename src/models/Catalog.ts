import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { RouterConfig } from '../utils/RouterConfig.js';
import pino from 'pino';

// Define Zod schemas for catalog entries
const PublicModelSchema = z.object({
  model: z.string(),
  provider: z.string(),
  display_name: z.string(),
  availability_status: z.enum(['available', 'deprecated']),
  vendors: z.record(z.object({
    context_window: z.number(),
    max_output_tokens: z.number(),
    availability_status: z.enum(['available', 'deprecated']),
    capabilities: z.object({
      input: z.array(z.string()),
      output: z.array(z.string()),
      supports_tool_calling: z.boolean(),
      supports_tool_choice: z.boolean(),
      supports_structured_outputs: z.boolean(),
      streaming: z.boolean(),
    }),
    pricing: z.object({
      input_per_million: z.number().optional(),
      output_per_million: z.number().optional(),
      flex: z.boolean().optional(),
      priority: z.boolean().optional(),
      service_tiers: z.array(z.string()).optional(),
      currency: z.string().optional(),
    }),
    launch_date: z.string().optional(),
  }),
  aliases: z.array(z.string()).optional(),
  supports_reasoning: z.boolean().optional(),
  zero_data_retention: z.boolean().optional(),
  unit: z.string().optional(),
});

// Flattened route table schema
const RouteTableSchema = z.object({
  model: z.string(),
  provider: z.string(),
  vendor: z.string(),
  tier: z.string(),
  contextWindow: z.number(),
  maxOutputTokens: z.number(),
  inputPerMillion: z.number(),
  outputPerMillion: z.number(),
  supports_reasoning: z.boolean(),
  zero_data_retention: z.boolean(),
});

// Catalog store class
class CatalogStore {
  private config: RouterConfig;
  private logger: pino.Logger;
  private catalog: RouteTableSchema[] = [];
  private fetchedAt: Date;
  private catalogDir: string;
  
  constructor(config: RouterConfig, logger: pino.Logger) {
    this.config = config;
    this.logger = logger;
    this.catalogDir = join(__dirname, '../../catalog');
    this.loadLatestCatalog();
  }
  
  // Load latest catalog snapshot
  private loadLatestCatalog(): void {
    const latestFile = join(this.catalogDir, 'catalog-latest.json');
    if (fs.existsSync(latestFile)) {
      const data = JSON.parse(readFileSync(latestFile, 'utf-8'));
      this.catalog = data.routes;
      this.fetchedAt = new Date(data.fetchedAt);
    }
  }
  
  // Fetch catalog from Merge
  async fetchCatalog(): Promise<void> {
    const apiKey = process.env.MERGE_API_KEY;
    if (!apiKey) {
      throw new Error('MERGE_API_KEY environment variable is not set.');
    }
    
    const response = await fetch('https://api-gateway.merge.dev/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch catalog: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!data.data || !data.data.length) {
      throw new Error('Catalog page is empty.');
    }
    
    const models = data.data.map((item: any) => PublicModelSchema.parse(item));
    
    const routes: RouteTableSchema[] = [];
    
    for (const model of models) {
      for (const vendorInfo of Object.values(model.vendors)) {
        for (const tier of vendorInfo.service_tiers || []) {
          const pricing = vendorInfo.pricing;
          if (!pricing || pricing.input_per_million === null || pricing.output_per_million === null) {
            continue;
          }
          
          if (pricing.unit !== 'per_token') {
            continue;
          }
          
          routes.push({
            model: model.model,
            provider: model.provider,
            vendor: vendorInfo.vendor,
            tier: tier,
            contextWindow: vendorInfo.context_window,
            maxOutputTokens: vendorInfo.max_output_tokens,
            inputPerMillion: pricing.input_per_million,
            outputPerMillion: pricing.output_per_million,
            supports_reasoning: model.supports_reasoning || false,
            zero_data_retention: model.zero_data_retention || false,
          });
        }
      }
    }
    
    this.catalog = routes;
    this.fetchedAt = new Date();
    
    // Save snapshot
    this.saveSnapshot();
  }
  
  // Save catalog snapshot
  private saveSnapshot(): void {
    const snapshotData = {
      fetchedAt: this.fetchedAt.toISOString(),
      routes: this.catalog,
    };
    
    const latestFile = join(this.catalogDir, 'catalog-latest.json');
    writeFileSync(latestFile, JSON.stringify(snapshotData, null, 2));
    
    // Save additional snapshots (e.g., daily)
    const date = this.fetchedAt.toISOString().split('T')[0];
    const snapshotFile = join(this.catalogDir, `catalog-${date}.json`);
    writeFileSync(snapshotFile, JSON.stringify(snapshotData, null, 2));
  }
  
  // Check if catalog is expired
  isExpired(): boolean {
    const maxAgeMs = this.config.CATALOG_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000;
    const ageMs = Date.now() - this.fetchedAt.getTime();
    return ageMs > maxAgeMs;
  }
  
  // Get catalog
  getCatalog(): RouteTableSchema[] {
    return this.catalog;
  }
  
  // Force refresh
  async refresh(): Promise<void> {
    await this.fetchCatalog();
  }
}

export { CatalogStore };