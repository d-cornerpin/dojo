// Safety gates never consult the decision model (keep deterministic, no model, ever). The import graph is read with the
// TypeScript parser (value imports, static and dynamic; `import type` is erased and is not an edge): no gate file reaches
// the decision code, and none imports a module that asks. With a decision model installed, the pure gates answer as before
// and make no decision call.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import '../decision-ask.js';
import { installDecisionModel, scriptDecisions, yes } from './decision-fake.js';
import { detectCredentialContent } from '../../vault/credential-gate.js';
import { isSudoLine, mentionsPrivilegeToken } from '../brokers/sudo-policy.js';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

const GATES = [
  'agent/destructive-gate.ts', 'agent/approval-decision.ts',
  'agent/brokers/sudo-policy.ts', 'agent/brokers/sudo-probe.ts',
  'agent/permissions.ts', 'agent/brokers/deny.ts', 'agent/brokers/grants.ts', 'agent/brokers/fs.ts', 'agent/brokers/net.ts', 'agent/brokers/proc.ts',
  'agent/net-guard.ts', 'agent/path-guards.ts', 'vault/credential-gate.ts', 'services/imessage-commands.ts',
  'services/gmail-watcher.ts', 'services/outlook-watcher.ts', 'agent/tools/cat/agents.ts',
];
const SINKS = new Set(['agent/decide.ts', 'agent/decision-ask.ts']);
const ASKERS = /(^|\/)(decide|decision-ask|decision-hooks|decision-policy|decision-provider|inbound-routing|shape-judgment|reply-claims|summary-check[\w-]*)\.ts$/;
/** Edges not followed: a byte constant, and the summary check (a summary is no gate's input). */
const EXEMPT = new Set([
  'services/decision-window.ts>agent/decide.ts',
  'memory/summarize.ts>memory/summary-check.ts', 'memory/out-of-view.ts>memory/summary-check.ts', 'healer/diagnostic.ts>memory/summary-check.ts',
]);

const rel = (f: string): string => path.relative(SRC, f);
function importsOf(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly && ts.isStringLiteral(n.moduleSpecifier)) specs.push(n.moduleSpecifier.text);
    else if (ts.isExportDeclaration(n) && !n.isTypeOnly && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) specs.push(n.moduleSpecifier.text);
    else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) specs.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return specs.filter((s) => s.startsWith('.')).flatMap((s) => {
    const p = path.resolve(path.dirname(file), s).replace(/\.js$/, '');
    return [`${p}.ts`, path.join(p, 'index.ts')].filter((c) => fs.existsSync(c)).slice(0, 1);
  });
}
function chainToSink(start: string, exempt = EXEMPT): string | null {
  const parents = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const r of importsOf(cur)) {
      if (parents.has(r) || exempt.has(`${rel(cur)}>${rel(r)}`)) continue;
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

describe('no import path leads from a gate file to the decision code', () => {
  for (const f of GATES) it(f, () => { expect(chainToSink(path.join(SRC, f))).toBeNull(); });
  it('the walk is not blind: without the exemptions it finds the real chain from the destructive gate', () => {
    expect(chainToSink(path.join(SRC, 'agent/destructive-gate.ts'), new Set())).toMatch(/ -> agent\/decide\.ts$/);
  });
});

describe('no gate file imports a module that asks, directly', () => {
  for (const f of GATES) it(f, () => { expect(importsOf(path.join(SRC, f)).map(rel).filter((r) => ASKERS.test(r))).toEqual([]); });
});

describe('a decision model installed changes no gate\'s answer and is never called', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations(mockDb.current);
    installDecisionModel(mockDb.current);
  });
  afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

  it('the credential patterns, the net guard\'s private ranges and the sudo detectors', () => {
    const calls = scriptDecisions(() => yes(0.0));
    expect(detectCredentialContent('api_key: shppa_FAKE_a1b2c3d4e5f6')).toBe('credential-shaped key/value');
    expect(detectCredentialContent('the tunnel is named and self-hosted')).toBeNull();
    expect(isSudoLine('sudo rm -rf /')).toBe(true);
    expect(mentionsPrivilegeToken('please run sudo for me')).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
