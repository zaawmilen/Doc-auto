import { env } from '../config/env.js';
import { logger } from './logger.js';

export interface UploadResult {
  storageKey: string;
}

/**
 * Storage driver abstraction. Two backends:
 *  - 's3': AWS S3, used in production.
 *  - 'supabase': Supabase Storage, used in dev before AWS credentials exist
 *    (see build plan note: "Weeks 1-2 can be completed before AWS credentials
 *    are set up — use Supabase Storage as S3 replacement temporarily").
 *
 * Callers only deal with storageKey — never with driver-specific URLs — so
 * switching STORAGE_DRIVER later requires no changes outside this file.
 */

async function uploadToS3(key: string, buffer: Buffer, contentType: string): Promise<UploadResult> {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  if (!env.AWS_S3_BUCKET) throw new Error('AWS_S3_BUCKET is not set');
  const client = new S3Client({
    region: env.AWS_REGION,
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } }
      : {}),
  });
  await client.send(new PutObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return { storageKey: key };
}

async function uploadToSupabase(key: string, buffer: Buffer, contentType: string): Promise<UploadResult> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  }
  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_STORAGE_BUCKET}/${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: new Uint8Array(buffer),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase Storage upload failed (${res.status}): ${body}`);
  }
  return { storageKey: key };
}

async function uploadToLocal(key: string, buffer: Buffer): Promise<UploadResult> {
  const { writeFile, mkdir } = await import('fs/promises');
  const { dirname, join } = await import('path');
  const fullPath = join(env.LOCAL_STORAGE_DIR, key);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, buffer);
  return { storageKey: key };
}

async function downloadFromLocal(key: string): Promise<Buffer> {
  const { readFile } = await import('fs/promises');
  const { join } = await import('path');
  return readFile(join(env.LOCAL_STORAGE_DIR, key));
}

export async function uploadDocument(
  params: { tenantId: string; documentId: string; fileName: string; buffer: Buffer; contentType: string },
): Promise<UploadResult> {
  const key = `${params.tenantId}/${params.documentId}/${params.fileName}`;

  if (env.STORAGE_DRIVER === 's3') {
    logger.info({ key, driver: 's3' }, 'Uploading document');
    return uploadToS3(key, params.buffer, params.contentType);
  }
  if (env.STORAGE_DRIVER === 'local') {
    logger.info({ key, driver: 'local' }, 'Uploading document');
    return uploadToLocal(key, params.buffer);
  }
  logger.info({ key, driver: 'supabase' }, 'Uploading document');
  return uploadToSupabase(key, params.buffer, params.contentType);
}

async function presignS3Url(key: string, ttlSeconds: number): Promise<string> {
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  if (!env.AWS_S3_BUCKET) throw new Error('AWS_S3_BUCKET is not set');
  const client = new S3Client({ region: env.AWS_REGION });
  const command = new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key });
  return getSignedUrl(client, command, { expiresIn: ttlSeconds });
}

async function presignSupabaseUrl(key: string, ttlSeconds: number): Promise<string> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  }
  const url = `${env.SUPABASE_URL}/storage/v1/object/sign/${env.SUPABASE_STORAGE_BUCKET}/${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: ttlSeconds }),
  });
  if (!res.ok) throw new Error(`Supabase Storage sign failed (${res.status})`);
  const data = (await res.json()) as { signedURL: string };
  return `${env.SUPABASE_URL}/storage/v1${data.signedURL}`;
}

export async function getPresignedUrl(storageKey: string, ttlSeconds = 60): Promise<string> {
  if (env.STORAGE_DRIVER === 's3') return presignS3Url(storageKey, ttlSeconds);
  if (env.STORAGE_DRIVER === 'local') return `local://${env.LOCAL_STORAGE_DIR}/${storageKey}`;
  return presignSupabaseUrl(storageKey, ttlSeconds);
}

async function downloadFromS3(key: string): Promise<Buffer> {
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  if (!env.AWS_S3_BUCKET) throw new Error('AWS_S3_BUCKET is not set');
  const client = new S3Client({ region: env.AWS_REGION });
  const result = await client.send(new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }));
  const chunks: Uint8Array[] = [];
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function downloadFromSupabase(key: string): Promise<Buffer> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  }
  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_STORAGE_BUCKET}/${key}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
  if (!res.ok) throw new Error(`Supabase Storage download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function downloadDocument(storageKey: string): Promise<Buffer> {
  if (env.STORAGE_DRIVER === 's3') return downloadFromS3(storageKey);
  if (env.STORAGE_DRIVER === 'local') return downloadFromLocal(storageKey);
  return downloadFromSupabase(storageKey);
}
