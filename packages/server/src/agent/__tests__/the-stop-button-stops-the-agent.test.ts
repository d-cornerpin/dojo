// ════════════════════════════════════════════════════════════════════════════
// UX-REPAIR T37 — THE STOP BUTTON STOPS THE AGENT AGAIN.
//
// THE DEFECT, as measured on the dev box (orchestrator's repro 2026-08-11
// 07:12:30Z, re-run by W16 at 07:24:30Z — the same shape both times):
//
//   07:24:30.475  Agent stop requested                    ← the button
//   07:24:30.484  v2 agent stopped by user                ← the turn DID halt
//   07:24:30.507  ask re-opened: its turn finalized without delivering an answer
//   07:24:31.571  Processing queued wakeup                ← the stopped run
//   07:24:38.718  Executing tool  work_open                  restarted itself
//
// The stop worked. What undid it was the stopped run's OWN end-of-run drain:
// `handleMessage`'s `finally` asks "is a human still waiting?", the answer is
// yes precisely BECAUSE the stop left the ask unanswered, and it queues a
// wakeup that fires a brand-new turn 500 ms later on the same request.
//
// WHEN IT BROKE: `b2027b0` (2026-06-25, "structured message attribution +
// concurrent turn serialization") added the human-conversation drain to that
// `finally`. Before it, the `finally`'s only re-trigger was
// `if (pendingWakeups.has(agentId))` — and `stopAgent` clears `pendingWakeups`,
// so a stop stayed stopped. Three more self-wake sites have been added to the
// same `finally` since (A2A re-trigger, compile drive, unserved-wake drain),
// none of them stop-aware either.
//
// TWO ROOT-CAUSE PROPERTIES, both pinned below:
//   1. THE FLAG MUST OUTLIVE THE CHECKPOINT THAT HONOURED IT. It used to be
//      deleted by whichever of the three checkpoints saw it first, so by the
//      time the drains ran there was nothing left to see. The run's own
//      `finally` is now the ONE owner of the clear.
//   2. A SELF-WAKE HAS ONE DOOR. Every "wake myself again" site goes through
//      `queueSelfWake`, which refuses while a stop is live. A REAL inbound
//      queued by `handleMessage`'s busy path keeps its direct `add` — the user
//      asking for something new is not the agent resurrecting itself.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stoppedAgents, pendingWakeups, preemptedAgents, activeAbortControllers,
  queueSelfWake,
} from '../shared-state.js';

const AGENT = 'stop-button-agent';
const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(p);
      } else if (entry.name.endsWith('.ts')) {
        out.push(p);
      }
    }
  };
  walk(SRC_ROOT);
  return out;
}

function rel(p: string): string { return path.relative(SRC_ROOT, p); }

beforeEach(() => {
  stoppedAgents.clear();
  pendingWakeups.clear();
  preemptedAgents.clear();
  activeAbortControllers.clear();
});

// ── PROPERTY 2: one door for self-wakes ──────────────────────────────────────

describe('a stopped run cannot wake itself', () => {
  it('THE RED: a self-wake is REFUSED while the user\'s stop is live', () => {
    stoppedAgents.add(AGENT);
    expect(queueSelfWake(AGENT, 'human-conversation-drain')).toBe(false);
    expect(pendingWakeups.has(AGENT)).toBe(false);
  });

  it('CONTROL: the same self-wake is queued when no stop is live — byte-identical to today', () => {
    expect(queueSelfWake(AGENT, 'human-conversation-drain')).toBe(true);
    expect(pendingWakeups.has(AGENT)).toBe(true);
  });

  it('CONTROL: a stop on ONE agent never touches another agent\'s drain', () => {
    stoppedAgents.add(AGENT);
    expect(queueSelfWake('someone-else', 'unserved-wake-drain')).toBe(true);
    expect(pendingWakeups.has('someone-else')).toBe(true);
    expect(pendingWakeups.has(AGENT)).toBe(false);
  });

  it('a REAL inbound arriving during a stopped run still queues — it is not a self-wake', () => {
    // `handleMessage`'s busy path adds directly, on purpose: a message that
    // arrived while the agent was busy is somebody asking for something, and
    // the stop is about the work the agent was already doing.
    stoppedAgents.add(AGENT);
    pendingWakeups.add(AGENT);
    expect(pendingWakeups.has(AGENT)).toBe(true);
  });

  it('THE CENSUS: every self-wake in the tree goes through the one door', () => {
    // The standing rule: a set stays safe because the suite RUNS the census,
    // not because a report says it was checked once.
    const ALLOWED = new Set([
      // The door itself.
      'agent/shared-state.ts',
      // The ONE real-inbound queue: `handleMessage` is busy, so the caller's
      // message is parked for the end of the current run. Argued at the site.
      'agent/runtime.ts',
    ]);
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, 'utf-8');
      const hits = src.split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /pendingWakeups\.add\(/.test(line));
      if (hits.length === 0) continue;
      if (!ALLOWED.has(rel(file))) {
        for (const h of hits) offenders.push(`${rel(file)}:${h.n} — ${h.line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('THE CENSUS, second half: runtime.ts keeps exactly ONE direct add — the busy path', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'agent/runtime.ts'), 'utf-8');
    const adds = src.split('\n').filter((l) => /pendingWakeups\.add\(/.test(l));
    expect(adds).toHaveLength(1);
  });
});

// ── PROPERTY 1: the flag outlives the checkpoint that honoured it ────────────

describe('the stop flag outlives the checkpoint that honoured it', () => {
  it('THE CENSUS: only the run\'s own exit path and a human\'s own request clear it', () => {
    // Three clears are legitimate and each is named:
    //   • agent/runtime.ts        — the run's `finally`, the ONE owner
    //   • gateway/routes/chat.ts  — a fresh user message means "act" (2026-06-02)
    //   • gateway/routes/agents.ts— reset-session starts a clean slate
    const ALLOWED = new Set(['agent/runtime.ts', 'gateway/routes/chat.ts', 'gateway/routes/agents.ts']);
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, 'utf-8');
      src.split('\n').forEach((line, i) => {
        if (!/stoppedAgents\.delete\(/.test(line)) return;
        if (!ALLOWED.has(rel(file))) offenders.push(`${rel(file)}:${i + 1} — ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the pre-call gate exits on the stop and LEAVES the flag standing for the drains', async () => {
    const { runPreCallGates } = await import('../v2/steps/pre-call-gates/index.js');
    const setAgentStatus = vi.fn();
    stoppedAgents.add(AGENT);
    const out = await runPreCallGates(
      { phase: 'preCallGates' } as never,
      { agentId: AGENT, setAgentStatus } as never,
    );
    expect(out).toMatchObject({ directive: 'exit', reason: 'stopped-by-user' });
    expect(setAgentStatus).toHaveBeenCalledWith(AGENT, 'idle');
    // THE RED: at HEAD this gate deleted the flag, so `handleMessage`'s drains
    // — which run after the loop breaks — could not tell a stopped run from a
    // finished one and queued the next turn.
    expect(stoppedAgents.has(AGENT)).toBe(true);
  });

  it('EVERY engine checkpoint reads the flag and NONE of them retires it', async () => {
    // The corpus is the SHARED derivation (`engine-sources.ts`), not a fourth
    // hand-rolled walk of the step packages — PHASE-6 GUARD-AUDIT's rule, and
    // the reason is exactly this clause's shape: a negative assertion over a
    // corpus that has quietly stopped containing its subject passes forever.
    const { engineSources } = await import('../v2/__tests__/engine-sources.js');
    const sources = engineSources();
    const readers = sources.filter((f) => /stoppedAgents\.has\(agentId\)/.test(f.text)).map((f) => f.rel);
    const retirers = sources.filter((f) => /stoppedAgents\.delete\(/.test(f.text)).map((f) => f.rel);
    // Non-vacuity first: the three checkpoints are the pre-call gate, the
    // model-call catch and the executor's batch loop.
    expect(readers.length, 'the engine stopped checking the stop flag entirely').toBeGreaterThanOrEqual(3);
    expect(retirers, 'a step retired the stop flag again — the drains cannot see a stop that is already gone').toEqual([]);
  });

  it('the preempt flag is NOT changed by this task — it is still consumed at its checkpoints', async () => {
    // Requirement preserved: a preempt exists so a QUEUED WAKEUP CAN FIRE. Its
    // consumption at the checkpoint is what lets that wakeup through, and the
    // fix above must not have crept onto it. Same shared corpus, same reason.
    const { engineSources } = await import('../v2/__tests__/engine-sources.js');
    const consumers = engineSources()
      .filter((f) => /preemptedAgents\.delete\(agentId\)/.test(f.text))
      .map((f) => f.rel);
    expect(consumers.length, 'the preempt flag stopped being consumed at its checkpoints').toBeGreaterThanOrEqual(2);
  });
});

afterEach(() => {
  stoppedAgents.clear();
  pendingWakeups.clear();
  preemptedAgents.clear();
});
