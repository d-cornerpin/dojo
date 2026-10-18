// ════════════════════════════════════════
// t203 (B6) — STOP KILLS THE PROCESS A TOOL STARTED, AND EVERYTHING IT STARTED.
//
// THE DEFECT, re-derived from the code at the base: the toolbox's one spawn door
// (`effects/proc.ts`'s `spawnAuthorized`) registered nothing with the agent's stop, so a stop
// pressed during `shell`/`exec` (or an ffmpeg transcode) reached no process at all. The only
// thing that ever killed the child was the output-idle clock, and that sent SIGTERM to the
// direct child alone: a script's own children (a pipeline, a backgrounded job) were left
// running with nobody holding them — orphans.
//
// These clauses drive the REAL process door inside a REAL per-call context and the REAL stop
// door, against real processes.
// ════════════════════════════════════════

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runWithToolCallId } from '../../turn-state.js';
import { attachCallCapability, mintCallCapability, type ResourceGrant } from '../capability.js';

const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => emptyStmt, exec: () => undefined, transaction: (fn: () => unknown) => fn }),
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => undefined }));
vi.mock('../../v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

const AGENT = 't203-proc-agent';
const started: number[] = [];

function inCall<T>(program: string, body: () => Promise<T>): Promise<T> {
  const grants: ResourceGrant[] = [{ kind: 'proc', program, display: program } as ResourceGrant];
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
  for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  started.length = 0;
  const s = await import('../../shared-state.js');
  s.stoppedAgents.clear();
  s.stopFencedRuns.clear();
  s.activeRuns.clear();
  s.activeAbortControllers.clear();
});

describe('t203: Stop kills a tool\'s process tree', () => {
  it('THE RED: a shell script and the job it backgrounded both die when the owner presses Stop', async () => {
    const { spawnAuthorized } = await import('../proc.js');
    // The script prints its own pid and its background child's pid, then waits on the child.
    const child = await inCall('/bin/zsh', async () =>
      spawnAuthorized('/bin/zsh', ['-c', 'sleep 37 & echo "$$ $!"; wait']));
    const pids = await new Promise<number[]>((resolve) => {
      let buf = '';
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        if (buf.includes('\n')) resolve(buf.trim().split(/\s+/).map(Number));
      });
    });
    started.push(...pids);
    const [shell, grandchild] = pids;
    expect(alive(shell)).toBe(true);
    expect(alive(grandchild)).toBe(true);

    const { stopAgent } = await import('../../runtime.js');
    stopAgent(AGENT);

    expect(await until(() => !alive(shell), 2000), 'the shell survived the stop').toBe(true);
    expect(await until(() => !alive(grandchild), 2000), 'the backgrounded job survived the stop: an orphan').toBe(true);
  });

  it('the process door releases its stop registration when the process ends on its own', async () => {
    const { spawnAuthorized } = await import('../proc.js');
    const { countAbortable } = await import('../../shared-state.js');
    const child = await inCall('/bin/zsh', async () => spawnAuthorized('/bin/zsh', ['-c', 'exit 0']));
    await new Promise<void>((r) => child.on('close', () => r()));
    expect(countAbortable(AGENT)).toBe(0);
  });

  it('the idle clock kills the whole tree too, not only the direct child', async () => {
    const { runWithIdleBound } = await import('../../tools/process-idle-bound.js');
    const marker = `/tmp/t203-idle-${process.pid}-${Date.now()}`;
    // The background job writes its pid to a file, then everything goes silent.
    const run = inCall('/bin/zsh', () => runWithIdleBound('/bin/zsh',
      ['-c', `sleep 38 & echo $! > ${marker}; wait`], { idleMs: 300, ceilingMs: 60_000 }));
    run.catch(() => undefined);
    const fs = await import('node:fs');
    expect(await until(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').includes('\n'), 3000)).toBe(true);
    const grandchild = Number(fs.readFileSync(marker, 'utf8').trim());
    fs.unlinkSync(marker);
    started.push(grandchild);
    // The run must come back once the clock fires — not when the orphan holding its pipe exits.
    const settled = await Promise.race([
      run.then(() => 'resolved', (e: { killed?: boolean }) => (e.killed ? 'killed' : 'failed')),
      new Promise<string>((r) => setTimeout(() => r('still holding'), 3000)),
    ]);
    expect(settled).toBe('killed');
    expect(await until(() => !alive(grandchild), 2000), 'the idle kill left the background job running').toBe(true);
  });
});
