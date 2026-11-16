// An export whose database a newer Dojo changed is refused before anything is stopped or replaced.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import archiver from 'archiver';
import Database from 'better-sqlite3';
import { homeDir } from '../../home.js';

vi.mock('../../db/connection.js', () => ({ closeDb: vi.fn(), getDb: vi.fn() }));
vi.mock('../../config/loader.js', () => ({ clearSecretsCache: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../checks.js', () => ({ runPostMigrationChecks: vi.fn(), setLastManifest: vi.fn() }));

import { performImport } from '../import.js';

const LIVE = path.join(homeDir(), '.dojo');
const ZIP = path.join(homeDir(), 'newer-export.zip');
const SNAPSHOT = path.join(homeDir(), 'newer-snapshot.db');

function zip(entries: Array<[Buffer | string, string]>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    const a = archiver('zip', { zlib: { level: 1 } });
    a.on('data', (c: Buffer) => chunks.push(c));
    a.on('end', () => resolve(Buffer.concat(chunks)));
    a.on('error', reject);
    for (const [body, name] of entries) a.append(body, { name });
    a.finalize();
  });
}

async function exportFromNewerDojo(password: string): Promise<void> {
  const db = new Database(SNAPSHOT);
  db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY); INSERT INTO _migrations VALUES ('9999_from_a_newer_dojo.sql')");
  db.close();
  const inner = await zip([[fs.readFileSync(SNAPSHOT), 'data/dojo.db']]);
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256'), iv);
  const payload = Buffer.concat([salt, iv, cipher.update(inner), cipher.final()]);
  const manifest = { version: '1.0', exported_from: { hostname: 'x' }, contents: { agents_count: 0, techniques_count: 0 },
    checksum: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}` };
  fs.writeFileSync(ZIP, await zip([[JSON.stringify(manifest), 'manifest.json'], [payload, 'payload.enc']]));
}

beforeEach(() => {
  fs.mkdirSync(LIVE, { recursive: true });
  fs.writeFileSync(path.join(LIVE, 'live.txt'), 'live');
});
afterEach(() => {
  for (const p of [ZIP, SNAPSHOT, path.join(LIVE, 'live.txt')]) fs.rmSync(p, { force: true });
});

describe('an import of a snapshot from a newer build is refused', () => {
  it('refuses before stopping anything and leaves this Dojo as it was', async () => {
    await exportFromNewerDojo('pw');
    const stop = vi.fn(async () => {});
    const restart = vi.fn(async () => {});
    await expect(performImport(ZIP, 'pw', stop, restart)).rejects.toThrow(/holds a change \(9999_from_a_newer_dojo\.sql\) this version of Dojo does not have/);
    expect(stop).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(LIVE, 'live.txt'), 'utf-8')).toBe('live');
  });
});
