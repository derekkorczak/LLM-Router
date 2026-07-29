import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import type { Config, Profile } from './config.js';
import type { CatalogStore, RouteEntry } from './catalog.js';
import { GatewayClient, GatewayError } from './gateway.js';
import { estimatePromptTokens, computeOutputBounds } from './tokens.js';
import { inferRequirements, filterAndRank, emptyRequirements } from './filter.js';

export function registerRoutes(
  app: FastifyInstance,
  catalogStore: CatalogStore,
  gatewayClient: GatewayClient,
  config: Config,
  logger: Logger,
): void {
  app.get('/healthz', async (_req, reply) => {
    return { status: 'ok' };
  });

  app.get('/readyz', async (_req, reply) => {
    if (catalogStore.isExpired()) {
      return reply.code(503).send({ status: 'not ready', reason: 'catalog expired' });
    }
    return { status: 'ready' };
  });

  app.get('/v1/models', async (_req, reply) => {
    const profileKeys = Object.keys(config.profiles);
    const aliases = ['auto', ...profileKeys.filter(k => k !== 'default').map(k => `auto:${k}`)];
    return {
      object: 'list',
      data: aliases.map(id => ({ id, object: 'model' })),
    };
  });

  app.post('/v1/chat/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const model = body.model;

    if (!model || !model.startsWith('auto')) {
      return forwardToMerge(body, gatewayClient, logger, reply);
    }

    const profile = resolveProfile(model, config);
    if (!profile) {
      return reply.code(400).send({ error: `Unknown profile: ${model}` });
    }

    if (catalogStore.isExpired()) {
      return reply.code(503).send({
        error: 'Catalog is expired. Refresh the catalog first.',
        admin: 'POST /admin/refresh',
      });
    }

    const req = inferRequirements(body, profile);
    const promptTokens = estimatePromptTokens(body, config);
    const { ceiling, expected } = computeOutputBounds(body, profile);

    const { ranked, counts } = filterAndRank(
      catalogStore.getRoutes(),
      req,
      profile,
      promptTokens,
      ceiling,
      expected,
    );

    if (ranked.length === 0) {
      return reply.code(503).send({
        error: 'No qualifying candidates found',
        requirements: req,
        eliminationCounts: counts,
      });
    }

    const maxAttempts = config.maxAttempts;
    const deadline = Date.now() + config.requestDeadlineMs;
    let lastError: Error | null = null;
    let finalResult: any = null;
    let attempts = 0;

    logger.info({
      profile: model,
      rankedCount: ranked.length,
      maxAttempts,
      top3: ranked.slice(0, 3).map(r => ({
        rank: r.rank,
        model: `${r.route.model}@${r.route.vendor}`,
        tier: r.route.tier,
        inputPrice: r.route.inputPerMillion,
        outputPrice: r.route.outputPerMillion,
        estimatedCost: r.estimatedCost.toFixed(8),
      })),
    }, 'Starting candidate walk');

    for (let i = 0; i < Math.min(ranked.length, maxAttempts); i++) {
      if (Date.now() > deadline) {
        logger.warn({ elapsed: Date.now() - (Date.now() - config.requestDeadlineMs) }, 'Request deadline exceeded');
        break;
      }

      const candidate = ranked[i].route;
      let stripSampling = false;
      attempts++;

      logger.info({
        attempt: attempts,
        rank: ranked[i].rank,
        candidate: `${candidate.model}@${candidate.vendor}`,
        tier: candidate.tier,
        inputPrice: candidate.inputPerMillion,
        outputPrice: candidate.outputPerMillion,
        estimatedCost: ranked[i].estimatedCost.toFixed(8),
        contextWindow: candidate.contextWindow,
        maxOutputTokens: candidate.maxOutputTokens,
      }, `Attempt ${attempts}/${maxAttempts}: ${candidate.model}@${candidate.vendor}`);

      try {
        const plan = { stripSampling };
        const result = await gatewayClient.execute(candidate, body, plan);
        logger.info({
          candidate: `${candidate.model}@${candidate.vendor}`,
          attempt: attempts,
          actualCost: result.usage.cost,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        }, 'Candidate succeeded');
        finalResult = {
          ...result,
          headers: {
            'X-Router-Model': candidate.model,
            'X-Router-Vendor': candidate.vendor,
            'X-Router-Tier': candidate.tier,
            'X-Router-Estimated-Cost': ranked[i].estimatedCost.toFixed(8),
            'X-Router-Actual-Cost': result.usage.cost != null ? result.usage.cost.toString() : 'unknown',
            'X-Router-Attempts': attempts.toString(),
            'X-Router-Candidates-Considered': ranked.length.toString(),
            'X-Router-Catalog-Age-Seconds': Math.floor((Date.now() - catalogStore.fetchedAt.getTime()) / 1000).toString(),
          },
        };
        break;
      } catch (err) {
        if (err instanceof GatewayError) {
          logger.warn({
            candidate: `${candidate.model}@${candidate.vendor}`,
            statusCode: err.statusCode,
            retryable: err.retryable,
          }, 'Gateway execution failed');

          if (!err.retryable) {
            return reply.code(502).send({ error: err.message });
          }

          if (err.stripParams && !stripSampling) {
            stripSampling = true;
            i--;
          }
          lastError = err;
          continue;
        }

        lastError = err as Error;
        logger.error({ err }, 'Unexpected execution error');
      }
    }

    if (!finalResult) {
      return reply.code(502).send({
        error: 'All candidates failed',
        attempts,
        lastError: lastError?.message,
      });
    }

    for (const [key, value] of Object.entries(finalResult.headers)) {
      reply.header(key, value as string);
    }

    logger.info({
      profile: model,
      attempts,
      servedModel: finalResult.model,
      servedVendor: finalResult.vendor,
      servedTier: finalResult.tier,
    }, 'Request served');

    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: finalResult.output,
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: finalResult.usage.inputTokens,
        completion_tokens: finalResult.usage.outputTokens,
        total_tokens: finalResult.usage.totalTokens,
      },
    };
  });

  app.get('/admin/routes', async (_req, reply) => {
    return {
      routeCount: catalogStore.getRoutes().length,
      fetchedAt: catalogStore.fetchedAt.toISOString(),
      routes: catalogStore.getRoutes(),
    };
  });

  app.post('/admin/refresh', async (_req, reply) => {
    try {
      await catalogStore.refresh();
      return {
        status: 'refreshed',
        fetchedAt: catalogStore.fetchedAt.toISOString(),
        routeCount: catalogStore.getRoutes().length,
      };
    } catch (err: any) {
      logger.error({ err }, 'Admin refresh failed');
      return reply.code(500).send({ error: err.message });
    }
  });

  app.post('/admin/explain', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const model = body.model || 'auto';
    const profile = resolveProfile(model, config);

    if (!profile) {
      return reply.code(400).send({ error: `Unknown profile: ${model}` });
    }

    if (catalogStore.getRoutes().length === 0) {
      return reply.code(503).send({ error: 'Catalog is empty. Refresh first.' });
    }

    const req = inferRequirements(body, profile);
    const promptTokens = estimatePromptTokens(body, config);
    const { ceiling, expected } = computeOutputBounds(body, profile);

    const { ranked, counts } = filterAndRank(
      catalogStore.getRoutes(),
      req,
      profile,
      promptTokens,
      ceiling,
      expected,
    );

    return {
      profile: model,
      requirements: req,
      promptTokens,
      outputCeiling: ceiling,
      outputExpected: expected,
      eliminationCounts: counts,
      topCandidates: ranked.slice(0, 10).map(r => ({
        rank: r.rank,
        model: r.route.model,
        vendor: r.route.vendor,
        tier: r.route.tier,
        inputPerMillion: r.route.inputPerMillion,
        outputPerMillion: r.route.outputPerMillion,
        contextWindow: r.route.contextWindow,
        maxOutputTokens: r.route.maxOutputTokens,
        reasoning: r.route.supports_reasoning,
        estimatedCost: r.estimatedCost,
      })),
    };
  });
}

function resolveProfile(model: string, config: Config): Profile | null {
  if (!model || model === 'auto') return config.profiles['default'] || null;

  if (model.startsWith('auto:')) {
    const key = model.slice(5);
    if (key === 'default') return config.profiles['default'] || null;
    return config.profiles[key] || null;
  }

  return config.profiles[model] || null;
}

async function forwardToMerge(
  body: any,
  gatewayClient: GatewayClient,
  logger: Logger,
  reply: FastifyReply,
): Promise<any> {
  const passthrough: RouteEntry = {
    model: body.model,
    provider: '',
    vendor: body.vendor || body.vendors?.[0] || '',
    tier: body.service_tier || 'standard',
    contextWindow: 999999,
    maxOutputTokens: 999999,
    inputPerMillion: 0,
    outputPerMillion: 0,
    supports_tool_calling: true,
    supports_tool_choice: true,
    supports_structured_outputs: true,
    supports_streaming: true,
    supports_reasoning: false,
    zero_data_retention: false,
    capabilitiesInput: ['text', 'image', 'document'],
    capabilitiesOutput: ['text'],
    aliases: [],
    launchDate: null,
  };

  try {
    const result = await gatewayClient.execute(passthrough, body);
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.output },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: result.usage.inputTokens,
        completion_tokens: result.usage.outputTokens,
        total_tokens: result.usage.totalTokens,
      },
    };
  } catch (err: any) {
    logger.error({ err }, 'Forward to Merge failed');
    return reply.code(502).send({ error: err.message });
  }
}
