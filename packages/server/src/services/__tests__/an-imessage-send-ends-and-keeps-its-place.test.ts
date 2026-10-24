// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 E19b fix round 1 — AN iMESSAGE SEND ALWAYS ENDS, KEEPS ITS PLACE, AND SAYS WHAT HAPPENED.
//
// When the sends were synchronous they ran one at a time by accident, and a stuck one held the
// server. Async sends lost both properties quietly:
//   • two owner notices fired seconds apart ran as parallel `imsg` processes and could reach the
//     phone out of order — sends go one at a time again, in the order they were asked for;
//   • a send that outlived its bound got SIGTERM only, so a program that ignored it left the send
//     (and a fire-and-forget owner notice) pending for ever — the group now gets SIGKILL after it;
//   • the Stop waiter leaked when `spawn` itself threw;
//   • a send the owner's Stop prevented from STARTING was recorded "may already have gone out".
//
// Real processes, but only stand-ins: a stand-in `imsg` planted where the bridge looks for one
// (the test home's `.dojo/bin`). The real programs are refused suite-wide (vitest.test-nets.cjs);
// the first check below re-asserts that before anything sends.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { homeDir } from '../../home.js';
import { stopWaiterCount } from '../../agent/stop-waiters.js';
import { stoppedAgents } from '../../agent/shared-state.js';
import { runMessagesProgram } from '../imessage-run.js';
import { sendIMessage } from '../imessage-bridge.js';

const AGENT = 'agent-e19b-r1';
const OWNER = '+15550100198';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'e19b-r1-'));
const LOG = path.join(SCRATCH, 'sent');
const PIDS = path.join(SCRATCH, 'pids');

beforeAll(() => {
  expect(() => childProcess.execFileSync('/opt/homebrew/bin/imsg', ['--help']), 'the iMessage net is in')
    .toThrow(/TEST NET: a test tried to run the real iMessage program/);
  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' }]));
  const bin = path.join(homeDir(), '.dojo', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // The stand-in: `--help` is the health probe; a text containing "slow" takes half a second.
  fs.writeFileSync(path.join(bin, 'imsg'), '#!/bin/sh\n[ "$1" = "--help" ] && exit 0\n'
    + 'case "$*" in *slow*) sleep 0.5;; esac\necho "$5" >> "$E19B_LOG"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(SCRATCH, 'deaf'), '#!/bin/sh\necho $$ >> "$E19B_PIDS"\ntrap "" TERM\nwhile :; do sleep 1; done\n', { mode: 0o755 });
  process.env.E19B_LOG = LOG;
  process.env.E19B_PIDS = PIDS;
});

afterEach(() => {
  stoppedAgents.delete(AGENT);
  try { for (const pid of fs.readFileSync(PIDS, 'utf8').trim().split('\n').filter(Boolean).map(Number)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } } catch { /* none */ }
  for (const f of [LOG, PIDS]) fs.rmSync(f, { force: true });
});
afterAll(() => { fs.rmSync(SCRATCH, { recursive: true, force: true }); });

const lastRow = (): { outcome: string; detail: string | null } | undefined => getDb().prepare(
  "SELECT outcome, detail FROM deliveries WHERE channel = 'imessage' ORDER BY rowid DESC LIMIT 1",
).get() as { outcome: string; detail: string | null } | undefined;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('E19b fix round 1 — an iMessage send ends, keeps its place, and says what happened', () => {
  it('two sends asked for in order arrive in order, even when the first is slow', async () => {
    await Promise.all([sendIMessage(OWNER, 'first, slow'), sendIMessage(OWNER, 'second')]);
    expect(fs.readFileSync(LOG, 'utf8').trim().split('\n')).toEqual(['first, slow', 'second']);
  });

  it('a send that ignores SIGTERM at its bound is killed, so it never stays pending', async () => {
    const t0 = Date.now();
    await expect(runMessagesProgram(path.join(SCRATCH, 'deaf'), [], { timeout: 200 })).rejects.toThrow(/timed out after 200 ms/);
    expect(Date.now() - t0, 'ended by the kill after its grace, not left hanging').toBeLessThan(10_000);
    const pid = Number(fs.readFileSync(PIDS, 'utf8').trim());
    expect(alive(pid), 'the deaf program is gone').toBe(false);
  });

  it('when spawn itself throws, the Stop waiter it opened is released', async () => {
    await expect(runMessagesProgram('stand\0in', [], { timeout: 1_000, agentId: AGENT })).rejects.toThrow();
    expect(stopWaiterCount(AGENT)).toBe(0);
  });

  it('a send the Stop prevented from starting is recorded as not sent, not as "may have gone out"', async () => {
    stoppedAgents.add(AGENT);
    expect(await sendIMessage(OWNER, 'never started', { agentId: AGENT })).toBe(false);
    expect(fs.existsSync(LOG), 'the program never ran').toBe(false);
    expect(lastRow()?.outcome).toBe('failed');
    expect(lastRow()?.detail ?? '').toMatch(/not sent/);
    expect(lastRow()?.detail ?? '').not.toMatch(/may already have gone out/);
  });
});
