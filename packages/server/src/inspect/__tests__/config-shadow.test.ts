// t285 F1 — a config value whose key names a credential is blanked AT THE SOURCE: the query runs
// against a temp view, so no expression, window, filter or cast can learn anything about it.
// Driven through the real read-only child on a scratch DOJO_HOME. Synthetic values only.

import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

const SECRET = 'synthetic-secret-value-001';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inspect-cfg-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../db/connection.js');
const { runMigrations } = await import('../../db/migrations.js');
const { sql } = await import('../sql.js');
const turnState = await import('../../agent/turn-state.js');
const cap = await import('../../agent/effects/capability.js');
runMigrations();
{
  const db = connection.getDb();
  const ins = db.prepare('INSERT INTO config (key, value) VALUES (?, ?)');
  ins.run('example_api_key', SECRET); ins.run('a_theme', 'dark'); ins.run('zz_theme', 'light'); ins.run('n_limit', '42');
  db.exec('CREATE VIEW cfg_alias AS SELECT key, value FROM config');
}
afterAll(() => { connection.closeDb(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

const AGENT = 'agent-cfg-test';
const q = (query: string): Promise<string> => turnState.runWithToolCallId(AGENT, `call-${AGENT}`, async () => {
  cap.attachCallCapability(cap.mintCallCapability({
    agentId: AGENT, tool: 'dojo_inspect', callId: `call-${AGENT}`,
    grants: [{ kind: 'proc', program: process.execPath, display: 'node' }],
  }));
  return sql({ query });
});

describe('config values are blanked at the source', () => {
  it('the state page suggestion works: harmless values show, the credential value does not', async () => {
    const out = await q("select key, value from config where key like '%'");
    expect(out).toContain('dark'); expect(out).toContain('light');
    expect(out).not.toContain(SECRET);
    expect(out).toContain('<redacted-credential>');
  });
  it.each([
    ['plain select without the key', "select value from config where key like '%api_key%'"],
    ['a window function bringing a neighbouring row next to a harmless key', 'select key, lag(value) over (order by key) from config'],
    ['a decoy key column placed first', "select 'x' as key, key, value from config"],
    ['a number derived from the value', "select length(value), unicode(value), instr(value,'s'), value > 'a' from config where key = 'example_api_key'"],
    ['a filter on the value', "select key from config where value = '" + SECRET + "'"],
    ['a filter on a prefix of the value', "select key from config where value like 'synthetic%'"],
    ['a sort by the value', 'select key from config order by value'],
    ['an aggregate', 'select max(value), group_concat(value) from config'],
    ['a main-schema view over config', 'select * from cfg_alias'],
  ])('%s returns nothing about the value', async (_n, query) => {
    const out = await q(query);
    expect(out).not.toContain(SECRET);
    if (query.includes('unicode(')) expect(out).not.toMatch(/\b26\b|\b115\b/); // its length, its first character code
    if (/where value = /.test(query) || /like 'synthetic/.test(query)) expect(out).toContain('0 rows');
  });
  it.each(['select value from main.config', 'select value from "main"."config"', 'select value from [main].[config]', 'select value from temp.config'])(
    'a schema-qualified name is refused: %s', async (query) => {
      expect(await q(query)).toMatch(/^Refused: name the config table without a schema/);
    });
  // fix round 2: the real table is refused by what the compiled statement would OPEN, not by its words.
  const SPELLINGS: Array<[string, string]> = [
    ['a quote inside a block comment ahead of the name', "select 1 /* it's */ ; select 1"],
    ['quote-bearing comments around a qualified name', "select value /* ' */ from /* ' */ main.config -- '\n"],
    ['quote in a line comment then a qualified name', "select value from -- it's\n main.config"],
    ['a literal-looking comment hiding the schema', "select value from /* \"x' */ \"main\" /* ' */ . /* ' */ config"],
    ['the name in a UNION arm', "select 1 union all select value from main.config"],
    ['the name in a subquery', "select (select value from main.config where key = 'example_api_key')"],
    ['an alias of the schema', "select c.value from main.config as c"],
    ['bracket and backtick quoting', 'select value from [main] . `config`'],
  ];
  it.each(SPELLINGS)('%s never returns the value', async (_n, query) => {
    const out = await q(query);
    expect(out).not.toContain(SECRET);
  });
  it('the child itself refuses the real table whatever the parent let through', async () => {
    const { readInChild } = await import('../sql-child.js');
    const out = await turnState.runWithToolCallId(AGENT, 'call-direct', async () => {
      cap.attachCallCapability(cap.mintCallCapability({ agentId: AGENT, tool: 'dojo_inspect', callId: 'call-direct', grants: [{ kind: 'proc', program: process.execPath, display: 'node' }] }));
      return readInChild("select value from /* ' */ main.config /* ' */");
    });
    expect(out).toEqual({ error: expect.stringMatching(/reads the real config table/) });
  });
});

