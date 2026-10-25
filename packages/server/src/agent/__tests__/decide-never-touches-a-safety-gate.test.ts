// v3.5 C4 — SAFETY GATES NEVER CONSULT THE DECISION MODEL (the spec's Group C: "keep deterministic, no model, ever").
//
// A decision model reads text, and injected content in the text can shift its answers; a gate that holds a destructive
// command, a privilege escalation, a private-network fetch, a credential, an approval, an inbound's authority or an
// A2A intent must answer the same way for the same input, whatever the input says. So no gate file imports `decide()` or
// anything built on it. This is a census, not a sentence: it reads the files.
//
//   1. DIRECT: none of the gate files imports (statically or dynamically) a module of the decision cluster — `decide`,
//      the shadow log, the policy, the ask helper, and every judgment module built on them (new ones join by name
//      pattern, so a gate cannot be pointed at one by accident).
//   2. THE LEAVES: the gates that import almost nothing (the credential patterns, the net guard, the sudo policy) have
//      a closure of imports that stays clear of the cluster, however deep.
//   3. BEHAVIOUR: with a decision model installed and every judged question proven, the pure gates answer exactly as
//      they always did and no `/v1/systemone` request is made.
//   The bigger gate files (permissions, path guards, the destructive gate, the iMessage commands, the inbox watchers,
//   the A2A tool surface) sit in the one import component with the engine, so a transitive test over them would pass
//   or fail on the whole app; the direct test is the claim, and test 4 pins the list itself.
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
import { installDecisionModel, proveNoul, scriptDecisions, yes } from './decision-fake.js';
import { detectCredentialContent } from '../../vault/credential-gate.js';
import { isPrivateAddress } from '../net-guard.js';
import { isSudoLine, mentionsPrivilegeToken } from '../brokers/sudo-policy.js';
import { INBOUND_ROUTING_PURPOSE } from '../v2/classifiers/inbound-routing.js';

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
/** The leaves: gates small enough that their whole import closure is the claim. */
const LEAVES = ['vault/credential-gate.ts', 'agent/net-guard.ts', 'agent/brokers/sudo-policy.ts'];

/** The decision cluster. `*-judgment` / `inbound-routing` / `reply-claims` are the modules that ask the model for a rule. */
const CLUSTER = /(^|\/)(decide|decision-ask|decision-policy|decision-shadow|decision-provider|inbound-routing|shape-judgment|provider-error-judgment|reply-claims|summary-check[\w-]*)\.ts$/;

const specifiersOf = (file: string): string[] =>
  [...fs.readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
function resolveImport(from: string, spec: string): string | null {
  const p = path.resolve(path.dirname(from), spec).replace(/\.js$/, '');
  return [`${p}.ts`, path.join(p, 'index.ts')].find((c) => fs.existsSync(c)) ?? null;
}
const rel = (f: string): string => path.relative(SRC, f);

function closureReaching(start: string): string | null {
  const parents = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const spec of specifiersOf(cur)) {
      const r = resolveImport(cur, spec);
      if (!r || parents.has(r)) continue;
      parents.set(r, cur);
      if (CLUSTER.test(r)) {
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
  it('the cluster pattern matches the real modules (a rename cannot blind the census)', () => {
    for (const f of ['agent/decide.ts', 'agent/decision-ask.ts', 'agent/decision-policy.ts', 'agent/decision-shadow.ts', 'agent/v2/classifiers/inbound-routing.ts', 'memory/shape-judgment.ts', 'agent/provider-error-judgment.ts']) {
      expect(fs.existsSync(path.join(SRC, f)), f).toBe(true);
      expect(CLUSTER.test(f), f).toBe(true);
    }
  });
});

describe('1. no gate file imports the decision cluster', () => {
  for (const [role, files] of Object.entries(GATES)) {
    for (const f of files) {
      it(`${role}: ${f}`, () => {
        const offenders = specifiersOf(path.join(SRC, f)).map((s) => resolveImport(path.join(SRC, f), s)).filter((r): r is string => !!r && CLUSTER.test(r)).map(rel);
        expect(offenders).toEqual([]);
      });
    }
  }
});

describe('2. the leaf gates reach the decision cluster by no path at all', () => {
  for (const f of LEAVES) it(f, () => { expect(closureReaching(path.join(SRC, f))).toBeNull(); });
  it('the census sees a real chain when there is one (the walker is not blind)', () => {
    expect(closureReaching(path.join(SRC, 'agent/a2a-transport.ts'))).toMatch(/inbound-routing\.ts$/);
  });
});

describe('3. a decision model installed and every judged question proven changes no gate\'s answer and is never called', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations(mockDb.current);
    installDecisionModel(mockDb.current);
    for (const q of ['simple_chat', 'multi_step', 'delegates', 'pleasantry', 'deliverable']) proveNoul(INBOUND_ROUTING_PURPOSE, q);
  });
  afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

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
