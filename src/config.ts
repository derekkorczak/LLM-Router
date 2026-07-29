import { readFileSync, existsSync } from 'fs';
import { z } from 'zod';

const ProfileSchema = z.object({
  expectedOutputTokens: z.number().default(1500),
  allowFlex: z.boolean().default(false),
  deny: z.array(z.string()).default([]),
  minInputPerMillion: z.number().default(0),
  minOutputPerMillion: z.number().default(0),
  requires: z.array(z.string()).default([]),
});

export type Profile = z.infer<typeof ProfileSchema>;

const ConfigSchema = z.object({
  tokenSafetyMargin: z.number().default(0.15),
  imageTokenAllowance: z.number().default(1200),
  documentTokenAllowance: z.number().default(3000),
  maxAttempts: z.number().default(3),
  requestDeadlineMs: z.number().default(120000),
  refreshAbortDropRatio: z.number().default(0.05),
  shadowModel: z.string().nullable().default(null),
  profiles: z.record(ProfileSchema).default({
    default: {
      expectedOutputTokens: 1500,
      allowFlex: false,
      deny: [],
      minInputPerMillion: 0,
      minOutputPerMillion: 0,
      requires: [],
    },
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  return ConfigSchema.parse(raw);
}
