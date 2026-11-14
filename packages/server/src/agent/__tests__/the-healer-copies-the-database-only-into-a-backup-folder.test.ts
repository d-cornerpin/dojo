// The Healer may take a whole copy of the database with VACUUM INTO, but only into a backup folder,
// where no other agent can read it by shell or by the file tool. Verdicts of the exec and file doors on
// strings only: nothing is executed.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HEALER = 'agent-healer';
const WORKER = 'agent-worker';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'healer-copy-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../db/connection.js');
const migrations = await import('../../db/migrations.js');
const platform = await import('../../config/platform.js');
const brokers = await import('../brokers/index.js');
const { resolvePathArg } = await import('../brokers/resolve.js');

const DB = '~/.dojo/data/dojo.db';
const COPY = `${home}/.dojo/backups/copy.db`;

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions) VALUES (?, ?, 'idle', '{}', ?, ?)");
  add.run(MAIN, 'main', 'sensei', null);
  add.run(HEALER, 'healer', 'sensei', JSON.stringify({ exec_allow: ['*'], exec_deny: [], file_read: '*', file_write: '*', file_delete: 'none', network_domains: '*', max_processes: 5, can_spawn_agents: false, can_assign_permissions: false, system_control: [] }));
  add.run(WORKER, 'worker', 'apprentice', JSON.stringify({ exec_allow: ['*'], exec_deny: [], file_read: '*', file_write: 'none', file_delete: 'none', network_domains: '*', max_processes: 5, can_spawn_agents: false, can_assign_permissions: false, system_control: [] }));
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?), ('healer_agent_id', ?)").run(MAIN, HEALER);
  platform.clearPlatformConfigCache();
});
afterAll(() => { connection.closeDb(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

const shell = async (who: string, line: string) => brokers.authorizeExecShapedCall(brokers.grantFor(who), 'shell', line);
const readFile = async (who: string, p: string) => {
  const r = resolvePathArg(p);
  if (!r.ok) throw new Error(r.reason);
  return brokers.authorize(brokers.grantFor(who), { kind: 'fs_read', resource: r.value });
};
const message = (v: { allowed: boolean; blockedMessage?: string | null; reason?: string }): string => (v.allowed ? '' : v.blockedMessage ?? v.reason ?? '');

describe('the Healer copies the database only into a backup folder', () => {
  it('a copy into the backup folder is allowed', async () => {
    expect((await shell(HEALER, `sqlite3 ${DB} "VACUUM INTO '${COPY}'"`)).allowed).toBe(true);
  });

  it('a copy into a temp folder is refused with one sentence naming where it may go', async () => {
    const v = await shell(HEALER, `sqlite3 ${DB} "VACUUM INTO '/tmp/copy.db'"`);
    expect(v.allowed).toBe(false);
    expect(message(v)).toBe('Refused: a copy of the database may be written only into ~/.dojo/data/backups/ or ~/.dojo/backups/, given as a full path.');
  });

  it('a path that climbs out of the backup folder, or a relative one, is refused', async () => {
    expect((await shell(HEALER, `sqlite3 ${DB} "VACUUM INTO '${home}/.dojo/backups/../copy.db'"`)).allowed).toBe(false);
    expect((await shell(HEALER, `sqlite3 ${DB} "VACUUM INTO 'copy.db'"`)).allowed).toBe(false);
  });

  it('a worker is refused the copy by shell; no agent reads it with the file tool', async () => {
    expect((await shell(WORKER, `sqlite3 -readonly ${COPY} "select * from agents"`)).allowed).toBe(false);
    expect((await shell(WORKER, `cat ${COPY}`)).allowed).toBe(false);
    for (const who of [MAIN, WORKER]) expect((await readFile(who, COPY)).allowed, who).toBe(false);
  });
});
