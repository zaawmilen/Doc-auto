import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  METRICS_TOKEN: z.string().min(32).optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // AI extraction (optional — falls back to mock/deterministic behavior if unset)
  ANTHROPIC_API_KEY: z.string().optional(),
  ALLOW_MOCK_PROCESSING: z.coerce.boolean().default(false),

  // AWS — optional in dev; when unset, storage/OCR use local + mock fallbacks
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),

  // Supabase Storage — dev-time S3 replacement (see build plan note)
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('documents'),

  // Which storage backend to use: 's3', 'supabase', or 'local' (filesystem, dev/testing only)
  STORAGE_DRIVER: z.enum(['s3', 'supabase', 'local']).default('supabase'),
  LOCAL_STORAGE_DIR: z.string().default('./.local-storage'),

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024), // 15MB
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:\n');
  parsed.error.issues.forEach((issue) => {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  });
  process.exit(1);
}

export const env = parsed.data;

if (env.NODE_ENV === 'production') {
  const productionErrors: string[] = [];

  if (!env.ANTHROPIC_API_KEY && !env.ALLOW_MOCK_PROCESSING) {
    productionErrors.push('ANTHROPIC_API_KEY is required unless ALLOW_MOCK_PROCESSING=true');
  }
  if (!env.METRICS_TOKEN) {
    productionErrors.push('METRICS_TOKEN is required in production');
  }
  if (env.STORAGE_DRIVER === 'local') {
    productionErrors.push('STORAGE_DRIVER=local is not allowed in production');
  }
  if (env.STORAGE_DRIVER === 's3' && !env.AWS_S3_BUCKET) {
    productionErrors.push('AWS_S3_BUCKET is required when STORAGE_DRIVER=s3');
  }
  if (env.STORAGE_DRIVER === 'supabase' && (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)) {
    productionErrors.push('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when STORAGE_DRIVER=supabase');
  }

  if (productionErrors.length > 0) {
    console.error('Invalid production environment:\n');
    productionErrors.forEach((error) => console.error(`  ${error}`));
    process.exit(1);
  }
}

export const isDev = env.NODE_ENV === 'development';
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
