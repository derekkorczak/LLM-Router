import fastify from 'fastify';
import pino from 'pino';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize logger
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

// Initialize Fastify
const app = fastify({
  logger: logger,
});

// Health check endpoints
app.get('/healthz', async (request, reply) => {
  return { status: 'ok' };
});

app.get('/readyz', async (request, reply) => {
  return { status: 'ready' };
});

// Placeholder for chat completions endpoint
app.post('/v1/chat/completions', async (request, reply) => {
  return {
    id: 'chatcmpl-placeholder',
    object: 'chat.completion',
    created: Date.now(),
    model: 'placeholder',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'Router is running but not fully configured yet'
      },
      finish_reason: 'stop'
    }]
  };
});

// Get models endpoint
app.get('/v1/models', async (request, reply) => {
  return {
    object: 'list',
    data: [
      { id: 'auto', object: 'model' },
      { id: 'auto:coding', object: 'model' },
      { id: 'auto:vision', object: 'model' },
      { id: 'auto:bulk', object: 'model' }
    ]
  };
});

// Start the server
const start = async () => {
  try {
    const host = process.env.BIND_HOST || '0.0.0.0';
    const port = parseInt(process.env.PORT || '3000');
    
    await app.listen({ host, port });
    logger.info(`Server running on ${host}:${port}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

start();
