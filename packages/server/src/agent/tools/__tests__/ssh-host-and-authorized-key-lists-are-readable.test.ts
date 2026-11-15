// ~/.ssh/known_hosts and ~/.ssh/authorized_keys hold no secret, so file_read returns them; a private key in
// the same folder is still refused, and no other door (copy over, patch, share) opens the two lists.
// Driven through the tool executor in a scratch home.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HELPER = 'agent-helper';
const DEFAULT_HELPER = 'agent-default-helper';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'ssh-read-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolResultOf, toolWasBlocked } = await import('../index.js');

const ssh = path.join(home, '.ssh');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const wide = JSON.stringify({ exec_allow: [], exec_deny: [], file_read: '*', file_write: [], network_domains: 'none', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [] });
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions) VALUES (?, ?, 'idle', '{}', ?, ?)");
  add.run(MAIN, 'main', 'sensei', null);
  add.run(HELPER, 'helper', 'apprentice', wide);
  add.run(DEFAULT_HELPER, 'default helper', 'apprentice', null);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
  fs.mkdirSync(ssh, { recursive: true });
  fs.writeFileSync(path.join(ssh, 'known_hosts'), 'host.example.com ssh-ed25519 FAKEHOSTKEY');
  fs.writeFileSync(path.join(ssh, 'authorized_keys'), 'ssh-ed25519 FAKEPUBKEY someone@example.com');
  fs.writeFileSync(path.join(ssh, 'id_ed25519'), 'FAKE PRIVATE KEY BYTES');
  fs.writeFileSync(path.join(home, 'stranger.pub'), 'ssh-ed25519 STRANGERKEY');
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const run = (agentId: string, name: string, args: Record<string, unknown>) =>
  executeTool(agentId, { id: `call-${agentId}-${name}`, name, arguments: args });
const authorized = () => fs.readFileSync(path.join(ssh, 'authorized_keys'), 'utf8');
const read = (agentId: string, file: string) => executeTool(agentId, { id: `call-${agentId}`, name: 'file_read', arguments: { path: file } });

describe('the SSH host and authorized-key lists are readable', () => {
  for (const who of [MAIN, HELPER]) {
    it(`${who} reads ~/.ssh/known_hosts`, async () => {
      expect(toolResultOf(await read(who, '~/.ssh/known_hosts')).content).toContain('FAKEHOSTKEY');
    });
    it(`${who} reads ~/.ssh/authorized_keys`, async () => {
      expect(toolResultOf(await read(who, '~/.ssh/authorized_keys')).content).toContain('FAKEPUBKEY');
    });
    it(`${who} is still refused ~/.ssh/id_ed25519`, async () => {
      const outcome = await read(who, '~/.ssh/id_ed25519');
      expect(toolResultOf(outcome).content).not.toContain('FAKE PRIVATE KEY');
      expect(toolWasBlocked(outcome)).toBe(true);
    });
  }

  it.each(['cp', 'mv'])('a default helper cannot %s a key over ~/.ssh/authorized_keys', async (cmd) => {
    const outcome = await run(DEFAULT_HELPER, 'exec', { argv: [cmd, path.join(home, 'stranger.pub'), path.join(ssh, 'authorized_keys')] });
    expect(toolWasBlocked(outcome) || toolResultOf(outcome).isError).toBe(true);
    expect(authorized()).not.toContain('STRANGERKEY');
  });

  it('file_patch on ~/.ssh/authorized_keys is refused', async () => {
    const outcome = await run(MAIN, 'file_patch', { path: '~/.ssh/authorized_keys', patches: [{ search: 'FAKEPUBKEY', replace: 'STRANGERKEY' }] });
    expect(toolResultOf(outcome).content).toContain('sensitive-files block list');
    expect(authorized()).not.toContain('STRANGERKEY');
  });

  it.each(['known_hosts', 'authorized_keys'])('~/.ssh/%s is never published', async (file) => {
    const outcome = await run(MAIN, 'share_publicly', { source_path: path.join(ssh, file) });
    expect(toolResultOf(outcome).content).toContain('sensitive-files block list');
  });
});
