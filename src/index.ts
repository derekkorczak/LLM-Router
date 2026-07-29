import Fastify from 'fastify';
import pino from 'pino';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadConfig } from './config.js';
import { CatalogStore } from './catalog.js';
import { GatewayClient } from './gateway.js';
import { registerRoutes } from './routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  name: 'llm-router',
});

const configPath = process.env.CONFIG_PATH || join(__dirname, '..', 'router.config.json');
const MERGE_API_KEY = process.env.MERGE_API_KEY || '';
const CATALOG_DIR = process.env.CATALOG_DIR || join(__dirname, '..', 'catalog');
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '3000', 10);
const REFRESH_INTERVAL_MS = parseInt(process.env.CATALOG_REFRESH_INTERVAL_MS || '86400000', 10);

let config;
try {
  config = loadConfig(configPath);
  logger.info({ path: configPath }, 'Config loaded');
} catch (err) {
  logger.fatal({ err }, 'Failed to load config');
  process.exit(1);
}

if (!MERGE_API_KEY) {
  logger.warn('MERGE_API_KEY is not set. Catalog fetch and gateway execution will fail.');
}

const catalogStore = new CatalogStore(CATALOG_DIR, MERGE_API_KEY, logger);
const loaded = catalogStore.loadLatest();

const gatewayClient = new GatewayClient(MERGE_API_KEY, logger);

const app = Fastify({ logger: false });

app.addHook('onRequest', (request, _reply, done) => {
  logger.debug({ method: request.method, url: request.url }, 'Incoming request');
  done();
});

registerRoutes(app, catalogStore, gatewayClient, config, logger);

async function refreshCatalog(): Promise<void> {
  if (!MERGE_API_KEY) {
    logger.warn('Skipping catalog refresh: MERGE_API_KEY not set');
    return;
  }

  try {
    await catalogStore.refresh();
    logger.info('Background catalog refresh complete');
  } catch (err) {
    logger.error({ err }, 'Background catalog refresh failed');
  }
}

async function start(): Promise<void> {
  if (!loaded) {
    logger.info('No catalog snapshot found, performing initial fetch...');
    await refreshCatalog();
  } else {
    logger.info('Catalog loaded from snapshot, refreshing in background');
    refreshCatalog().catch(err => logger.error({ err }, 'Background refresh error'));
  }

  try {
    await app.listen({ host: BIND_HOST, port: PORT });
    logger.info(`Server listening on ${BIND_HOST}:${PORT}`);
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();

setInterval(() => {
  refreshCatalog().catch(err => logger.error({ err }, 'Scheduled refresh error'));
}, REFRESH_INTERVAL_MS);

process.on('SIGTERM', async () => {
  logger.info('Shutting down');
  await app.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Shutting down');
  await app.close();
  process.exit(0);
});
