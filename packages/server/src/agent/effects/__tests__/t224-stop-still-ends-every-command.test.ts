// ════════════════════════════════════════════════════════════════════════════════════════
// t224 — THE OWNER'S STOP STILL ENDS EVERY COMMAND, NOW THROUGH THE STOP WAITERS.
//
// t203 bound every child the toolbox spawns to the owner's Stop through the abort registry. That
// made a running command look like "a model request is open" to liveness and the urgent preempt
// (see the two t224 clauses beside the readers). The binding moves to the stop-waiter door
// (`agent/stop-waiters.ts`, the one that means "the owner pressed stop"). These clauses pin what
// must NOT change: the whole tree ends within its grace, a child born after a standing stop is
// cut, and nothing the door registers outlives the child.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runWithToolCallId } from '../../turn-state.js';
import { attachCallCapability, mintCallCapability, type ResourceGrant } from '../capability.js';
import { stopWaiterCount } from '../../stop-waiters.js';

const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => emptyStmt, exec: () => undefined, transaction: (fn: () => unknown) => fn }),
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => undefined }));
vi.mock('../../v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

const AGENT = 't224-stop-agent';
const started: number[] = [];

function inCall<T>(body: () => Promise<T>): Promise<T> {
  const grants: ResourceGrant[] = [{ kind: 'proc', program: '/bin/zsh', display: '/bin/zsh' } as ResourceGrant];
  return runWithToolCallId(AGENT, 'call-1', async () => {
    attachCallCapability(mintCallCapability({ agentId: AGENT, tool: 'shell', callId: 'call-1', grants }));
    return body();
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

afterEach(async () => {
  for (const pid of started) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  started.length = 0;
  const s = await import('../../shared-state.js');
  s.stoppedAgents.clear();
  s.stopFencedRuns.clear();
  s.activeRuns.clear();
  s.activeAbortControllers.clear();
});

describe('t224: the stop reaches every command the toolbox started', () => {
  it('a command that ignores SIGTERM is still gone within the kill grace, with the job it backgrounded', async () => {
    const { spawnAuthorized } = await import('../proc.js');
    const child = await inCall(async () => spawnAuthorized('/bin/zsh', ['-c', 'trap "" TERM; sleep 41 & echo "$$ $!"; wait']));
    started.push(child.pid as number);
    const pids = await new Promise<number[]>((resolve) => {
      let buf = '';
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        if (buf.includes('\n')) resolve(buf.trim().split(/\s+/).map(Number));
      });
    });
    const { stopAgent } = await import('../../runtime.js');
    stopAgent(AGENT);
    expect(await until(() => !alive(pids[0]) && !alive(pids[1]), 6000), 'a TERM-proof command survived the stop').toBe(true);
  });

  it('a command started AFTER a stop is standing is cut the moment it is born', async () => {
    const { spawnAuthorized } = await import('../proc.js');
    const { stopAgent } = await import('../../runtime.js');
    stopAgent(AGENT);
    const child = await inCall(async () => spawnAuthorized('/bin/zsh', ['-c', 'sleep 43; wait']));
    started.push(child.pid as number);
    expect(await until(() => !alive(child.pid as number), 2000), 'a child born under a standing stop kept running').toBe(true);
  });

  it('the door holds a stop wait for the life of the child and no longer', async () => {
    const { spawnAuthorized } = await import('../proc.js');
    const child = await inCall(async () => spawnAuthorized('/bin/zsh', ['-c', 'sleep 1']));
    expect(stopWaiterCount(AGENT)).toBe(1);
    await new Promise<void>((r) => child.on('close', () => r()));
    expect(await until(() => stopWaiterCount(AGENT) === 0, 1000), 'a finished child left a stop wait behind').toBe(true);
  });

  it('a stop, pressed twice, or after the child ended on its own, does nothing odd', async () => {
    const { spawnAuthorized } = await import('../proc.js');
    const { stopAgent } = await import('../../runtime.js');
    const child = await inCall(async () => spawnAuthorized('/bin/zsh', ['-c', 'exit 0']));
    await new Promise<void>((r) => child.on('close', () => r()));
    expect(() => { stopAgent(AGENT); stopAgent(AGENT); }).not.toThrow();
    expect(stopWaiterCount(AGENT)).toBe(0);
  });
});
