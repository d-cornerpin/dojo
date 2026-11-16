// file_patch reads the file it edits, so a hidden file (the keys file, an SSH private key, a cloud
// credential) is refused for every agent, the main agent included, real run or dry run. The answer is
// the same whether the file exists or the search text matches, so it tells nothing. Through executeTool.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HELPER = 'agent-helper';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'patch-hidden-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolResultOf, toolWasBlocked } = await import('../index.js');

const HIDDEN = [
  path.join(home, '.dojo', 'secrets.yaml'),
  path.join(home, '.ssh', 'id_ed25519'),
  path.join(home, '.aws', 'credentials'),
];
const SECRET = 'FAKE-SECRET-VALUE';

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const writesAnywhere = JSON.stringify({ file_read: ['~/Projects/**'], file_write: '*', exec_allow: [], exec_deny: [], network_domains: 'none', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [] });
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, ?, 'idle', '{}', ?, ?, 1, 'agent-main')");
  add.run(MAIN, 'main', 'sensei', null);
  add.run(HELPER, 'helper', 'apprentice', writesAnywhere);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const patch = (agentId: string, file: string, search: string, dryRun: boolean) =>
  executeTool(agentId, { id: `call-${agentId}`, name: 'file_patch', arguments: { path: file, patches: [{ search, replace: 'x' }], dry_run: dryRun } });

describe('file_patch never opens a hidden file', () => {
  for (const who of [MAIN, HELPER]) {
    for (const file of HIDDEN) {
      it(`${who} is refused ${path.relative(home, file)}, with one answer for every case`, async () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `key: ${SECRET}\n`);
        const answers: string[] = [];
        for (const [search, dryRun] of [[SECRET, true], ['absent text', true], [SECRET, false]] as const) {
          const outcome = await patch(who, file, search, dryRun);
          expect(toolWasBlocked(outcome)).toBe(true);
          answers.push(toolResultOf(outcome).content);
        }
        expect(fs.readFileSync(file, 'utf8')).toBe(`key: ${SECRET}\n`);
        fs.rmSync(file);
        answers.push(toolResultOf(await patch(who, file, SECRET, true)).content);
        expect(new Set(answers).size).toBe(1);
      });
    }
  }
});
