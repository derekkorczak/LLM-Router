import { RouterConfig } from './src/utils/RouterConfig.js';
import { CatalogStore } from './src/models/Catalog.js';
import pino from 'pino';

// Initialize logger
const logger = pino({
  level: 'info',
});

// Load config
const config = new RouterConfig();

// Initialize Catalog Store
const catalogStore = new CatalogStore(config, logger);

// Test if catalog is loaded
console.log('Catalog loaded:', catalogStore.getCatalog().length > 0);

// Log config
console.log('Config:', config.config);