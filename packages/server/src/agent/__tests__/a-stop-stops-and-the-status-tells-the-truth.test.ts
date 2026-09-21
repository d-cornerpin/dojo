// ════════════════════════════════════════════════════════════════════════════
// T83 — A STOP STOPS, AND THE STATUS TELLS THE TRUTH.
//
// THE DEFECT, re-derived from the dev box's own log (`~/.dojo/logs`, MrMeSeeks
// `a504e5c9`, 2026-09-21) rather than from the triage report's prose:
//
//   04:22:16.150  OpenAI call completed          ← the TURN's own call ends,
//                                                   and its controller is gone
//   04:22:25.264  v2 turn time budget reached, auto-continuing with forced compaction
//   04:22:25.273  Calling OpenAI model  (messageCount 2, toolCount 0)
//                                                ← the SUMMARISER's call: made by
//                                                   `memory/summarize.ts`, registered
//                                                   in NOTHING, carrying NO abort signal
//   04:22:42.167  Agent stop requested           ← the button. `activeAbortControllers`
//                                                   is EMPTY, so it aborts nothing,
//                                                   and it writes status='idle'
//   04:25:23.307  Agent session reset via API    ← clears `stoppedAgents` while the
//                                                   stopped run is STILL RUNNING
//   04:25:27.711  Calling OpenAI model           ← ask-title, CONCURRENT with the
//                                                   summariser on the same agentId
//   04:27:10.615  OpenAI call completed  latencyMs 285328   ← the un-aborted call
//   04:27:10.624  the turn parks for a continuation
//   04:27:11.132  Processing queued wakeup       ← the chain RESUMES
//
// THREE ROOT-CAUSE PROPERTIES, each pinned by its own clause below:
//
//   1. EVERY PROVIDER CALL AN AGENT MAKES IS ABORTABLE BY THAT AGENT'S STOP.
//      The registry only ever held the ONE controller the turn's own model call
//      put there. Every other dial a turn makes — the turn-budget checkpoint's
//      forced compaction, the continuity brief, the classifiers, ask-title —
//      dialled with no controller and no signal. And because two of them can be
//      in flight at once on one agentId (proven at 04:25:27 above), a registry
//      holding ONE controller per agent is wrong even if every caller registers.
//
//   2. A CALL THAT RACES THE STOP TO THE REGISTRY LOSES. Registration goes
//      through one door that refuses — and aborts on the spot — while a stop is
//      live, so there is no window in which a call can register itself out of a
//      stop that already landed.
//
//   3. THE STOP FENCE IS THE RUN'S, AND ONLY THE RUN RETIRES IT. `stoppedAgents`
//      is clearable from outside (a fresh user message; reset-session — both
//      legitimate, both about the NEXT run). The run that was stopped needs a
//      fence nobody outside it can lift, or its own turn-budget checkpoint
//      re-arms the continuation four minutes later.
//
//   4. STATUS IS NOT A COSMETIC. `idle` written while the loop is still
//      unwinding is a lie that every reader believes — it is exactly why three
//      `resetSession()` calls sailed through a busy agent here, where the same
//      guard had correctly refused for 390 s when the status told the truth.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const mockDb: { current: Database.Database | null } = { current: null };
const broadcasts: Array<Record<string, unknown>> = [];

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (ev: Record<string, unknown>) => { broadcasts.push(ev); },
}));
// The turn machinery is irrelevant to the stop door itself — mocked so importing
// `runtime.js` never pulls the model-call chain (and never risks a real dial).
vi.mock('../v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

const AGENT = 'stop-truth-agent';

function seedAgent(status: string): void {
  mockDb.current!.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, config TEXT,
      last_error TEXT, last_error_at TEXT, updated_at TEXT
    );
  `);
  mockDb.current!.prepare(
    "INSERT OR REPLACE INTO agents (id, name, status, config, updated_at) VALUES (?, 'MrMeSeeks', ?, '{}', datetime('now'))",
  ).run(AGENT, status);
}

function statusOf(): string {
  return (mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string }).status;
}

beforeEach(() => {
  vi.resetModules();
  broadcasts.length = 0;
  mockDb.current = new Database(':memory:');
});

afterEach(async () => {
  const s = await import('../shared-state.js');
  s.stoppedAgents.clear();
  s.pendingWakeups.clear();
  s.preemptedAgents.clear();
  s.activeRuns.clear();
  s.activeAbortControllers.clear();
  s.stopFencedRuns.clear();
  mockDb.current?.close();
  mockDb.current = null;
});

// ── PROPERTY 2: a call racing the stop to the registry loses ─────────────────

describe('a call that races the stop to the registry cannot dial', () => {
  it('THE RED: registering while a stop is live is REFUSED, and the controller is aborted on the spot', async () => {
    const { stoppedAgents, activeAbortControllers, registerAbortable } = await import('../shared-state.js');
    stoppedAgents.add(AGENT);

    const racing = new AbortController();
    expect(registerAbortable(AGENT, racing)).toBe(false);
    expect(racing.signal.aborted, 'a call that registers after the stop must never reach the wire').toBe(true);
    expect(activeAbortControllers.get(AGENT)?.size ?? 0).toBe(0);
  });

  it('CONTROL: with no stop live, registration is accepted and the controller is untouched', async () => {
    const { activeAbortControllers, registerAbortable } = await import('../shared-state.js');
    const c = new AbortController();
    expect(registerAbortable(AGENT, c)).toBe(true);
    expect(c.signal.aborted).toBe(false);
    expect(activeAbortControllers.get(AGENT)?.has(c)).toBe(true);
  });
});

// ── PROPERTY 1: every call an agent has in flight is abortable ───────────────

describe('a stop aborts EVERY call the agent has in flight', () => {
  it('THE RED: the turn\'s own call AND a mid-turn compaction call are both cut', async () => {
    const { activeRuns, registerAbortable } = await import('../shared-state.js');
    const { stopAgent } = await import('../runtime.js');
    seedAgent('working');
    activeRuns.add(AGENT);

    // 04:22:25 — the turn's dial and the turn-budget checkpoint's summariser dial,
    // both on one agentId, both genuinely in flight when the button is pressed.
    const turnCall = new AbortController();
    const compactionCall = new AbortController();
    expect(registerAbortable(AGENT, turnCall)).toBe(true);
    expect(registerAbortable(AGENT, compactionCall)).toBe(true);

    stopAgent(AGENT);

    expect(turnCall.signal.aborted).toBe(true);
    expect(compactionCall.signal.aborted, 'the 285-second call the stop never reached').toBe(true);
  });

  it('CONTROL — the stop that DID work (03:18:34): one registered call, cut', async () => {
    const { activeRuns, registerAbortable } = await import('../shared-state.js');
    const { stopAgent } = await import('../runtime.js');
    seedAgent('working');
    activeRuns.add(AGENT);
    const inFlight = new AbortController();
    registerAbortable(AGENT, inFlight);

    stopAgent(AGENT);
    expect(inFlight.signal.aborted).toBe(true);
  });

  it('CONTROL: a stop on one agent never reaches another agent\'s in-flight call', async () => {
    const { activeRuns, registerAbortable } = await import('../shared-state.js');
    const { stopAgent } = await import('../runtime.js');
    seedAgent('working');
    activeRuns.add(AGENT);
    const mine = new AbortController();
    const theirs = new AbortController();
    registerAbortable(AGENT, mine);
    registerAbortable('someone-else', theirs);

    stopAgent(AGENT);
    expect(mine.signal.aborted).toBe(true);
    expect(theirs.signal.aborted).toBe(false);
  });

  it('release is by IDENTITY: one call settling never de-registers the other', async () => {
    const { activeAbortControllers, registerAbortable, releaseAbortable, abortInFlight } =
      await import('../shared-state.js');
    const first = new AbortController();
    const second = new AbortController();
    registerAbortable(AGENT, first);
    registerAbortable(AGENT, second);

    releaseAbortable(AGENT, first);

    expect(activeAbortControllers.get(AGENT)?.has(second)).toBe(true);
    expect(abortInFlight(AGENT, 'test')).toBe(1);
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted, 'a released controller is not the stop\'s business').toBe(false);
  });

  it('THE CENSUS: nothing writes the registry except its own door', async () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (rel(file) === 'agent/shared-state.ts') continue;
      codeLines(textOf(file)).forEach(({ line, n }) => {
        if (/activeAbortControllers\.(set|delete)\(/.test(line)) {
          offenders.push(`${rel(file)}:${n} — ${line.trim()}`);
        }
      });
    }
    expect(offenders, 'a registry with side doors is a registry a stop can miss').toEqual([]);
  });

  it('THE CENSUS: the ONE place a provider call is dialled is the one place it is registered', async () => {
    // Non-vacuous by construction: `agent/model.ts` is the tree's only `callModel`,
    // and it must be among the registrars. If the dial door ever stops registering,
    // every engine-initiated call goes back to being un-abortable.
    const registrars = sourceFiles()
      .filter((f) => /registerAbortable\(/.test(textOf(f)))
      .map(rel);
    expect(registrars).toContain('agent/model.ts');
  });

  it('THE RED (review CRITICAL A-1): EVERY transport receives the abort signal, not just three', () => {
    // The first cut's census asked only whether `model.ts` was among the registrars, which is
    // true of a transport that takes the signal and drops it. `callAnthropicSdkModel` did
    // exactly that: `registerAbortable` succeeded, `abortInFlight` aborted the controller,
    // `stopAgent` logged `callsAborted: 1` — and the Agent-SDK call ran to natural completion,
    // the audited defect surviving on one transport wearing a receipt saying it was fixed.
    //
    // Read per-function rather than per-file, because "the file mentions abortSignal" is
    // exactly the assertion that passed while one of its four dispatchers ignored it.
    const src = fs.readFileSync(path.join(SRC_ROOT, 'agent/model.ts'), 'utf-8');
    const bodyOf = (name: string): string => {
      const start = src.indexOf(`async function ${name}(`);
      expect(start, `transport ${name} is gone from model.ts`).toBeGreaterThan(-1);
      const next = src.slice(start + 1).search(/\nasync function |\nexport async function /);
      return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
    };
    for (const transport of ['callOllamaModel', 'callOpenAIModel', 'callAnthropicSdkModel']) {
      expect(/params\.abortSignal/.test(bodyOf(transport)), `${transport} drops the stop signal`).toBe(true);
    }
    // The Anthropic-direct path has no function of its own — it is the fall-through tail of
    // `dialModel`, so it is checked there.
    expect(/params\.abortSignal/.test(bodyOf('dialModel'))).toBe(true);
  });

  it('the Agent-SDK transport takes an external signal and composes it with T81d\'s patience timer', async () => {
    // STRUCTURE ONLY, and deliberately not the whole guard (fix round 2, review NEW-2): a text
    // census is what passed while this transport dropped the signal, so the BEHAVIOUR is pinned
    // where the harness for it already exists — `the-agent-sdk-transport-honours-declared-
    // patience.test.ts` §D drives a real external abort into a real in-flight `query()` and
    // asserts both halves (the call is cut; the error is not the patience code). This clause
    // reads the composition that makes that possible; that one reads the result.
    const sdkSrc = fs.readFileSync(path.join(SRC_ROOT, 'providers/anthropic-sdk.ts'), 'utf-8');
    // It must accept one…
    expect(/abortSignal\?: AbortSignal/.test(sdkSrc)).toBe(true);
    // …and the ONE controller the SDK's `Options` exposes must still be reachable when there is
    // no declared patience at all, which is the case a stop has to work in.
    expect(/if \(timeoutMs != null \|\| abortSignal\)/.test(sdkSrc)).toBe(true);
    // T81d's discrimination is the invariant that must survive: only the TIMER may mint the
    // patience error, so an external stop is never reported as a declared-patience trip.
    const setters = sdkSrc.split('\n').filter((l) => /timedOutByPatience = true/.test(l));
    expect(setters, 'an external abort must never set the patience flag').toHaveLength(1);
    const timerBlock = sdkSrc.slice(sdkSrc.indexOf('if (timeoutMs != null) {'), sdkSrc.indexOf('if (abortSignal) {'));
    expect(timerBlock).toContain('timedOutByPatience = true');
  });

  it('callModel REFUSES to dial when the stop already landed — it reads the answer', () => {
    // `registerAbortable`'s boolean was discarded in the first cut; the pre-aborted signal was
    // trusted to propagate, which three transports do and the fourth did not.
    const src = fs.readFileSync(path.join(SRC_ROOT, 'agent/model.ts'), 'utf-8');
    expect(/if \(!registerAbortable\(/.test(src), 'the refusal is ignored again').toBe(true);
  });
});

// ── PROPERTY 3: the fence is the run's, and only the run retires it ──────────

describe('the continuation chain cannot re-arm itself after a stop', () => {
  it('THE RED: the turn-budget continuation is refused even after reset-session clears the stop flag', async () => {
    const { activeRuns, stoppedAgents, pendingWakeups, queueSelfWake } = await import('../shared-state.js');
    const { stopAgent } = await import('../runtime.js');
    seedAgent('working');
    activeRuns.add(AGENT);

    stopAgent(AGENT);
    // 04:25:23 — `POST /:id/reset-session` deletes the flag, legitimately (it is
    // about the NEXT run). The run stopped at 04:22:42 is still unwinding.
    stoppedAgents.delete(AGENT);

    // 04:27:10 — the forced compaction finishes and the checkpoint tries to park.
    expect(queueSelfWake(AGENT, 'turn-budget-continuation')).toBe(false);
    expect(pendingWakeups.has(AGENT), 'the stopped run queued its own next turn').toBe(false);
  });

  it('CONTROL: a REAL inbound arriving after the stop still queues — it is not a self-wake', async () => {
    const { activeRuns, pendingWakeups } = await import('../shared-state.js');
    const { stopAgent } = await import('../runtime.js');
    seedAgent('working');
    activeRuns.add(AGENT);
    stopAgent(AGENT);

    // `handleMessage`'s busy path — somebody asking for something new.
    pendingWakeups.add(AGENT);
    expect(pendingWakeups.has(AGENT)).toBe(true);
  });

  it('CONTROL: with no run in flight, a stop raises no fence to leak', async () => {
    const { stopFencedRuns } = await import('../shared-state.js');
    const { stopAgent } = await import('../runtime.js');
    seedAgent('idle');
    stopAgent(AGENT);
    expect(stopFencedRuns.has(AGENT), 'a fence nothing will ever clear is a silent hang').toBe(false);
  });

  it('THE RED (review IMPORTANT A-2): the tool executor halts on a stop that reset-session has "cleared"', async () => {
    // The scenario the review reproduced: owner stops mid-turn while a tool batch is running;
    // a reset-session lands two minutes later and lifts `stoppedAgents`. The executor's next
    // boundary check saw no stop and kept dispatching real side-effecting calls — a send, a
    // write, a calendar change — for a run the owner had stopped.
    const { activeRuns, stoppedAgents, isStopFenced } = await import('../shared-state.js');
    const { stopAgent } = await import('../runtime.js');
    seedAgent('working');
    activeRuns.add(AGENT);
    stopAgent(AGENT);
    stoppedAgents.delete(AGENT); // reset-session

    expect(isStopFenced(AGENT), 'the executor consults this at both batch boundaries').toBe(true);
  });

  it('THE CENSUS (review IMPORTANT A-2): no in-run checkpoint reads the raw flag any more', () => {
    // Five sites did: the pre-call gate, both model-call abandons, and the executor's two batch
    // boundaries. `stoppedAgents.has(` is now legitimate ONLY inside the fence predicate itself.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (rel(file) === 'agent/shared-state.ts') continue;
      codeLines(textOf(file)).forEach(({ line, n }) => {
        if (/stoppedAgents\.has\(/.test(line)) offenders.push(`${rel(file)}:${n} — ${line.trim()}`);
      });
    }
    expect(offenders, 'a checkpoint reading the raw flag is one reset-session can talk out of a stop').toEqual([]);
  });

  it('THE CENSUS: only the run\'s own exit path retires the fence', async () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (rel(file) === 'agent/shared-state.ts' || rel(file) === 'agent/runtime.ts') continue;
      codeLines(textOf(file)).forEach(({ line, n }) => {
        if (/stopFencedRuns\.delete\(/.test(line)) offenders.push(`${rel(file)}:${n} — ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

// ── PROPERTY 4: the status does not lie ──────────────────────────────────────

describe('the status field does not lie about a stop', () => {
  it('THE RED: a stop landing on a LIVE run never writes idle', async () => {
    const { activeRuns } = await import('../shared-state.js');
    const { stopAgent } = await import('../runtime.js');
    seedAgent('working');
    activeRuns.add(AGENT);

    stopAgent(AGENT);

    expect(statusOf(), 'the run is still consuming the loop; idle is a lie every reader believes')
      .toBe('working');
    const idleFrames = broadcasts.filter((b) => b.type === 'agent:status' && b.status === 'idle');
    expect(idleFrames, 'a cosmetic idle broadcast is the same lie on a second surface').toEqual([]);
  });

  it('a stopping run still says something truthful to the dashboard', async () => {
    const { activeRuns } = await import('../shared-state.js');
    const { stopAgent } = await import('../runtime.js');
    seedAgent('working');
    activeRuns.add(AGENT);

    stopAgent(AGENT);

    const frame = broadcasts.find((b) => b.type === 'agent:status');
    expect(frame).toMatchObject({ agentId: AGENT, status: 'working', stopping: true });
  });

  it('CONTROL: a stop on an agent with NO run in flight writes idle, because idle is true', async () => {
    const { stopAgent } = await import('../runtime.js');
    seedAgent('working');

    stopAgent(AGENT);

    expect(statusOf()).toBe('idle');
    expect(broadcasts.some((b) => b.type === 'agent:status' && b.status === 'idle')).toBe(true);
  });

  it('CONTROL: the stop marker is still armed for the next turn, on both paths', async () => {
    const { activeRuns } = await import('../shared-state.js');
    const { stopAgent } = await import('../runtime.js');
    seedAgent('working');
    activeRuns.add(AGENT);
    stopAgent(AGENT);
    const cfg = JSON.parse((mockDb.current!.prepare('SELECT config FROM agents WHERE id = ?')
      .get(AGENT) as { config: string }).config) as Record<string, unknown>;
    expect(cfg.stopMarkerPending).toBe(true);
  });

  it('THE RED (review IMPORTANT A-3): no in-run checkpoint writes idle before teardown', async () => {
    // Five of them did — the pre-call gate's stop and preempt arms, both model-call abandons,
    // the assemble empty-context exit, the thrash auto-block, the executor's stopped-mid-batch
    // — every one of them before finalize, before teardown, and long before `activeRuns` is
    // released. `teardown/index.ts`'s `settleStatus` is the one owner now.
    //
    // FIX ROUND 2 (review A-3 residual): `finalize` is no longer on this list. It was, on the
    // reasoning that its clean-path write was harmless because `settleStatus` would read it as
    // already-settled — but finalize is the LAST STATEMENT of the driver's `try`, so its write
    // landed before teardown's body, before `activeRuns.delete` and before the awaited tail, on
    // every non-abandon path. The window the ticket is about, narrowed rather than closed.
    const ALLOWED = new Set([
      'agent/v2/steps/teardown/index.ts',
      // OUTSIDE the driver's `try` (loop.ts:416) — preflight exits never reach teardown, so
      // these two must keep writing their own idle or the row stays `working` forever.
      'agent/v2/steps/preflight/turn-classification.ts',
      'agent/v2/steps/preflight/turn-trigger.ts',
    ]);
    // The corpus is the SHARED derivation, not a sixth hand-rolled walk of the step packages —
    // `guard-corpus-census.test.ts` refuses one, and it refused this clause's first cut.
    const offenders: string[] = [];
    const { engineSources } = await import('../v2/__tests__/engine-sources.js');
    for (const f of engineSources()) {
      if (ALLOWED.has(f.rel)) continue;
      codeLines(f.text).forEach(({ line, n }) => {
        if (/setAgentStatus\([^)]*'idle'\)/.test(line)) offenders.push(`${f.rel}:${n} — ${line.trim()}`);
      });
    }
    expect(offenders, 'idle written while the turn is still unwinding is the audited lie, seconds wide').toEqual([]);
  });

  it('teardown settles the status, and CANNOT clobber a diagnosis', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'agent/v2/steps/teardown/index.ts'), 'utf-8');
    // The guard is the whole safety of centralising it: an injured turn has already been moved
    // to error/paused by the recovery arm, a completed one reads terminated.
    expect(/row\?\.status !== 'working'\) return;/.test(src)).toBe(true);
  });

  it('THE RED (review IMPORTANT A-4): a stop that never tore down is reapable', async () => {
    const { stopFencedRuns } = await import('../shared-state.js');
    const { STUCK_AGENT_THRESHOLD_MINUTES } = await import('../stuck-thresholds.js');
    const src = fs.readFileSync(path.join(SRC_ROOT, 'agent/runtime.ts'), 'utf-8');
    const reaper = src.slice(src.indexOf('function recoverStuckAgents()'));

    // Before this round the reaper could not see this state at all: the honest `working` row
    // plus the deliberately-kept heartbeat kept it out of the stale query, and D18's
    // `activeRuns` guard would have skipped it anyway.
    expect(/for \(const \[agentId, stoppedAt\] of stopFencedRuns\)/.test(reaper),
      'the reaper is still blind to a stopped-then-wedged run').toBe(true);
    // Keyed on how long the STOP has gone unhonoured, not on updated_at, which the heartbeat
    // keeps fresh on purpose.
    expect(/Date\.now\(\) - stoppedAt/.test(reaper)).toBe(true);
    // D18's guard for ORDINARY long turns is untouched — that is what makes this a carve-out
    // rather than a hole.
    expect(/if \(activeRuns\.has\(agent\.id\)\) \{/.test(reaper)).toBe(true);
    // The fence carries a timestamp precisely so the age is answerable.
    expect(stopFencedRuns).toBeInstanceOf(Map);
    expect(STUCK_AGENT_THRESHOLD_MINUTES).toBeGreaterThan(0);
  });

  it('THE CENSUS: the stop route no longer writes its own idle behind the engine\'s back', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'gateway/routes/agents.ts'), 'utf-8');
    const stopHandler = src.slice(src.indexOf("agentsRouter.post('/:id/stop'"));
    const body = stopHandler.slice(0, stopHandler.indexOf("agentsRouter.post('/:id/reset-session'"));
    const writes = codeLines(body).filter(({ line }) => /status\s*=\s*'idle'/.test(line));
    expect(writes, 'the route wrote the same lie with raw SQL').toEqual([]);
  });
});

/**
 * The server's source files — WALKED ONCE for the whole suite.
 *
 * Four clauses here census the tree. Re-walking and re-reading every `.ts` under `src/` for
 * each of them is four full passes of real filesystem work, and vitest runs suites in parallel:
 * measured on this box, the added contention was enough to tip `work/__tests__/
 * work-event-kinds-conformance.test.ts` — a neighbouring 15-second whole-tree walk of its own —
 * over its per-clause timeout, failing a DIFFERENT clause of it on each run. A guard that makes
 * an unrelated guard flaky is a guard that will get muted. The tree does not change mid-run, so
 * one pass is all that was ever needed.
 */
let sourceFilesCache: string[] | null = null;
function sourceFiles(): string[] {
  if (sourceFilesCache) return sourceFilesCache;
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
  sourceFilesCache = out;
  return out;
}

/** Same reasoning for the file CONTENTS: read once, reused by every census below. */
const textCache = new Map<string, string>();
function textOf(file: string): string {
  let t = textCache.get(file);
  if (t === undefined) { t = fs.readFileSync(file, 'utf-8'); textCache.set(file, t); }
  return t;
}

function rel(p: string): string { return path.relative(SRC_ROOT, p); }

/**
 * Lines that are CODE, with their 1-based numbers — comment lines dropped.
 *
 * Every census in this file is a negative assertion over source text, and this tree's own
 * discipline is that a retired mechanism leaves a tombstone naming the exact bytes it
 * replaced. Both of those are right, and together they make a naive `split('\n')` census fail
 * on its own documentation: the first run of this suite flagged `model-call.ts`'s and
 * `teardown/index.ts`'s tombstones (which QUOTE `activeAbortControllers.delete(agentId)`) and
 * the stop route's own note (which quotes the `UPDATE … status = 'idle'` it deleted). A census
 * that cannot tell a call from a sentence about a call would be paid for in deleted history.
 */
function codeLines(text: string): Array<{ line: string; n: number }> {
  return text.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}
