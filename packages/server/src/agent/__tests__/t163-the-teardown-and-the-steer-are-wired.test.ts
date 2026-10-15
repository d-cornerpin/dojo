// t163 — THE TWO WIRES THE BEHAVIOUR CLAUSES CANNOT SEE FROM THE OUTSIDE.
//
// `t163-a-delegated-answer-reaches-the-owner-once.test.ts` drives the behaviour through the real
// runtime, transport, finalize and settlement. Two of its inputs are produced by code that test
// scripts around, so they are pinned here by SHAPE (comments stripped first, so prose about the
// call is never read as the call — G4):
//   1. the runtime's teardown releases the held relays — on the `finally` path (so a dying turn
//      still delivers), after the run has been released and BEFORE the compile drive looks at the
//      same join, and applied to this agent;
//   2. the owed-interrupt steer writes the "ask was shown to the model" mark before it files the
//      steer, for exactly the asks it quotes.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { engineFileContaining } from '../v2/__tests__/engine-sources.js';

const SRC = path.resolve(__dirname, '..', '..');
const strip = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
const code = (rel: string): string => strip(fs.readFileSync(path.join(SRC, rel), 'utf8'));

describe('t163 wire 1 — the runtime teardown releases the held relays', () => {
  const rt = code('agent/runtime.ts');
  const release = rt.indexOf('releaseDeferredJoinRelays(agentId)');
  const runReleased = rt.indexOf('activeRuns.delete(agentId);');
  const compileDrive = rt.indexOf('resolveCompilePendingJoins(agentId)');

  it('is called, once, with the agent whose run just ended', () => {
    expect(release).toBeGreaterThan(-1);
    expect(rt.indexOf('releaseDeferredJoinRelays(', release + 1)).toBe(-1);
  });

  it('sits in the finally, after the run is released and before the compile drive reads the same join', () => {
    const finallyAt = rt.lastIndexOf('} finally {', release);
    expect(finallyAt, 'inside the handleMessage finally').toBeGreaterThan(-1);
    expect(runReleased).toBeGreaterThan(finallyAt);
    expect(release).toBeGreaterThan(runReleased);
    expect(compileDrive).toBeGreaterThan(release);
  });

  it('a release that throws cannot skip the rest of the teardown (it is inside its own try/catch)', () => {
    const before = rt.slice(Math.max(0, release - 200), release);
    expect(before).toMatch(/try\s*\{\s*await \(await import\('\.\/a2a-transport\.js'\)\)\.$/);
    expect(rt.slice(release, release + 400)).toMatch(/\}\s*catch \(err\)/);
  });
});

describe('t163 wire 2 — the owed-interrupt steer marks the asks it shows the model', () => {
  // The engine step that files the steer, found through the shared derivation of the engine corpus.
  const step = strip(engineFileContaining('recordOwedAskShown(')!.text);
  const mark = step.indexOf('recordOwedAskShown(');
  const steerCall = step.indexOf('persistEngineSteer(\n');

  it('records the mark for exactly the owed asks it quotes, before the steer is filed', () => {
    expect(mark).toBeGreaterThan(-1);
    expect(step.slice(mark, mark + 120)).toContain('owed.map((m) => m.id)');
    expect(steerCall).toBeGreaterThan(mark);
  });

  it('and only on the pass that steers — not on the record-only pass', () => {
    const maySteerGate = step.indexOf('if (!maySteer) return proceed(state);');
    expect(maySteerGate).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(maySteerGate);
  });
});
