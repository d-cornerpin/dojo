// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 E19 + E19b — ONE RUNNER FOR EVERY PLATFORM PROGRAM THE OWNER'S STOP CAN CUT.
//
// Two lanes each moved a set of synchronous program calls onto an async runner bound to the Stop:
// the screen-control tools (`agent/system-control-run.ts`) and the iMessage sends
// (`services/imessage-run.ts`). The two runners were near copies, and they had drifted: the
// screen-control one started its program even when the Stop was already standing (and then cut
// it — a click could land first), never escalated a bound to SIGKILL (a program that ignores
// SIGTERM stayed pending), and quoted the whole argv in its error (an agent's typed text, in the
// log and the tool result). There is now ONE runner (`agent/stop-bound-run.ts`); both
// callers use it, and these clauses hold each caller to it, with planted stand-ins only.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));
const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => emptyStmt, exec: () => undefined, transaction: (fn: () => unknown) => fn }),
}));

import { runBoundToTheStop, wasNeverStarted } from '../stop-bound-run.js';
import { notifyUserStop, stopWaiterCount } from '../stop-waiters.js';
import { stoppedAgents } from '../shared-state.js';
import { hidHandlers } from '../tools/cat/hid.js';
import type { ToolCall } from '@dojo/shared';

vi.setConfig({ testTimeout: 30_000 });

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT = 'agent-one-runner';
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'one-runner-bin-'));
const PIDS = path.join(BIN, 'pids');
const ORIGINAL_PATH = process.env.PATH;
const realSetTimeout = globalThis.setTimeout;   // captured before any test fakes timers

beforeAll(() => {
  fs.writeFileSync(path.join(BIN, 'cliclick'), '#!/bin/sh\necho $$ >> "$ONE_RUNNER_PIDS"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(BIN, 'deaf'), '#!/bin/sh\necho $$ >> "$ONE_RUNNER_PIDS"\ntrap "" TERM\nwhile :; do sleep 1; done\n', { mode: 0o755 });
  fs.writeFileSync(path.join(BIN, 'deaf-ready'), '#!/bin/sh\ntrap "" TERM\necho $$ >> "$ONE_RUNNER_PIDS"\nwhile :; do sleep 1; done\n', { mode: 0o755 });
  fs.writeFileSync(path.join(BIN, 'quits-on-term'), '#!/bin/sh\necho $$ >> "$ONE_RUNNER_PIDS"\nwhile :; do sleep 1; done\n', { mode: 0o755 });
  process.env.PATH = `${BIN}:${ORIGINAL_PATH}`;
  process.env.ONE_RUNNER_PIDS = PIDS;
});
afterEach(() => {
  stoppedAgents.delete(AGENT);
  for (const pid of pids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(PIDS, { force: true });
});
afterAll(() => { process.env.PATH = ORIGINAL_PATH; fs.rmSync(BIN, { recursive: true, force: true }); });

function pids(): number[] {
  try { return fs.readFileSync(PIDS, 'utf8').trim().split('\n').filter(Boolean).map(Number); } catch { return []; }
}
async function untilChildIsListening(): Promise<void> {
  for (let i = 0; i < 500 && pids().length === 0; i++) await new Promise<void>((r) => realSetTimeout(r, 10));
  expect(pids().length, 'the stand-in announced itself').toBe(1);
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const source = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** Source with comments removed, so prose about a call cannot satisfy or fail a clause. */
const code = (rel: string): string => source(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(path.relative(SRC, p));
  }
  return out;
}

describe('one runner for every platform program the Stop can cut', () => {
  it('both callers run their programs through the one runner, and neither spawns its own', () => {
    expect(fs.existsSync(path.join(SRC, 'agent/system-control-run.ts')), 'the screen-control copy is gone').toBe(false);
    for (const caller of ['agent/system-control.ts', 'services/imessage-run.ts']) {
      expect(source(caller), caller).toMatch(/import \{[^}]*\brunBoundToTheStop\b[^}]*\} from '(?:\.\/|\.\.\/agent\/)stop-bound-run\.js'/);
      expect(code(caller), `${caller} spawns a program of its own`).not.toMatch(/\bspawn\(/);
    }
    // Every child a Stop ends is bound in one of two places: the toolbox's facade, or this runner.
    const binders = walk(SRC).filter((f) => /\bendsWithTheStop\(/.test(code(f)) && f !== 'agent/effects/proc-tree.ts').sort();
    expect(binders).toEqual(['agent/effects/proc.ts', 'agent/stop-bound-run.ts']);
  });

  it('screen control: with the Stop already standing, the program never starts (no click can land first)', async () => {
    stoppedAgents.add(AGENT);
    const tc = { id: 'call-type', name: 'keyboard_type', arguments: { text: 'the crate count' } } as unknown as ToolCall;
    const out = await hidHandlers.keyboard_type({ agentId: AGENT, name: 'keyboard_type', args: { text: 'the crate count' }, callId: tc.id, toolCall: tc });
    await new Promise((r) => setTimeout(r, 300));
    expect(pids(), 'the stand-in never ran').toEqual([]);
    expect(JSON.stringify(out)).toMatch(/not started/);
    expect(JSON.stringify(out), 'the agent\'s typed text is not quoted back in the error').not.toContain('the crate count');
    expect(stopWaiterCount(AGENT)).toBe(0);
  });

  it('the runner: a program that ignores SIGTERM at its bound is killed after the grace (the screen-control shape, with stdin)', async () => {
    const t0 = Date.now();
    await expect(runBoundToTheStop(path.join(BIN, 'deaf'), [], { timeout: 200, agentId: AGENT, input: 'tell application "Finder" to quit' }))
      .rejects.toThrow(/timed out after 200 ms/);
    expect(Date.now() - t0, 'ended by the kill after its grace').toBeLessThan(10_000);
    expect(pids().length).toBe(1);
    expect(alive(pids()[0]), 'the deaf program is gone').toBe(false);
    expect(stopWaiterCount(AGENT)).toBe(0);
  });

  it('the runner: a Stop and the time bound on one run arm one SIGKILL follow-up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });   // only these two: the helper above needs the real clock
    try {
      const p = runBoundToTheStop(path.join(BIN, 'deaf-ready'), [], { timeout: 200, agentId: AGENT });
      const rejection = p.then(() => null, (e: unknown) => e);   // handled before anything rejects
      await untilChildIsListening();                              // the program now ignores SIGTERM
      notifyUserStop(AGENT);
      await vi.advanceTimersByTimeAsync(200);                     // the run's own bound fires as well
      expect(vi.getTimerCount(), 'Stop plus the time bound arm one SIGKILL follow-up, not one per path').toBe(1);
      await vi.advanceTimersByTimeAsync(3_000);                   // the grace passes: SIGKILL
      expect(await rejection, 'the deaf program is gone').toBeInstanceOf(Error);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('the runner: no SIGKILL follow-up is left pending once the child has exited', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const p = runBoundToTheStop(path.join(BIN, 'quits-on-term'), [], { timeout: 200, agentId: AGENT });
      const rejection = p.then(() => null, (e: unknown) => e);
      await untilChildIsListening();
      await vi.advanceTimersByTimeAsync(200);                     // the bound fires: SIGTERM, one follow-up armed; the program quits on SIGTERM
      expect(await rejection, 'ended by its bound').toBeInstanceOf(Error);
      expect(vi.getTimerCount(), 'the follow-up was cleared when the child exited').toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('the runner: a throwing spawn releases the waiter; a standing Stop rejects as never started', async () => {
    await expect(runBoundToTheStop('stand\0in', [], { timeout: 1_000, agentId: AGENT })).rejects.toThrow();
    expect(stopWaiterCount(AGENT)).toBe(0);
    stoppedAgents.add(AGENT);
    const err = await runBoundToTheStop(path.join(BIN, 'cliclick'), ['c:1,1'], { timeout: 1_000, agentId: AGENT }).catch((e: unknown) => e);
    expect(wasNeverStarted(err)).toBe(true);
    expect(pids()).toEqual([]);
  });
});
