// The main agent's file write to the secrets file is warned once; the identical repeat in the same turn
// writes it. Any other agent is still refused. Runs in a scratch home with fake content only.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const OTHER = 'agent-helper';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'secrets-write-'));
vi.stubEnv('DOJO_HOME', home);
const secrets = path.join(home, '.dojo', 'secrets.yaml');
fs.mkdirSync(path.dirname(secrets), { recursive: true });
fs.writeFileSync(secrets, 'jwt_secret: fakeoriginal000111\n', { mode: 0o600 });

const connection = await import('../../../../../db/connection.js');
const migrations = await import('../../../../../db/migrations.js');
const platform = await import('../../../../../config/platform.js');
const { executeTool, toolResultOf } = await import('../../../../tools/index.js');
const { runRefusalGates } = await import('../refusal-gates.js');
const { initState } = await import('../../../state.js');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const seed = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions) VALUES (?, ?, 'idle', '{}', ?, NULL)");
  seed.run(MAIN, 'main', 'sensei');
  seed.run(OTHER, 'helper', 'apprentice');
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const call = { id: 'c1', name: 'file_write', arguments: { path: '~/.dojo/secrets.yaml', content: 'jwt_secret: fakereplaced000222\n' } };
const gate = (agentId: string, seen: Set<string>) =>
  runRefusalGates(initState({ agentId, turnNumber: 1, lastUserMessageContent: null } as never) as never,
    call as never, { agentId, turnNumber: 1, turnCtx: {}, counterparty: null, refusedOnceSigs: seen } as never, false).refusal;

describe('the main agent is warned once before overwriting the secrets file', () => {
  it('another agent is refused and the file is untouched', async () => {
    expect(gate(OTHER, new Set())).toBeNull();
    expect(toolResultOf(await executeTool(OTHER, call)).content).toMatch(/prohibited|refused|denied/i);
    expect(fs.readFileSync(secrets, 'utf8')).toContain('fakeoriginal000111');
  });

  it('the first try is a warning; the identical repeat in the same turn writes the file', async () => {
    const seen = new Set<string>();
    expect(gate(MAIN, seen)?.content).toMatch(/^\[Engine warning, nothing ran\] This call would overwrite the Dojo's secrets file/);
    expect(fs.readFileSync(secrets, 'utf8')).toContain('fakeoriginal000111');
    expect(gate(MAIN, seen)).toBeNull();
    await executeTool(MAIN, call);
    expect(fs.readFileSync(secrets, 'utf8')).toBe('jwt_secret: fakereplaced000222\n');
  });
});
