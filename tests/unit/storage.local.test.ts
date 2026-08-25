import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadDocument, getPresignedUrl, uploadDocument } from '../../src/lib/storage.js';
import { env } from '../../src/config/env.js';

// This suite exercises the real public storage API against real disk I/O.
// It only runs meaningfully when STORAGE_DRIVER=local, which is what every
// other test in this repo already runs with — skip cleanly otherwise rather
// than fail for an unrelated environment reason.
const isLocalDriver = env.STORAGE_DRIVER === 'local';
const describeLocal = isLocalDriver ? describe : describe.skip;

describeLocal('storage (local driver)', () => {
  const written: string[] = [];

  afterEach(async () => {
    for (const key of written.splice(0)) {
      const fullPath = join(env.LOCAL_STORAGE_DIR, key);
      if (existsSync(fullPath)) await rm(fullPath);
    }
  });

  it('writes a file under <tenantId>/<documentId>/<fileName> and reads the same bytes back', async () => {
    const tenantId = randomUUID();
    const documentId = randomUUID();
    const content = Buffer.from('%PDF-1.4 some real bytes, not a placeholder');

    const { storageKey } = await uploadDocument({
      tenantId,
      documentId,
      fileName: 'invoice.pdf',
      buffer: content,
      contentType: 'application/pdf',
    });
    written.push(storageKey);

    expect(storageKey).toBe(`${tenantId}/${documentId}/invoice.pdf`);

    const onDisk = await readFile(join(env.LOCAL_STORAGE_DIR, storageKey));
    expect(onDisk.equals(content)).toBe(true);

    const downloaded = await downloadDocument(storageKey);
    expect(downloaded.equals(content)).toBe(true);
  });

  it('creates nested tenant/document directories that do not exist yet', async () => {
    const tenantId = randomUUID();
    const documentId = randomUUID();
    const fullDir = join(env.LOCAL_STORAGE_DIR, tenantId, documentId);
    expect(existsSync(fullDir)).toBe(false);

    const { storageKey } = await uploadDocument({
      tenantId,
      documentId,
      fileName: 'x.pdf',
      buffer: Buffer.from('x'),
      contentType: 'application/pdf',
    });
    written.push(storageKey);

    expect(existsSync(fullDir)).toBe(true);
  });

  it('two documents for the same tenant do not collide', async () => {
    const tenantId = randomUUID();
    const docA = randomUUID();
    const docB = randomUUID();

    const a = await uploadDocument({ tenantId, documentId: docA, fileName: 'a.pdf', buffer: Buffer.from('AAA'), contentType: 'application/pdf' });
    const b = await uploadDocument({ tenantId, documentId: docB, fileName: 'b.pdf', buffer: Buffer.from('BBB'), contentType: 'application/pdf' });
    written.push(a.storageKey, b.storageKey);

    expect(await downloadDocument(a.storageKey)).toEqual(Buffer.from('AAA'));
    expect(await downloadDocument(b.storageKey)).toEqual(Buffer.from('BBB'));
  });

  it('downloading a key that was never uploaded fails rather than returning empty data', async () => {
    await expect(downloadDocument(`${randomUUID()}/${randomUUID()}/nope.pdf`)).rejects.toThrow();
  });

  it('getPresignedUrl for the local driver returns a local:// pointer, not a real signed URL', async () => {
    const tenantId = randomUUID();
    const documentId = randomUUID();
    const { storageKey } = await uploadDocument({
      tenantId,
      documentId,
      fileName: 'p.pdf',
      buffer: Buffer.from('p'),
      contentType: 'application/pdf',
    });
    written.push(storageKey);

    const url = await getPresignedUrl(storageKey);
    expect(url).toBe(`local://${env.LOCAL_STORAGE_DIR}/${storageKey}`);
  });
});
