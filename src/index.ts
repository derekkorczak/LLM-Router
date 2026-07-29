import fastify from 'fastify';
import fastifyOpenApi from '@fastify/openapi';
import { GatewayClient } from './utils/GatewayClient.js';
import { CatalogStore } from './models/Catalog.js';
import { RouterConfig } from './utils/RouterConfig.js';
import { RouterEndpoint } from './utils/RouterEndpoint.js';
import pino from 'pino';
import { readFileSync } from 'fs';
import { join } from 'path';

// Initialize logger
const logger = pino({
  level: 'info',
});

// Load config
const config = JSON.parse(readFileSync(join(__dirname, '../router.config.json'), 'utf-8'));

// Initialize Fastify
const app = fastify({
  logger: logger,
});

// Register OpenAPI
app.register(fastifyOpenApi, {
  openapi: {
    info: {
      title: 'LLM Router API',
      version: '1.0.0',
    },
  },
});

// Initialize Catalog Store
const catalogStore = new CatalogStore(config, logger);

// Initialize Gateway Client
const gatewayClient = new GatewayClient(config, logger);

// Initialize Router Endpoint
const routerEndpoint = new RouterEndpoint(
  app,
  catalogStore,
  gatewayClient,
  config,
  logger
);

// Start the server
app.listen({
  host: process.env.BIND_HOST || '127.0.0.1',
  port: process.env.PORT || 3000,
}, (err) => {
  if (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }
  logger.info(`Server running on ${process.env.BIND_HOST || '127.0.0.1'}:${process.env.PORT || 3000}`);
});