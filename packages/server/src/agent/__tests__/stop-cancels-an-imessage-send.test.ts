// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 E19b — STOP CANCELS AN IN-FLIGHT iMESSAGE SEND.
//
// The defect, at the base: every iMessage send ran its program synchronously
// (`services/imessage-bridge.ts`: `execFileSync(imsg, ['send', …])`, the AppleScript fallback
// through `execSync(osascript …)`, attachments the same). The stop race races the tool against
// the owner's Stop, but a synchronous child holds the event loop, so the Stop could not even be
// observed until the send returned or hit its bound, and nothing ended the child.
//
// Driven through the real stop race, the real `imessage_send` handler and the real bridge, against
// a real process: a stand-in `imsg` planted where the bridge looks for one (the home's
// `.dojo/bin`), which records its pid and sleeps. The REAL `imsg` and `osascript` cannot run in a
// test at all (`vitest.test-nets.cjs`, the iMessage net); the first clause re-checks that before
// anything here sends.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolCall } from '@dojo/shared';

const cards = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: Record<string, unknown>) => { cards.push(e); } }));
// The bridge's poller is not running in a test; the handler asks whether it is.
vi.mock('../../services/imessage-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/imessage-bridge.js')>();
  return { ...actual, getIMBridgeStatus: () => ({ ...actual.getIMBridgeStatus(), running: true, enabled: true, connected: true }) };
});

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { homeDir } from '../../home.js';
import { runUnlessStopped, CANCELLED_BY_STOP } from '../v2/steps/execute/stop-race.js';
import { notifyUserStop, stopWaiterCount } from '../stop-waiters.js';
import { commsHandlers } from '../tools/cat/comms.js';
import { classifyToolResult } from '../tool-outcome.js';
import { runWithToolCallId } from '../turn-state.js';
import { attachCallCapability, mintCallCapability } from '../effects/capability.js';
import { grantsForCall } from '../effects/scopes.js';
import { effectsFor } from '../tools/registry.js';
import { sendIMessage } from '../../services/imessage-bridge.js';

const AGENT = 'agent-e19b-imessage';
const OWNER = '+15550100199';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'e19b-imsg-'));
const PIDS = path.join(SCRATCH, 'imsg-pids');
const OSA = path.join(SCRATCH, 'osascript-ran');
const ORIGINAL_PATH = process.env.PATH;

beforeAll(() => {
  // THE NET FIRST: if the real imsg could run here, stop before anything sends.
  expect(() => childProcess.execFileSync('/opt/homebrew/bin/imsg', ['--help']), 'the iMessage net is in')
    .toThrow(/TEST NET: a test tried to run the real iMessage program/);

  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' }]));

  // The stand-in imsg, where the bridge looks for one. `--help` is the bridge's health probe.
  const bin = path.join(homeDir(), '.dojo', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'imsg'), '#!/bin/sh\n[ "$1" = "--help" ] && exit 0\n'
    + 'echo $$ >> "$E19B_PIDS"\nsleep "${E19B_SLEEP:-10}"\n', { mode: 0o755 });
  // A stand-in osascript first on PATH, so a fallback the Stop must NOT take would be seen.
  fs.writeFileSync(path.join(SCRATCH, 'osascript'), '#!/bin/sh\necho ran >> "$E19B_OSA"\n', { mode: 0o755 });
  process.env.PATH = `${SCRATCH}:${ORIGINAL_PATH}`;
  process.env.E19B_PIDS = PIDS;
  process.env.E19B_OSA = OSA;
});

afterEach(() => {
  for (const pid of pids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(PIDS, { force: true });
  fs.rmSync(OSA, { force: true });
  delete process.env.E19B_SLEEP;
  cards.length = 0;
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

function pids(): number[] {
  try { return fs.readFileSync(PIDS, 'utf8').trim().split('\n').filter(Boolean).map(Number); } catch { return []; }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return cond();
}

/** One imessage_send through the real stop race, the owner pressing Stop `stopAtMs` after the
 *  stand-in starts (or never). `ms` is from the press to the race's answer. */
async function sendAndStop(args: Record<string, unknown>, stopAtMs: number | null) {
  const tc = { id: 'call-imessage', name: 'imessage_send', arguments: args } as unknown as ToolCall;
  let pressedAt = 0;
  const press = stopAtMs === null ? null : (async () => {
    await until(() => pids().length === 1, 5_000);
    await new Promise((r) => setTimeout(r, stopAtMs));
    pressedAt = Date.now();
    notifyUserStop(AGENT);
  })();
  // The dispatch's own frame: the call id and the capability the gate loop would mint for it.
  const raced = await runUnlessStopped(AGENT, tc, () => runWithToolCallId(AGENT, tc.id, async () => {
    attachCallCapability(mintCallCapability({ agentId: AGENT, tool: tc.name, callId: tc.id, grants: grantsForCall(AGENT, effectsFor(tc.name), args) }));
    return classifyToolResult({
      toolCallId: tc.id, ...(await commsHandlers.imessage_send({ agentId: AGENT, name: tc.name, args, callId: tc.id, toolCall: tc })),
    } as Parameters<typeof classifyToolResult>[0]);
  }));
  await press;
  return { raced, ms: Date.now() - pressedAt };
}

const cutOffNotices = (): string[] => cards
  .filter((c) => c.type === 'chat:error' && typeof c.error === 'string' && /cut off/.test(c.error as string))
  .map((c) => c.error as string);

const doorRow = (): { outcome: string; detail: string | null } | undefined => getDb().prepare(
  "SELECT outcome, detail FROM deliveries WHERE channel = 'imessage' ORDER BY rowid DESC LIMIT 1",
).get() as { outcome: string; detail: string | null } | undefined;

describe('E19b: Stop cancels an in-flight iMessage send', () => {
  it('Stop at 200 ms ends the wait within 500 ms of the press, kills the send, and takes no fallback', async () => {
    const { raced, ms } = await sendAndStop({ recipient: OWNER, message: 'the crate count is forty-two' }, 200);
    expect(raced.stopped, 'the race saw the Stop').toBe(true);
    expect(ms, 'the turn stopped waiting at once, not when the send finished').toBeLessThan(500);
    if (raced.stopped) {
      expect(raced.result.content.startsWith(CANCELLED_BY_STOP)).toBe(true);
      expect(raced.result.content, 'the model is told it may have gone').toContain('may already have happened');
    }
    expect(await until(() => !alive(pids()[0]), 2_000), 'the send\'s process is gone').toBe(true);
    expect(await until(() => cutOffNotices().length === 1, 2_000), 'the owner is told it was cut off').toBe(true);
    expect(cutOffNotices()[0]).toMatch(/the iMessage was cut off while it was being sent/);
    expect(fs.existsSync(OSA), 'a Stop is not a failed send: no AppleScript retry').toBe(false);
    expect(doorRow()?.outcome).toBe('failed');
    expect(doorRow()?.detail ?? '').toMatch(/Stop/);
    expect(stopWaiterCount(AGENT), 'no wait is left open').toBe(0);
  });

  it('a file send cut by the Stop sends nothing more: no second file, no caption on its own, no fallback', async () => {
    const files = [1, 2].map((n) => { const f = path.join(SCRATCH, `photo-${n}.jpg`); fs.writeFileSync(f, 'x'); return f; });
    const { raced } = await sendAndStop({ recipient: OWNER, message: 'two photos', attachments: files }, 200);
    expect(raced.stopped).toBe(true);
    await until(() => cutOffNotices().length === 1, 2_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(pids(), 'only the first file send ever started').toHaveLength(1);
    expect(fs.existsSync(OSA), 'no AppleScript file send or caption retry').toBe(false);
  });

  it('a send that completes before Stop is unaffected', async () => {
    process.env.E19B_SLEEP = '0';
    const { raced } = await sendAndStop({ recipient: OWNER, message: 'done' }, null);
    expect(raced.stopped).toBe(false);
    if (!raced.stopped) expect(JSON.stringify(raced.outcome)).toContain('iMessage sent to Owner');
    notifyUserStop(AGENT);   // a later Stop finds nothing of this call to cut
    expect(cutOffNotices()).toEqual([]);
    expect(doorRow()?.outcome).toBe('delivered');
    expect(stopWaiterCount(AGENT)).toBe(0);
  });

  it('a platform send (no agent behind it) is not bound to any agent\'s Stop', async () => {
    process.env.E19B_SLEEP = '0';
    notifyUserStop(AGENT);
    expect(await sendIMessage(OWNER, 'an owner notice')).toBe(true);
  });
});
