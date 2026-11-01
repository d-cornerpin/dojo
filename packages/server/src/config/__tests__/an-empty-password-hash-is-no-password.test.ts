// D4 (3.5 release testing, present since 3.4.1): `deploy/install.sh` wrote `dashboard_password_hash: ""`, and the
// readers disagreed about what "" means: the login route read it as "no password yet", while the first-run gate and
// GET /api/setup/status read any non-null value as "a password exists" and so treated a brand-new box as already
// set up (setup doors answered "Authentication required" before the owner ever set a password).
//
// THE REQUIREMENT: there is one meaning of "no password" and it lives in the single reader, getDashboardPasswordHash():
// an absent, empty or blank hash is null. A box that finished setup (flag row) or holds a real hash is never sent back
// to the wizard, whatever else is on disk.
//
// TEST HYGIENE: DOJO_HOME is a throwaway temp directory and the database is in memory; the real ~/.dojo is never touched.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const fixtureHome = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'empty-hash-home-'));
fs.mkdirSync(path.join(fixtureHome, '.dojo'), { recursive: true });
const SECRETS = path.join(fixtureHome, '.dojo', 'secrets.yaml');
process.env.DOJO_HOME = fixtureHome;

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));

const { getDashboardPasswordHash, clearSecretsCache } = await import('../loader.js');

const writeSecrets = (hashLine: string): void => {
  fs.writeFileSync(SECRETS, `jwt_secret: abc\nproviders: {}\n${hashLine}`, { mode: 0o600 });
  clearSecretsCache();
};

beforeEach(async () => {
  vi.resetModules();
  mockDb.current = new Database(':memory:');
  mockDb.current.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
});
afterAll(() => { fs.rmSync(fixtureHome, { recursive: true, force: true }); });

// setup-state caches per process; take a fresh copy for each case.
const freshIsPastFirstRun = async (): Promise<boolean> => (await import('../setup-state.js')).isPastFirstRun();

describe('one meaning of "no password"', () => {
  it('an absent, empty or blank hash reads as no password', () => {
    writeSecrets('');
    expect(getDashboardPasswordHash()).toBeNull();
    writeSecrets('dashboard_password_hash: ""\n');
    expect(getDashboardPasswordHash()).toBeNull();
    writeSecrets('dashboard_password_hash: "   "\n');
    expect(getDashboardPasswordHash()).toBeNull();
  });
  it('a real hash reads as itself', () => {
    writeSecrets('dashboard_password_hash: "$2b$12$abcdefghijklmnopqrstuv"\n');
    expect(getDashboardPasswordHash()).toBe('$2b$12$abcdefghijklmnopqrstuv');
  });
});

describe('the first-run gate agrees', () => {
  it('a never-set-up box (empty hash, no flag) is first run', async () => {
    writeSecrets('dashboard_password_hash: ""\n');
    expect(await freshIsPastFirstRun()).toBe(false);
  });
  it('a box that finished setup is past first run even with an empty hash', async () => {
    writeSecrets('dashboard_password_hash: ""\n');
    mockDb.current!.prepare("INSERT INTO config (key, value) VALUES ('setup_completed', 'true')").run();
    expect(await freshIsPastFirstRun()).toBe(true);
  });
  it('a legacy box with a real hash and no flag is past first run', async () => {
    writeSecrets('dashboard_password_hash: "$2b$12$abcdefghijklmnopqrstuv"\n');
    expect(await freshIsPastFirstRun()).toBe(true);
  });
});

describe('the installer no longer writes a misleading empty field', () => {
  it('install.sh creates secrets.yaml without dashboard_password_hash', () => {
    const sh = readFileSync(path.resolve(__dirname, '../../../../../deploy/install.sh'), 'utf8');
    expect(sh).not.toMatch(/dashboard_password_hash/);
    expect(sh).toMatch(/jwt_secret: \$\{JWT_SECRET\}/);
  });
});
