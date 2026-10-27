// ════════════════════════════════════════════════════════════════════════════
// A FAILED EXPORT WRITE REJECTS, IT DOES NOT CRASH THE SERVER.
//
// `createZipFromDir` and `createFinalZip` (migration/export.ts) build the export
// with two promise wrappers around archiver. They listen for the ARCHIVER's
// 'error' and the OUTPUT stream's 'close' — but not for the output stream's
// 'error'. A failure of the OUTPUT file (disk full while writing, a read-only or
// missing temp folder, a permission error) is an 'error' event on the
// fs.WriteStream, and with no listener that is an uncaught exception that takes
// the whole server down mid-request; the promise also never settles, so the
// export's catch that deletes the staging folder never runs. These cases pin the
// fix: an output write failure rejects with the stream's error, and the success
// path is unchanged.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createZipFromDir, createFinalZip } from '../export.js';

vi.mock('../../db/connection.js', () => ({
  getDb: () => { throw new Error('unused'); },
  getDbPath: () => '/nonexistent/dojo.db',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

const ROOT = path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), `dojo-export-write-${process.pid}`);
const SRC = path.join(ROOT, 'src');
const MISSING_DIR = path.join(ROOT, 'no-such-dir');

function makeSourceDir(): string {
  fs.mkdirSync(SRC, { recursive: true });
  fs.writeFileSync(path.join(SRC, 'small.txt'), 'a small payload');
  return SRC;
}

function makePayloadFile(): string {
  const p = path.join(ROOT, 'payload.enc');
  fs.writeFileSync(p, 'payload-bytes');
  return p;
}

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('a failed export write rejects instead of crashing the server', () => {
  it('createZipFromDir rejects with ENOENT when the output folder does not exist', async () => {
    const srcDir = makeSourceDir();
    await expect(createZipFromDir(srcDir, path.join(MISSING_DIR, 'out.zip')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  }, 5000);

  it('createFinalZip rejects with ENOENT when the output folder does not exist', async () => {
    makeSourceDir();
    const payload = makePayloadFile();
    await expect(createFinalZip(path.join(MISSING_DIR, 'out.zip'), { version: 1 } as never, payload))
      .rejects.toMatchObject({ code: 'ENOENT' });
  }, 5000);

  it('createZipFromDir success path is unchanged: resolves and writes a non-empty zip', async () => {
    const srcDir = makeSourceDir();
    const out = path.join(ROOT, 'out.zip');
    await createZipFromDir(srcDir, out);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });

  it('createFinalZip success path is unchanged: resolves into a real folder and writes a PK zip', async () => {
    makeSourceDir();
    const payload = makePayloadFile();
    const out = path.join(ROOT, 'final.zip');
    await createFinalZip(out, { version: 1 } as never, payload);
    expect(fs.readFileSync(out).subarray(0, 2).toString('latin1')).toBe('PK');
  });
});
