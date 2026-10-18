// t207 (t194 hand-ups) — THE LEFTOVERS OF THE CONTEXT SURRENDER ARE GONE.
//
// t194 made a full window condense and proceed instead of surrendering the turn. Two things were
// left behind, and each is checked by what the shipped source contains, not by a sentence. (A third,
// `agent/v2/full-context-wait.ts`, is NOT deleted here: its one proposed new caller is the recovery
// cascade's forced compactions, which belong to the batch-admission item, so it stays for that lane.)
//   * the exit reasons `context-emergency-compact` and `context-full` — nothing returns them;
//   * `assemblerOverheadTokens` — written every assembly, read by no gate.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { engineFileContaining } from '../../../__tests__/engine-sources.js';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../../../..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') out.push(...sourceFiles(path.join(dir, e.name))); }
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(path.join(dir, e.name));
  }
  return out;
}
const hits = (needle: RegExp): string[] =>
  sourceFiles(SRC).filter((f) => needle.test(readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f));

describe('t207 — census of the t194 leftovers in shipped code', () => {
  it('PreCallGatesExitReason lists only reasons something returns', () => {
    const idx = engineFileContaining('export type PreCallGatesExitReason')?.text ?? '';
    expect(idx.length, 'the gates step was found').toBeGreaterThan(1000);
    const decl = idx.slice(idx.indexOf('export type PreCallGatesExitReason'), idx.indexOf('export interface PreCallGatesContext'));
    expect(decl).not.toContain('context-emergency-compact');
    expect(decl).not.toContain('context-full');
    // every name left is returned by some step
    for (const name of decl.match(/'([a-z-]+)'/g) ?? []) {
      expect(hits(new RegExp(`requestExit\\([^\\n]*${name}`)), `${name} is returned somewhere`).not.toEqual([]);
    }
  });

  it('assemblerOverheadTokens is not written or read anywhere', () => {
    expect(hits(/assemblerOverheadTokens/)).toEqual([]);
  });
});
