// Memory search reads the database through a reader thread that holds its own connection, so after an
// import the Dojo restarts itself: the next process opens only the imported data.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import archiver from 'archiver';
import { homeDir } from '../../home.js';

const db = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../db/connection.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  return { closeDb: vi.fn(), getDbPath: () => ':memory:', getDb: () => (db.current ??= new Database(':memory:')) };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../checks.js', () => ({ runPostMigrationChecks: vi.fn(async () => []), setLastManifest: vi.fn() }));
vi.mock('../import-agents.js', () => ({ stopAgentRunsForImport: () => [], resumeAgentsAfterFailedImport: vi.fn() }));
vi.mock('../../config/platform.js', () => ({ clearPlatformConfigCache: vi.fn() }));
vi.mock('../../config/loader.js', () => ({
  clearSecretsCache: vi.fn(), getDashboardPasswordHash: () => null, getJwtSecret: () => 'test-secret',
  loadSecrets: () => ({}), saveSecrets: vi.fn(),
}));

import { migrationRouter } from '../../gateway/routes/migration.js';

const PASSWORD = 'password-for-test';

/** An encrypted export holding one file, built the way the exporter builds it. */
async function exportZip(): Promise<Buffer> {
  const inner = await zip((a) => a.append('imported', { name: 'notes/imported.txt' }));
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', crypto.pbkdf2Sync(PASSWORD, salt, 100000, 32, 'sha256'), iv);
  const payload = Buffer.concat([salt, iv, cipher.update(inner), cipher.final()]);
  const manifest = {
    version: 1, exported_from: { hostname: 'old-mac', home_directory: homeDir() },
    contents: { agents_count: 0, techniques_count: 0 },
    checksum: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
  };
  return zip((a) => { a.append(JSON.stringify(manifest), { name: 'manifest.json' }); a.append(payload, { name: 'payload.enc' }); });
}

function zip(fill: (a: archiver.Archiver) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const a = archiver('zip', { zlib: { level: 1 } });
    a.on('data', (c: Buffer) => chunks.push(c));
    a.on('end', () => resolve(Buffer.concat(chunks)));
    a.on('error', reject);
    fill(a);
    void a.finalize();
  });
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('after an import, search answers from the new data', () => {
  it('a committed import asks the Dojo to restart once the answer is sent', async () => {
    const live = path.join(homeDir(), '.dojo');
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, 'before.txt'), 'old');
    const body = await exportZip();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    const res = await migrationRouter.request('/import', {
      method: 'POST', body, headers: { 'x-export-password': encodeURIComponent(PASSWORD) },
    });
    expect(await res.json()).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(live, 'notes', 'imported.txt'), 'utf-8')).toBe('imported');

    expect(exit).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
