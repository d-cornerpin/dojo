// Everything that enters an exported package goes through the scrubber (the dependency manifest and
// auto-bundled files included), and a link inside the technique folder is never followed out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import type { Readable } from 'node:stream';

const mockDb = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => mockDb.current,
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../memory/embeddings.js', () => ({ refreshEmbedding: vi.fn() }));
vi.mock('../../agent/model.js', () => ({ callModel: vi.fn().mockRejectedValue(new Error('no model in tests')) }));
vi.mock('../../config/platform.js', () => ({ getTrainerAgentId: () => 'trainer' }));

import { runMigrations } from '../../db/migrations.js';
import { createTechnique } from '../store.js';
import { exportTechnique } from '../share-export.js';

const SECRET_A = 'DB_PASSWORD=' + 'q'.repeat(18);
const SECRET_B = 'DB_PASSWORD=' + 'r'.repeat(18);
const SECRET_C = 'DB_PASSWORD=' + 's'.repeat(18);

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-export-'));
  mockDb.current = new Database(path.join(tmp, 'dojo.db'));
  runMigrations();
});
afterEach(() => {
  (mockDb.current as Database.Database).close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function zipOf(stream: Readable): Promise<AdmZip> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return new AdmZip(Buffer.concat(chunks));
}
const textOf = (z: AdmZip) => z.getEntries().map(e => `${e.entryName}\n${e.getData().toString('utf-8')}`).join('\n----\n');

describe('technique export', () => {
  it('scrubs dependencies.json and every auto-bundled file, like the main files', async () => {
    const ext = path.join(tmp, 'ext');
    fs.mkdirSync(ext);
    const helper = path.join(ext, 'helper.txt');
    fs.writeFileSync(helper, `setup\n${SECRET_B}\n`);
    const t = createTechnique({
      name: 'scrub-all', displayName: 'Scrub all', description: 'd',
      instructions: `# T\nRead \`${helper}\` first.\n${SECRET_A}\n`,
      dependencies: { manual_steps: [{ description: `use ${SECRET_C}` }] } as never,
      validateReferences: false,
    } as never);
    const out = await exportTechnique(t.id);
    const z = await zipOf(out.stream);
    const all = textOf(z);
    expect(z.getEntries().some(e => e.entryName.endsWith('helper.txt'))).toBe(true);
    expect(all).not.toContain('q'.repeat(18));
    expect(all).not.toContain('r'.repeat(18));
    expect(all).not.toContain('s'.repeat(18));
    expect(all).toContain('NEEDS_FROM_USER');
  });

  it('never follows a link out of the technique folder and lists it', async () => {
    const outside = path.join(tmp, 'outside-secret.txt');
    fs.writeFileSync(outside, 'OUTSIDE-CONTENT-MARKER');
    const outDir = path.join(tmp, 'outdir');
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, 'inner.txt'), 'OUTSIDE-DIR-MARKER');
    const t = createTechnique({
      name: 'with-links', displayName: 'With links', description: 'd', instructions: '# T\nbody', validateReferences: false,
    } as never);
    fs.symlinkSync(outside, path.join(t.directoryPath, 'looks-local.txt'));
    fs.symlinkSync(outDir, path.join(t.directoryPath, 'looks-local-dir'));
    const out = await exportTechnique(t.id);
    const z = await zipOf(out.stream);
    const all = textOf(z);
    expect(all).not.toContain('OUTSIDE-CONTENT-MARKER');
    expect(all).not.toContain('OUTSIDE-DIR-MARKER');
    expect(out.skippedLinks.sort()).toEqual(['looks-local-dir', 'looks-local.txt']);
    expect(z.getEntry('TECHNIQUE.md')).not.toBeNull();
  });
});
