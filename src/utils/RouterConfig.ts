import { z } from 'zod';
import { readFileSync } from 'fs';
import { join } from 'path';

// Define Zod schemas for config
const ConfigSchema = z.object({
  tokenSafetyMargin: z.number().default(0.15),
  imageTokenAllowance: z.number().default(1200),
  documentTokenAllowance: z.number().default(3000),
  maxAttempts: z.number().default(3),
  requestDeadlineMs: z.number().default(120000),
  refreshAbortDropRatio: z.number().default(0.05),
  profiles: z.record(z.object({
    expectedOutputTokens: z.number(),
    allowFlex: z.boolean(),
    deny: z.array(z.string()),
    minInputPerMillion: z.number().optional(),
    requires: z.array(z.string()),
  }))
});

// Router config class
class RouterConfig {
  public config: any;
  
  constructor() {
    const configFile = join(__dirname, '../router.config.json');
    const configData = JSON.parse(readFileSync(configFile, 'utf-8'));
    this.config = ConfigSchema.parse(configData);
  }
}

export { RouterConfig };