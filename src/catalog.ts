import { z } from 'zod';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Logger } from 'pino';
import type { Config } from './config.js';

const VendorPricingSchema = z.object({
  input_per_million: z.number().nullable().optional(),
  output_per_million: z.number().nullable().optional(),
  currency: z.string().optional(),
  flex: z.any().optional(),
  priority: z.any().optional(),
  service_tiers: z.array(z.string()).optional(),
  unit: z.string().optional(),
}).passthrough();

const VendorSchema = z.object({
  context_window: z.number(),
  max_output_tokens: z.number(),
  availability_status: z.enum(['available', 'deprecated']).optional(),
  capabilities: z.object({
    input: z.array(z.string()),
    output: z.array(z.string()),
    supports_tool_calling: z.boolean(),
    supports_tool_choice: z.boolean(),
    supports_structured_outputs: z.boolean(),
    streaming: z.boolean(),
  }).passthrough(),
  pricing: VendorPricingSchema,
  launch_date: z.string().optional(),
  supports_reasoning: z.boolean().optional(),
  zero_data_retention: z.boolean().optional(),
}).passthrough();

const PublicModelSchema = z.object({
  model: z.string(),
  provider: z.string(),
  display_name: z.string().optional(),
  availability_status: z.enum(['available', 'deprecated']).optional(),
  vendors: z.record(VendorSchema.or(z.null())),
  aliases: z.array(z.string()).optional(),
  supports_reasoning: z.boolean().optional(),
  zero_data_retention: z.boolean().optional(),
}).passthrough();

const ModelsResponseSchema = z.object({
  data: z.array(z.any()),
  has_more: z.boolean().optional(),
  next_cursor: z.string().optional(),
}).passthrough();

export interface RouteEntry {
  model: string;
  provider: string;
  vendor: string;
  tier: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputPerMillion: number;
  outputPerMillion: number;
  supports_tool_calling: boolean;
  supports_tool_choice: boolean;
  supports_structured_outputs: boolean;
  supports_streaming: boolean;
  supports_reasoning: boolean;
  zero_data_retention: boolean;
  capabilitiesInput: string[];
  capabilitiesOutput: string[];
  aliases: string[];
  launchDate: string | null;
}

export interface CatalogSnapshot {
  fetchedAt: string;
  routeCount: number;
  routes: RouteEntry[];
}

export class CatalogStore {
  private routes: RouteEntry[] = [];
  fetchedAt: Date = new Date(0);
  private catalogDir: string;
  private apiKey: string;
  private logger: Logger;

  constructor(catalogDir: string, apiKey: string, logger: Logger) {
    this.catalogDir = catalogDir;
    this.apiKey = apiKey;
    this.logger = logger;

    if (!existsSync(catalogDir)) {
      mkdirSync(catalogDir, { recursive: true });
    }
  }

  isStale(): boolean {
    const ageMs = Date.now() - this.fetchedAt.getTime();
    return ageMs > 24 * 60 * 60 * 1000;
  }

  isExpired(): boolean {
    const maxAgeMs = parseInt(process.env.CATALOG_MAX_AGE_MS || '604800000', 10);
    const ageMs = Date.now() - this.fetchedAt.getTime();
    return this.routes.length === 0 || ageMs > maxAgeMs;
  }

  getRoutes(): RouteEntry[] {
    return this.routes;
  }

  loadLatest(): boolean {
    const latestPath = join(this.catalogDir, 'catalog-latest.json');
    if (!existsSync(latestPath)) return false;

    try {
      const raw = JSON.parse(readFileSync(latestPath, 'utf-8'));
      if (!raw.routes || !Array.isArray(raw.routes)) return false;

      const version = raw.schemaVersion ?? 0;
      if (version < 2) {
        this.logger.warn({ version }, 'Catalog snapshot schema too old, discarding and will re-fetch');
        return false;
      }

      this.routes = raw.routes;
      this.fetchedAt = new Date(raw.fetchedAt);
      this.logger.info({ routeCount: this.routes.length, fetchedAt: raw.fetchedAt }, 'Loaded catalog from snapshot');
      return true;
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load catalog snapshot');
      return false;
    }
  }

  async refresh(): Promise<void> {
    const models = await this.fetchAllModels();
    const newRoutes = this.flattenModels(models);

    if (newRoutes.length === 0) {
      this.logger.warn('Refresh produced zero routes, retaining previous catalog');
      return;
    }

    this.routes = newRoutes;
    this.fetchedAt = new Date();
    this.saveSnapshot();
    this.logger.info({ routeCount: newRoutes.length }, 'Catalog refreshed');
  }

  private async fetchAllModels(): Promise<z.infer<typeof PublicModelSchema>[]> {
    const models: z.infer<typeof PublicModelSchema>[] = [];
    const maxPages = 50;
    let cursor: string | undefined;
    let pageCount = 0;

    while (pageCount < maxPages) {
      const params = new URLSearchParams({ limit: '50' });
      if (cursor) params.set('cursor', cursor);

      const url = `https://api-gateway.merge.dev/v1/models?${params.toString()}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      if (!res.ok) {
        throw new Error(`Merge API returned ${res.status}: ${res.statusText}`);
      }

      const json = await res.json();
      const parsed = ModelsResponseSchema.safeParse(json);

      if (!parsed.success) {
        if (pageCount > 0) {
          this.logger.warn({ cursor, pageCount }, 'Page missing data array during pagination, stopping but keeping fetched pages');
          break;
        }
        throw new Error(`Invalid response from Merge API: page missing data array`);
      }

      const page = parsed.data;
      if (!Array.isArray(page.data) || page.data.length === 0) {
        if (pageCount > 0) {
          this.logger.warn({ cursor, pageCount }, 'Empty page during pagination, stopping but keeping fetched pages');
          break;
        }
        throw new Error(`Empty page from Merge API on first page`);
      }

      for (const item of page.data) {
        const result = PublicModelSchema.safeParse(item);
        if (result.success) {
          models.push(result.data);
        } else {
          this.logger.warn({ errors: result.error.flatten() }, 'Skipping malformed model entry');
        }
      }

      pageCount++;
      if (!page.has_more || !page.next_cursor) break;
      cursor = page.next_cursor;
    }

    if (pageCount >= maxPages) {
      this.logger.warn('Reached max page limit during catalog fetch');
    }

    return models;
  }

  private flattenModels(models: z.infer<typeof PublicModelSchema>[]): RouteEntry[] {
    const routes: RouteEntry[] = [];

    for (const model of models) {
      if (model.availability_status === 'deprecated') continue;

      for (const [vendorId, vendor] of Object.entries(model.vendors)) {
        if (!vendor) continue;
        if (vendor.availability_status === 'deprecated') continue;

        const pricing = vendor.pricing;
        if (!pricing) continue;

        const unit = pricing.unit ?? 'per_token';
        if (unit !== 'per_token') {
          this.logger.debug({ model: model.model, vendor: vendorId, unit }, 'Skipping non-per_token route');
          continue;
        }

        const inputPrice = pricing.input_per_million;
        const outputPrice = pricing.output_per_million;
        if (inputPrice == null || outputPrice == null || typeof inputPrice !== 'number' || typeof outputPrice !== 'number') {
          continue;
        }

        const tiers = pricing.service_tiers || ['standard'];
        for (const tier of tiers) {
          if (tier === 'priority') continue;

          routes.push({
            model: model.model,
            provider: model.provider,
            vendor: vendorId,
            tier,
            contextWindow: vendor.context_window,
            maxOutputTokens: vendor.max_output_tokens,
            inputPerMillion: inputPrice,
            outputPerMillion: outputPrice,
            supports_tool_calling: vendor.capabilities.supports_tool_calling,
            supports_tool_choice: vendor.capabilities.supports_tool_choice,
            supports_structured_outputs: vendor.capabilities.supports_structured_outputs,
            supports_streaming: vendor.capabilities.streaming,
            supports_reasoning:
              (vendor.capabilities as any).supports_reasoning ??
              (vendor as any).supports_reasoning ??
              model.supports_reasoning ??
              false,
            zero_data_retention:
              (vendor.capabilities as any).zero_data_retention ??
              (vendor as any).zero_data_retention ??
              model.zero_data_retention ??
              false,
            capabilitiesInput: vendor.capabilities.input,
            capabilitiesOutput: vendor.capabilities.output,
            aliases: model.aliases || [],
            launchDate: vendor.launch_date ?? null,
          });
        }
      }
    }

    return routes;
  }

  private saveSnapshot(): void {
    const snapshot = {
      schemaVersion: 2,
      fetchedAt: this.fetchedAt.toISOString(),
      routeCount: this.routes.length,
      routes: this.routes,
    };

    const latestPath = join(this.catalogDir, 'catalog-latest.json');
    writeFileSync(latestPath, JSON.stringify(snapshot, null, 2));

    const date = this.fetchedAt.toISOString().split('T')[0].replace(/-/g, '');
    const datedPath = join(this.catalogDir, `catalog-${date}.json`);
    writeFileSync(datedPath, JSON.stringify(snapshot, null, 2));

    this.logger.debug({ path: latestPath, routeCount: this.routes.length }, 'Catalog snapshot saved');
  }
}
