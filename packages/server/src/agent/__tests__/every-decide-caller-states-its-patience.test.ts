// t274 fix round 1 (addition) — EVERY decide() CALLER STATES ITS PATIENCE, AND A BACKGROUND ASK CANNOT NAME AN AGENT.
//
// (1) A caller's patience — how long it will wait, counted from when it asks — is a REQUIRED part of `DecideOpts`,
//     so no future caller that waits can wait without a bound: leaving it out does not compile.
// (2) A background (shadow) ask's type cannot take an `agentId`, so it can never open that agent's turn-scoped stop
//     slot and make an idle agent look live. Pinned at the type and at run time.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { decide, type DecideOpts } from '../decide.js';
import { countAbortable } from '../shared-state.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DECIDE = path.resolve(HERE, '../decide.ts');

describe('the type: patience is required, and a background ask names no agent', () => {
  it('a call without patience, or a background ask with an agent, does not compile', () => {
    const probe = path.resolve(HERE, '__decide_opts_probe__.ts');
    const source = `
      import type { DecideOpts } from ${JSON.stringify(DECIDE.replace(/\.ts$/, '.js'))};
      export const waited: DecideOpts = { purpose: 'p', agentId: 'a', patienceMs: 100 };
      export const shadow: DecideOpts = { purpose: 'p', background: true, patienceMs: 100 };
      // @ts-expect-error — no patience stated
      export const unbounded: DecideOpts = { purpose: 'p', agentId: 'a' };
      // @ts-expect-error — no patience stated, background
      export const unboundedShadow: DecideOpts = { purpose: 'p', background: true };
      // @ts-expect-error — a background ask cannot take an agent
      export const liveLooking: DecideOpts = { purpose: 'p', background: true, agentId: 'a', patienceMs: 100 };
    `;
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true, esModuleInterop: true, skipLibCheck: true, noEmit: true, lib: ['lib.es2022.d.ts'], types: ['node'],
    };
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host);
    const exists = host.fileExists.bind(host);
    const get = host.getSourceFile.bind(host);
    host.readFile = (f) => (path.resolve(f) === probe ? source : read(f));
    host.fileExists = (f) => path.resolve(f) === probe || exists(f);
    host.getSourceFile = (f, v, onError, create) => (path.resolve(f) === probe ? ts.createSourceFile(f, source, v) : get(f, v, onError, create));
    const program = ts.createProgram([probe], options, host);
    const diags = ts.getPreEmitDiagnostics(program, program.getSourceFile(probe))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(diags).toEqual([]);
  }, 120_000);
});

describe('at run time: a background ask holds no agent\'s stop slot', () => {
  let release!: () => void;
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations(mockDb.current);
    mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47123', 'none', 1)").run();
    mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, output_cost_per_m, is_enabled)
      VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 262144, 0, 0, 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
    const held = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async () => { await held; return Response.json({ answers: { q: { noul: 0.9 } }, usage: { input_tokens: 5 } }); }));
  });
  afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

  it('even handed an agent at run time, a background call in flight registers nothing for it', async () => {
    const sneaky = { purpose: 'probe', background: true, agentId: 'agent-idle', patienceMs: 5_000 } as unknown as DecideOpts;
    const call = decide({ x: 'shadow' }, { q: { type: 'noul', instructions: 'Is `x` a shadow?' } }, sneaky);
    await new Promise((r) => setTimeout(r, 50));
    expect(countAbortable('agent-idle')).toBe(0);
    release();
    expect(await call).not.toBeNull();
  });

  it('a call somebody waits on does hold that agent\'s slot while it is queued or in flight', async () => {
    const call = decide({ x: 'waited' }, { q: { type: 'noul', instructions: 'Is `x` waited on?' } }, { purpose: 'probe', agentId: 'agent-busy', patienceMs: 5_000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(countAbortable('agent-busy')).toBe(1);
    release();
    expect(await call).not.toBeNull();
    expect(countAbortable('agent-busy')).toBe(0);
  });
});
