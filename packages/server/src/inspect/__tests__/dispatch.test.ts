// v3.5 inspect C1 — dojo_inspect on the wire: one definition, one dispatcher, eight views.
//
// The views are mocked here: their own suites own what they print. What this file holds is the
// wire: each `what` reaches its view with that view's own arguments, `sql` is AWAITED (it runs in
// a child process), the code views run under the calling agent's id (its stop button), the
// definition names exactly the arguments the views read, the docs cover them, and the one program
// the tool spawns is declared and carried, from one call site.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../timeline.js', () => ({ timeline: vi.fn(() => 'TIMELINE') }));
vi.mock('../conversation.js', () => ({ conversation: vi.fn(() => 'CONVERSATION') }));
vi.mock('../logs.js', () => ({ logs: vi.fn(() => 'LOGS') }));
vi.mock('../state.js', () => ({ state: vi.fn(() => 'STATE') }));
vi.mock('../schema.js', () => ({ schema: vi.fn(() => 'SCHEMA') }));
// A real query answers later than the call that started it: the dispatcher must wait for it.
vi.mock('../sql.js', () => ({ sql: vi.fn(() => new Promise<string>((r) => setTimeout(() => r('SQL-ROWS'), 5))) }));
vi.mock('../code.js', () => ({ codeSearch: vi.fn(async () => 'SEARCH'), codeRead: vi.fn(async () => 'READ') }));

import { dojoInspect } from '../index.js';
import { INSPECT_VIEWS, dojoInspectDefinition } from '../definition.js';
import { timeline } from '../timeline.js';
import { conversation } from '../conversation.js';
import { logs } from '../logs.js';
import { state } from '../state.js';
import { schema } from '../schema.js';
import { sql } from '../sql.js';
import { codeSearch, codeRead } from '../code.js';
import { effectsFor } from '../../agent/tools/registry.js';
import { handlerFor } from '../../agent/tools/handlers.js';
import { CARRIED_PROGRAMS, grantsForCall } from '../../agent/effects/scopes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');
const AGENT = 'agent-inspect-dispatch';

beforeEach(() => vi.clearAllMocks());

describe('the dispatcher: what → view', () => {
  it('timeline gets its scope and window; a turn sent as text is a number', async () => {
    const out = await dojoInspect({ what: 'timeline', agent: 'a1', task_id: 't1', project_id: 'p1', turn: '12', conversation: 'c1',
      since: '2026-10-01', until: '2026-10-02', around: 'm1', include: ['tools', 'logs'], query: 'ignored' }, AGENT);
    expect(out).toBe('TIMELINE');
    expect(timeline).toHaveBeenCalledWith({ agent: 'a1', task_id: 't1', project_id: 'p1', turn: 12, conversation: 'c1',
      since: '2026-10-01', until: '2026-10-02', around: 'm1', include: ['tools', 'logs'] });
  });

  it('conversation, logs, state and schema get exactly their own arguments', async () => {
    expect(await dojoInspect({ what: 'conversation', agent: 'a2', since: 's', until: 'u', around: 'm', pattern: 'p', include_engine: false }, AGENT)).toBe('CONVERSATION');
    expect(conversation).toHaveBeenCalledWith({ agent: 'a2', since: 's', until: 'u', around: 'm', pattern: 'p', include_engine: false });
    expect(await dojoInspect({ what: 'logs', since: 's', until: 'u', around: 'm', level: 'warn', component: 'engine', agent: 'a3', pattern: 'p', tail: '50' }, AGENT)).toBe('LOGS');
    expect(logs).toHaveBeenCalledWith({ since: 's', until: 'u', around: 'm', level: 'warn', component: 'engine', agent: 'a3', pattern: 'p', tail: 50 });
    expect(await dojoInspect({ what: 'state' }, AGENT)).toBe('STATE');
    expect(state).toHaveBeenCalledWith();
    expect(await dojoInspect({ what: 'schema', table: 'work' }, AGENT)).toBe('SCHEMA');
    expect(schema).toHaveBeenCalledWith({ table: 'work' });
  });

  it('sql is awaited: the answer is the rows, not a pending promise', async () => {
    const out = await dojoInspect({ what: 'sql', query: 'select 1' }, AGENT);
    expect(out).toBe('SQL-ROWS');
    expect(sql).toHaveBeenCalledWith({ query: 'select 1' });
  });

  it('the code views run under the calling agent, so its stop button ends their GitHub calls', async () => {
    expect(await dojoInspect({ what: 'code_search', pattern: 'taskMovedAtSql', path: 'packages/server' }, AGENT)).toBe('SEARCH');
    expect(codeSearch).toHaveBeenCalledWith({ pattern: 'taskMovedAtSql', path: 'packages/server' }, AGENT);
    expect(await dojoInspect({ what: 'code_read', path: 'packages/server/src/index.ts', from: '3', to: 9 }, AGENT)).toBe('READ');
    expect(codeRead).toHaveBeenCalledWith({ path: 'packages/server/src/index.ts', from: 3, to: 9 }, AGENT);
  });

  it('an unknown or missing what names the eight views and reaches none', async () => {
    for (const what of ['tables', undefined, 7]) {
      const out = await dojoInspect({ what }, AGENT);
      for (const v of INSPECT_VIEWS) expect(out).toContain(v);
    }
    for (const view of [timeline, conversation, logs, state, schema, sql, codeSearch, codeRead]) expect(view).not.toHaveBeenCalled();
  });
});

describe('the definition on the wire', () => {
  const props = dojoInspectDefinition.input_schema.properties as Record<string, { enum?: string[] }>;

  it('is one tool, what = one of eight, and every argument is one a view reads', () => {
    expect(dojoInspectDefinition.name).toBe('dojo_inspect');
    expect([...INSPECT_VIEWS]).toEqual(['timeline', 'conversation', 'logs', 'state', 'schema', 'sql', 'code_search', 'code_read']);
    expect(props.what.enum).toEqual([...INSPECT_VIEWS]);
    expect(dojoInspectDefinition.input_schema.required).toEqual(['what']);
    expect(Object.keys(props).sort()).toEqual(['agent', 'around', 'component', 'conversation', 'from', 'include', 'include_engine', 'level',
      'path', 'pattern', 'project_id', 'query', 'since', 'table', 'tail', 'task_id', 'to', 'turn', 'until', 'what'].sort());
  });

  it('declares no result cap: a long answer is kept whole and read by range (t200), never cut', () => {
    expect(dojoInspectDefinition.maxResultTokens).toBeUndefined();
  });

  it('the registry serves it: its declared effects and its handler', () => {
    expect(effectsFor('dojo_inspect')).toBe(dojoInspectDefinition.effects);
    expect(handlerFor('dojo_inspect')).toBeTypeOf('function');
  });

  it('the long form lives behind load_tool_docs and covers every view and every argument', () => {
    const doc = fs.readFileSync(path.join(SRC, 'tools/docs/dojo_inspect.md'), 'utf-8');
    for (const v of INSPECT_VIEWS) expect(doc, v).toContain(`\`${v}\``);
    for (const p of Object.keys(props)) expect(doc, p).toMatch(new RegExp(`\\*\\*${p}\\*\\*`));
  });
});

describe('the one program it spawns: node, for the sql child (t253 hand-up)', () => {
  it('declares process.execPath, ABSOLUTE, as its proc program', () => {
    expect(path.isAbsolute(process.execPath)).toBe(true);
    const proc = dojoInspectDefinition.effects.filter((e) => e.kind === 'proc');
    expect(proc).toHaveLength(1);
    expect(proc[0].scope).toEqual({ at: 'program', program: process.execPath });
  });

  it('is carried by name with its reason, so the derived grant is minted rather than silently dropped', () => {
    const reason = CARRIED_PROGRAMS[process.execPath];
    expect(reason, 'CARRIED_PROGRAMS has no entry keyed by process.execPath').toBeTypeOf('string');
    expect(reason).toMatch(/argv is the fixed inline child source; the query is stdin data/);
    expect(grantsForCall(AGENT, effectsFor('dojo_inspect') ?? [], { what: 'sql', query: 'select 1' }))
      .toContainEqual({ kind: 'proc', program: process.execPath, display: process.execPath });
  });

  it('has ONE call site: only the sql child spawns node under this grant', () => {
    const sites: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '__tests__' || e.name === 'node_modules' || e.name === 'dist') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts') && /spawnAuthorized\(\s*process\.execPath/.test(fs.readFileSync(full, 'utf-8'))) sites.push(path.relative(SRC, full));
      }
    };
    walk(SRC);
    expect(sites).toEqual(['inspect/sql-child.ts']);
  });
});
