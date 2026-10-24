// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 E19 — STOP CANCELS AN IN-FLIGHT SCREEN-CONTROL CALL.
//
// The defect, at the base: every screen and keyboard tool ran its program with `execFileSync`
// (`agent/system-control.ts`). The stop race (`v2/steps/execute/stop-race.ts`) races the tool
// against the owner's Stop, but a synchronous child holds the event loop, so the Stop could not
// even be observed until the child returned or hit its bound (five minutes for AppleScript), and
// nothing ended the child.
//
// Driven through the real stop race, the real tool handlers (`tools/cat/hid.ts`) and the real Stop
// door for waiters (`notifyUserStop`, which `stopAgent` calls), against real processes: stand-ins
// for `cliclick` and `osascript` on PATH that record their pid and sleep.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cards = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: Record<string, unknown>) => { cards.push(e); } }));
const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => emptyStmt, exec: () => undefined, transaction: (fn: () => unknown) => fn }),
}));

import { runUnlessStopped, CANCELLED_BY_STOP } from '../v2/steps/execute/stop-race.js';
import { notifyUserStop, stopWaiterCount } from '../stop-waiters.js';
import { hidHandlers } from '../tools/cat/hid.js';
import { classifyToolResult } from '../tool-outcome.js';
import type { ToolCall } from '@dojo/shared';

vi.setConfig({ testTimeout: 30_000 });

const AGENT = 'agent-e19-hid';
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'e19-hid-bin-'));
const PIDS = path.join(BIN, 'pids');
const GRANDCHILD = path.join(BIN, 'grandchild');
const ORIGINAL_PATH = process.env.PATH;

beforeAll(() => {
  for (const program of ['cliclick', 'osascript']) {
    const p = path.join(BIN, program);
    // E19_FORK: the stand-in starts a child of its own first (an AppleScript's `do shell script` job).
    fs.writeFileSync(p, '#!/bin/sh\necho $$ >> "$E19_PIDS"\n'
      + 'if [ -n "$E19_FORK" ]; then sleep 30 & echo $! > "$E19_FORK"; fi\n'
      + 'sleep "${E19_SLEEP:-5}"\n');
    fs.chmodSync(p, 0o755);
  }
  process.env.PATH = `${BIN}:${ORIGINAL_PATH}`;
  process.env.E19_PIDS = PIDS;
});

afterEach(() => {
  for (const pid of [...pids(), ...grandchild()]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(PIDS, { force: true });
  fs.rmSync(GRANDCHILD, { force: true });
  delete process.env.E19_SLEEP;
  delete process.env.E19_FORK;
  cards.length = 0;
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  fs.rmSync(BIN, { recursive: true, force: true });
});

function pids(): number[] {
  try { return fs.readFileSync(PIDS, 'utf8').trim().split('\n').filter(Boolean).map(Number); } catch { return []; }
}
function grandchild(): number[] {
  try { return [Number(fs.readFileSync(GRANDCHILD, 'utf8').trim())].filter((n) => n > 0); } catch { return []; }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return cond();
}

/** One tool call through the real stop race, with the owner pressing Stop `stopAtMs` in, once the
 *  child is running (or never). `ms` is from the press to the race's answer. */
async function callAndStop(name: 'keyboard_type' | 'applescript_run', args: Record<string, unknown>, stopAtMs: number | null) {
  const tc = { id: `call-${name}`, name, arguments: args } as unknown as ToolCall;
  let pressedAt = 0;
  const press = stopAtMs === null ? null : (async () => {
    const t0 = Date.now();
    await until(() => pids().length === 1, 5_000);
    await new Promise((r) => setTimeout(r, Math.max(0, stopAtMs - (Date.now() - t0))));
    pressedAt = Date.now();
    notifyUserStop(AGENT);
  })();
  const raced = await runUnlessStopped(AGENT, tc, async () => classifyToolResult({
    toolCallId: tc.id, ...(await hidHandlers[name]({ agentId: AGENT, name, args, callId: tc.id, toolCall: tc })),
  } as Parameters<typeof classifyToolResult>[0]));
  await press;
  return { raced, ms: Date.now() - pressedAt };
}

const cutOffNotices = (): string[] => cards
  .filter((c) => c.type === 'chat:error' && typeof c.error === 'string' && /cut off/.test(c.error as string))
  .map((c) => c.error as string);

describe('E19: Stop cancels an in-flight screen-control call', () => {
  for (const [name, args] of [
    ['keyboard_type', { text: 'the crate count is forty-two' }],
    ['applescript_run', { script: 'return "the crate count"' }],
  ] as const) {
    it(`${name}: Stop at 200 ms ends the wait within 500 ms of the press and kills the child`, async () => {
      const { raced, ms } = await callAndStop(name, args, 200);
      expect(raced.stopped, 'the race saw the Stop').toBe(true);
      expect(ms, 'the turn stopped waiting at once, not when the child finished').toBeLessThan(500);
      if (raced.stopped) expect(raced.result.content.startsWith(CANCELLED_BY_STOP)).toBe(true);
      expect(await until(() => pids().length === 1, 2_000), 'the stand-in ran').toBe(true);
      expect(await until(() => !alive(pids()[0]), 2_000), 'the child is gone').toBe(true);
      if (raced.stopped) expect(raced.result.content, 'the model is told it may have acted').toContain('may already have happened');
      // The owner's "cut off" notice follows the tool's display class (stop-race.ts `followAbandoned`).
      // `applescript_run` is an effectful action; `keyboard_type` is classed bookkeeping in
      // shared/visibility.ts, so it draws no notice — handed up in the lane report, not changed here.
      if (name === 'applescript_run') {
        expect(await until(() => cutOffNotices().length === 1, 2_000), 'the owner is told it was cut off').toBe(true);
        expect(cutOffNotices()[0]).toContain(name);
      }
      expect(stopWaiterCount(AGENT), 'no wait is left open').toBe(0);
    });
  }

  it('fix round 1: the whole process tree ends — a child the AppleScript started is gone after Stop too', async () => {
    process.env.E19_FORK = GRANDCHILD;
    const { raced } = await callAndStop('applescript_run', { script: 'do shell script "sleep 30 &"' }, 200);
    expect(raced.stopped).toBe(true);
    expect(await until(() => grandchild().length === 1, 2_000), 'the stand-in started its child').toBe(true);
    expect(await until(() => !alive(grandchild()[0]), 2_000), 'the grandchild did not survive the Stop').toBe(true);
  });

  it('a call that completes before Stop is unaffected', async () => {
    process.env.E19_SLEEP = '0';
    const { raced } = await callAndStop('keyboard_type', { text: 'done' }, null);
    expect(raced.stopped).toBe(false);
    if (!raced.stopped) expect(JSON.stringify(raced.outcome)).toContain('Typed: \\"done\\"');
    notifyUserStop(AGENT);   // a later Stop finds nothing of this call to cut
    expect(cutOffNotices()).toEqual([]);
    expect(stopWaiterCount(AGENT)).toBe(0);
  });
});
