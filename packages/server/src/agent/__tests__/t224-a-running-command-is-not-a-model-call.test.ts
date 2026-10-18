// ════════════════════════════════════════════════════════════════════════════════════════
// t224 — AN URGENT MESSAGE NEITHER COUNTS NOR KILLS A RUNNING COMMAND.
//
// `preemptAgentForUrgentMessage` answers "was there an in-flight MODEL call to abort?" from the
// turn-scoped entries of the abort registry (its own comment says counting anything else burns
// the cool-down and arms `preemptedAgents` over work it was never meant to touch). t203 put every
// child process the toolbox spawns into that registry, so with a command running an urgent message
// would arm the preempt flag and then cut the command with the model call it was aimed at.
//
// Real spawn door, real capability, real children, real preempt door.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ResourceGrant } from '../effects/capability.js';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

const AGENT = 't224-preempt-agent';
const started: number[] = [];

beforeEach(() => {
  vi.resetModules();
  mockDb.current = new Database(':memory:');
});

afterEach(async () => {
  for (const pid of started) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  started.length = 0;
  const s = await import('../shared-state.js');
  s.activeAbortControllers.clear();
  s.preemptedAgents.clear();
  s.stoppedAgents.clear();
  s.stopFencedRuns.clear();
  mockDb.current?.close();
  mockDb.current = null;
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function runCommand(): Promise<{ pid: number }> {
  // Loaded after `resetModules`, so the door and the capability share one module graph.
  const { spawnAuthorized } = await import('../effects/proc.js');
  const { runWithToolCallId } = await import('../turn-state.js');
  const { attachCallCapability, mintCallCapability } = await import('../effects/capability.js');
  const grants: ResourceGrant[] = [{ kind: 'proc', program: '/bin/zsh', display: '/bin/zsh' } as ResourceGrant];
  const child = await runWithToolCallId(AGENT, 'call-1', async () => {
    attachCallCapability(mintCallCapability({ agentId: AGENT, tool: 'shell', callId: 'call-1', grants }));
    return spawnAuthorized('/bin/zsh', ['-c', 'sleep 47; wait']);
  });
  started.push(child.pid as number);
  return { pid: child.pid as number };
}

describe('t224: an urgent preempt while a command runs', () => {
  it('RED: returns false, arms nothing and leaves the command alone when no model call is open', async () => {
    const { preemptedAgents } = await import('../shared-state.js');
    const { preemptAgentForUrgentMessage } = await import('../runtime.js');
    const { pid } = await runCommand();

    expect(preemptAgentForUrgentMessage(AGENT), 'nothing was in flight to abort').toBe(false);

    expect(preemptedAgents.has(AGENT), 'the next unrelated failure must not read as preempted-mid-call').toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(alive(pid), 'the urgent message killed the running command').toBe(true);
  });

  it('RED: no cool-down is burned, so a real barge-in right after still aborts the model call', async () => {
    const { registerAbortable } = await import('../shared-state.js');
    const { preemptAgentForUrgentMessage } = await import('../runtime.js');
    await runCommand();
    expect(preemptAgentForUrgentMessage(AGENT)).toBe(false);

    const modelCall = new AbortController();
    registerAbortable(AGENT, modelCall, 'turn');
    expect(preemptAgentForUrgentMessage(AGENT)).toBe(true);
    expect(modelCall.signal.aborted).toBe(true);
  });

  it('with a model call AND a command open, the preempt cuts the model call and spares the command', async () => {
    const { registerAbortable } = await import('../shared-state.js');
    const { preemptAgentForUrgentMessage } = await import('../runtime.js');
    const { pid } = await runCommand();
    const modelCall = new AbortController();
    registerAbortable(AGENT, modelCall, 'turn');

    expect(preemptAgentForUrgentMessage(AGENT)).toBe(true);

    expect(modelCall.signal.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(alive(pid), 'the barge-in reached past the model call into the command').toBe(true);
  });

  it('the registry, and so the live-work indicator, counts a model or media request and not a command', async () => {
    const { countAbortable } = await import('../shared-state.js');
    await runCommand();
    expect(countAbortable(AGENT, 'turn')).toBe(0);
    expect(countAbortable(AGENT, 'background')).toBe(0);
  });
});
