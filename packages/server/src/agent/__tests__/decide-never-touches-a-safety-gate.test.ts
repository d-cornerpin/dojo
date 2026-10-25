// v3.5 C4 — SAFETY GATES NEVER CONSULT THE DECISION MODEL (the spec's Group C: "keep deterministic, no model, ever").
//
// A decision model reads text, and injected content in the text can shift its answers; a gate that holds a destructive
// command, a privilege escalation, a private-network fetch, a credential, an approval, an inbound's authority or an
// A2A intent must answer the same way for the same input, whatever the input says. This is a census, not a sentence:
// it reads the files.
//
//   1. TRANSITIVE: walk the import graph (value imports, static and dynamic; `import type` is erased and not an edge)
//      from every gate file. No path may reach `agent/decide.ts` or `agent/decision-ask.ts`. The engine files the
//      gates import for other reasons (spawner, runtime, the iMessage bridge, the A2A transport) ask the decision
//      model only through the leaf `agent/decision-hooks.ts`, which imports nothing, so no path runs through them.
//      Six edges are declared, not hidden (EXEMPT_EDGES, each argued): `decision-window.ts` imports the measured
//      request-size CONSTANT from `decide.ts` (a number, never a call); the two doors into the B4 summary check and the
//      three into the reply-claim floors' module (each consults the model about a summary or a reply, neither of which
//      is a gate's input). A new edge must be argued there.
//   2. DIRECT: no gate file imports any module that asks (the judgment modules, the shadow log, the policy, the hooks).
//   3. THE LEAF: `decision-hooks.ts` imports nothing of the engine; `decision-ask.ts` is imported only by the server's boot.
//   4. BEHAVIOUR: with a decision model installed and every judged question proven, the pure gates answer exactly as
//      they always did and no `/v1/systemone` request is made.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { decisionAsksSettled } from '../decision-ask.js';
import { installDecisionModel, proveNoul, scriptDecisions, yes } from './decision-fake.js';
import { detectCredentialContent } from '../../vault/credential-gate.js';
import { isPrivateAddress } from '../net-guard.js';
import { isSudoLine, mentionsPrivilegeToken } from '../brokers/sudo-policy.js';
import { INBOUND_ROUTING_PURPOSE } from '../v2/classifiers/inbound-routing.js';
import { MEMORY_SHAPE_PURPOSE } from '../../memory/shape-judgment.js';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

/** Group C: every gate file, by the role it plays (paths under src/). */
const GATES: Record<string, string[]> = {
  'destructive commands held for approval': ['agent/destructive-gate.ts', 'agent/approval-decision.ts'],
  'the sudo / privilege policy (a list, not a heuristic)': ['agent/brokers/sudo-policy.ts', 'agent/brokers/sudo-claim.ts', 'agent/brokers/sudo-probe.ts'],
  'permissions and the deny lists': ['agent/permissions.ts', 'agent/brokers/deny.ts', 'agent/brokers/grants.ts', 'agent/brokers/fs.ts', 'agent/brokers/net.ts', 'agent/brokers/proc.ts'],
  'the net guard': ['agent/net-guard.ts'],
  'the path guards': ['agent/path-guards.ts'],
  'the vault credential patterns': ['vault/credential-gate.ts'],
  'iMessage approve / deny commands': ['services/imessage-commands.ts'],
  'the Gmail / Outlook direct-to-agent rule': ['services/gmail-watcher.ts', 'services/outlook-watcher.ts'],
  'the A2A intent validation': ['agent/tools/cat/agents.ts'],
};

/** The decision code: what a gate must not reach. */
const SINKS = new Set(['agent/decide.ts', 'agent/decision-ask.ts']);
/** Modules that ASK (a gate must not import one even indirectly, and not at all directly). New judgment modules join by name. */
const ASKERS = /(^|\/)(decide|decision-ask|decision-hooks|decision-policy|decision-shadow|decision-provider|inbound-routing|shape-judgment|provider-error-judgment|reply-claims|summary-check[\w-]*)\.ts$/;
/** Edges the walk does not follow, each argued. */
const EXEMPT_EDGES: Array<{ from: string; to: string; why: string }> = [
  { from: 'services/decision-window.ts', to: 'agent/decide.ts', why: 'imports MAX_DECISION_BODY_BYTES, a measured byte constant (the 64 KiB limit of one request); it never calls decide(), and a number cannot consult a model.' },
  // The summary check (v3.5 B4, shipped before this census) consults the model about a SUMMARY. The gates reach it only
  // because they import the runtime that writes summaries; nothing it asks is a gate's input. Declared, not hidden.
  { from: 'memory/summarize.ts', to: 'memory/summary-check.ts', why: 'the one door every summary is written through asks the B4 summary check; a summary is not a gate\'s input.' },
  // The reply-claim floors (v3.5 C1) ask the model what the agent's own REPLY claims. They run after a model call, inside
  // the runtime the gates also import; a reply is never a gate's input (the ledger still decides what was sent or saved).
  ...['reply-floors', 'no-reply', 'promise-floor'].map((f) => ({
    from: `agent/v2/steps/post-call-classify/${f}.ts`, to: 'agent/v2/reply-claims.ts', why: 'the nine reply-claim floors; a reply is no gate\'s input and the ledger still decides.',
  })),
  { from: 'memory/out-of-view-fold.ts', to: 'memory/summary-check.ts', why: 'reads whether a summary was refused (a ledger read) from the B4 summary check; a summary is not a gate\'s input.' },
];

const strip = (text: string): string => text.replace(/^\s*(?:import|export)\s+type\s[^;]*?from\s+['"][^'"]+['"];?/gms, '');
const specifiersOf = (file: string): string[] =>
  [...strip(fs.readFileSync(file, 'utf8')).matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
function resolveImport(from: string, spec: string): string | null {
  const p = path.resolve(path.dirname(from), spec).replace(/\.js$/, '');
  return [`${p}.ts`, path.join(p, 'index.ts')].find((c) => fs.existsSync(c)) ?? null;
}
const rel = (f: string): string => path.relative(SRC, f);
const importsOf = (file: string): string[] => specifiersOf(file).map((s) => resolveImport(file, s)).filter((r): r is string => !!r);

/** The shortest import chain from `start` to a sink, or null. `exempt` lists the edges not followed. */
function chainToSink(start: string, exempt = EXEMPT_EDGES): string | null {
  const skip = new Set(exempt.map((e) => `${e.from}>${e.to}`));
  const parents = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const r of importsOf(cur)) {
      if (parents.has(r) || skip.has(`${rel(cur)}>${rel(r)}`)) continue;
      parents.set(r, cur);
      if (SINKS.has(rel(r))) {
        const chain: string[] = [];
        for (let c: string | null = r; c; c = parents.get(c) ?? null) chain.unshift(rel(c));
        return chain.join(' -> ');
      }
      queue.push(r);
    }
  }
  return null;
}

describe('the gate files exist and are the ones named', () => {
  it('every file in the list is a real file (a renamed gate cannot slip out of the census)', () => {
    for (const files of Object.values(GATES)) for (const f of files) expect(fs.existsSync(path.join(SRC, f)), f).toBe(true);
  });
  it('the sinks and the asker pattern match the real modules (a rename cannot blind the census)', () => {
    for (const f of SINKS) expect(fs.existsSync(path.join(SRC, f)), f).toBe(true);
    for (const f of ['agent/decision-hooks.ts', 'agent/decision-policy.ts', 'agent/decision-shadow.ts', 'agent/v2/classifiers/inbound-routing.ts', 'memory/shape-judgment.ts', 'agent/provider-error-judgment.ts']) {
      expect(fs.existsSync(path.join(SRC, f)), f).toBe(true);
      expect(ASKERS.test(f), f).toBe(true);
    }
    for (const e of EXEMPT_EDGES) expect(importsOf(path.join(SRC, e.from)).map(rel), e.why).toContain(e.to);   // a stale exemption fails
  });
});

describe('1. no import path leads from a gate file to the decision code', () => {
  for (const [role, files] of Object.entries(GATES)) {
    for (const f of files) {
      it(`${role}: ${f}`, () => { expect(chainToSink(path.join(SRC, f))).toBeNull(); });
    }
  }
  it('the walk is not blind: with the declared exemption removed it finds the real chain from the destructive gate', () => {
    expect(chainToSink(path.join(SRC, 'agent/destructive-gate.ts'), [])).toMatch(/services\/decision-window\.ts -> agent\/decide\.ts$/);
  });
  it('the walk follows a dynamic import: the engine\'s own asker is found from the server\'s boot', () => {
    expect(chainToSink(path.join(SRC, 'index.ts'))).toMatch(/agent\/decision-ask\.ts$/);
  });
});

describe('2. no gate file imports a module that asks, directly', () => {
  for (const [role, files] of Object.entries(GATES)) {
    for (const f of files) {
      it(`${role}: ${f}`, () => { expect(importsOf(path.join(SRC, f)).filter((r) => ASKERS.test(rel(r))).map(rel)).toEqual([]); });
    }
  }
});

describe('3. the leaf stays a leaf and the real seam is installed only by the boot', () => {
  it('`decision-hooks.ts` imports nothing of the engine (its type imports are erased)', () => {
    expect(importsOf(path.join(SRC, 'agent/decision-hooks.ts'))).toEqual([]);
  });
  it('the modules that pair a rule with the decision model import the leaf, never `decide` or `decision-ask`', () => {
    for (const f of ['agent/v2/classifiers/inbound-routing.ts', 'memory/shape-judgment.ts', 'agent/provider-error-judgment.ts']) {
      expect(importsOf(path.join(SRC, f)).map(rel).filter((r) => SINKS.has(r)), f).toEqual([]);
    }
  });
  it('`decision-ask.ts` is imported by the server\'s boot', () => {
    expect(importsOf(path.join(SRC, 'index.ts')).map(rel)).toContain('agent/decision-ask.ts');
  });
});

describe('4. a decision model installed and every judged question proven changes no gate\'s answer and is never called', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations(mockDb.current);
    installDecisionModel(mockDb.current);
    for (const q of ['simple_chat', 'multi_step', 'delegates', 'pleasantry', 'deliverable']) proveNoul(INBOUND_ROUTING_PURPOSE, q);
    for (const q of ['standing_instruction', 'prose_shaped', 'obligation', 'filler', 'worth_summary']) proveNoul(MEMORY_SHAPE_PURPOSE, q);
  });
  afterEach(async () => { await decisionAsksSettled(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

  it('the credential patterns, the net guard\'s private ranges and the sudo detectors', () => {
    const calls = scriptDecisions(() => yes(0.0));   // a model that would wave everything through
    expect(detectCredentialContent('api_key: shppa_FAKE_a1b2c3d4e5f6')).toBe('credential-shaped key/value');
    expect(detectCredentialContent('the tunnel is named and self-hosted')).toBeNull();
    expect(isPrivateAddress('10.0.0.5')).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isSudoLine('sudo rm -rf /')).toBe(true);
    expect(mentionsPrivilegeToken('please run sudo for me')).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
