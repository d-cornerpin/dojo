// THE ADVERTISED SURFACE honors the shell class. `exec` is stripped when `exec_allow` is empty,
// but `shell` was never stripped, so an agent with no command grant was offered `shell` and then
// refused. The strip now follows the same rule as every reader (`brokers/grants.ts`): absent
// `shell_allow` the shell follows `exec_allow`; an explicit `[]` withholds the shell. And the
// restricted `exec` description names the agent's real limits, so it no longer promises a
// 30-second timeout that does not bind a helper (its real bound is its silent window).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

const PRIMARY = 'agent-main';
const NO_COMMANDS = 'no-commands';
const EXEC_NO_SHELL = 'exec-no-shell';
const EXEC_AND_SHELL = 'exec-and-shell';
const BASE = { file_read: '*', file_write: '*', exec_allow: [], exec_deny: [], network_domains: 'none', can_spawn_agents: false, can_assign_permissions: false, system_control: [] };

// The home and the env are in place before the product modules are first loaded (they read
// DOJO_HOME at import), so the modules come in through top-level awaits, as in the inspect suite.
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'shell-grant-surface-'));
vi.stubEnv('DOJO_HOME', home);
const imp_connection = await import('../../../db/connection.js');
const imp_migrations = await import('../../../db/migrations.js');
const imp_platform = await import('../../../config/platform.js');
const imp_surface = await import('../surface.js');

beforeAll(() => {
  imp_migrations.runMigrations();
  const db = imp_connection.getDb();
  db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, 'main', 'idle', '{}', 'sensei', NULL, 0, 'system')").run(PRIMARY);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(PRIMARY);
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, ?, 'idle', '{}', 'apprentice', ?, 1, 'agent-main')");
  add.run(NO_COMMANDS, 'no commands', JSON.stringify(BASE));
  add.run(EXEC_NO_SHELL, 'exec no shell', JSON.stringify({ ...BASE, exec_allow: ['ls'], shell_allow: [] }));
  add.run(EXEC_AND_SHELL, 'exec and shell', JSON.stringify({ ...BASE, exec_allow: ['ls'] }));
  imp_platform.clearPlatformConfigCache();
});

afterAll(() => {
  imp_connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const namesOf = (agentId: string) => imp_surface.getFilteredTools(agentId).map((t) => t.name);

describe('the advertised surface follows the shell grant', () => {
  it('an agent with no command grant is offered neither exec nor shell', () => {
    const names = namesOf(NO_COMMANDS);
    expect(names).not.toContain('exec');
    expect(names).not.toContain('shell');
  });

  it('an agent whose shell is withheld is offered exec but not shell', () => {
    const names = namesOf(EXEC_NO_SHELL);
    expect(names).toContain('exec');
    expect(names).not.toContain('shell');
  });

  it('an agent whose shell follows its exec list is offered both', () => {
    const names = namesOf(EXEC_AND_SHELL);
    expect(names).toContain('exec');
    expect(names).toContain('shell');
  });

  it('a restricted exec text names no 30-second timeout', () => {
    const execTool = imp_surface.getFilteredTools(EXEC_NO_SHELL).find((t) => t.name === 'exec');
    expect(execTool?.description).toContain('You can ONLY run these commands: ls');
    expect(execTool?.description).not.toContain('30-second');
  });

  it('the main agent is offered both', () => {
    const names = namesOf(PRIMARY);
    expect(names).toContain('exec');
    expect(names).toContain('shell');
  });
});
