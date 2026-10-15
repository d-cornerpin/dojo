// SLOW-INFERENCE T79c — THE DURABLE EFFORT METER (wide loops accumulate what honest
// work doesn't).
//
// A wide loop's signature is effort-without-advancement, and until now nothing counted
// it anywhere a compaction could not erase: `agent/turn-state.ts`'s cross-turn maps are
// per-process, in memory, gone the moment a context compacts or the process restarts.
// `migrations/165_work_effort_meter.sql` puts the counter on the task row itself — see
// that file's header for the full argument (column placement, why two columns, why
// DEFAULT 0 is safe on a lived-in database, why no CHECK).
//
// THIS MODULE IS A LEAF, ON PURPOSE — relative to the two sides that both need it. It
// imports nothing from `tracker/pm-agent.ts` or `agent/v2/loop.ts`, so neither side
// importing this module creates a cycle:
//   * the CHARGE site (`agent/v2/steps/execute/tracker-counting.ts`) is inside the v2
//     loop, counting this iteration's work calls.
//   * the ADVANCE site (`work/tracker-store.ts:setTrackerStatus`, "the tracker's one
//     status writer") is inside the tracker's write layer, moving the baseline the
//     instant a task genuinely transitions.
// It does import `work/effort-meter.ts` for the two literal `UPDATE work` statements —
// not a cycle (that module imports only the DB connection), and not optional: the work
// spine's own single-writer conformance walk
// (`work/__tests__/single-writer-conformance.test.ts`, PART A clause (a)) requires every
// write to `work` to live under `work/`, so the SQL text itself cannot live here. This
// module stays the one the brief names and both call sites import — the declared
// constant, the delta arithmetic, and the two public write functions — it just hands the
// actual UPDATE off to the module the tree requires it to live in.
//
// CALLS ONLY, v1 (YAGNI, recorded so nobody "helpfully" widens this later): token
// attribution has no existing seam to ride, unlike calls (already counted at
// `tracker-counting.ts`'s RC-19 cross-turn accumulator). It is not built until a
// measured need names it.
//
// T79 FIX WAVE, FINDING 2 ADDED A THIRD READER, STILL A LEAF: `pendingCirclingVerdict` (below)
// reads the audit trail via `work/audit-trail.ts`'s `readAuditTrail` DIRECTLY, not through
// `tracker/task-log.ts`'s `listTaskLog` wrapper (a thin `readAuditTrail(...).map(mapRow)` —
// measured, not assumed). `task-log.ts` itself imports `gateway/ws.js` for its OWN broadcast
// calls elsewhere in that file; pulling it in here would hand every caller of the charge/
// advance sites (which is most of the write-side tracker) a NEW transitive edge to the
// websocket gateway, and one real test file's `vi.mock('gateway/ws.js', () => ({ broadcast }))`
// (a plain top-level closure variable, not `vi.hoisted`) broke the instant that edge existed —
// Vitest hoists `vi.mock` factories above the file's own local declarations, so a factory
// invoked earlier than before throws on the not-yet-initialized closure variable. `work/audit-
// trail.ts` imports only `db/connection.js`, `work/store.js` and `work/tracker-view.ts` — none
// of them the gateway — so reading it directly keeps this module the minimal leaf its header
// above already promises.
import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { readAuditTrail } from '../work/audit-trail.js';
import { writeEffortCharge, writeEffortBaseline } from '../work/effort-meter.js';

/**
 * The delta threshold T79d (not this module) reads to decide a task has made enough REPEATED
 * calls since its last real advancement to warrant a look. Declared HERE, with one owner,
 * because a second copy of this number anywhere else is the exact drift this plan's other
 * migrations (163, 164) already refused to create for their own constants.
 *
 * WHAT IT COUNTS (t172): calls that REPEAT within the task since it last advanced — the same
 * tool with the same arguments as an earlier call. A call that is new (another page of a long
 * chain, another file, another search) is progress and does not move the meter, so a sweep of
 * N distinct pages is never reviewed for being long. The number itself is unchanged; only what
 * is counted toward it is. See `chargeEffortCalls` below for how.
 */
export const EFFORT_REVIEW_DELTA_CALLS = 150;

/**
 * Charge `calls` counted work calls to a task's monotonic effort total. Called once per
 * iteration, from `tracker-counting.ts`, for the agent's current claimed task (its own
 * resolution of "current claimed task" mirrors the engine's existing tracker-floors nag
 * in shape; see that call site's comment for why).
 *
 * `calls <= 0` is a no-op: nothing was done, so nothing is charged, and it saves a write
 * on the (common) turns where this iteration's non-tracker count is zero.
 */
export function chargeEffort(taskId: string, calls: number): void {
  if (calls <= 0) return;
  writeEffortCharge(taskId, calls);
}

/** A tool call as the charge site sees it. */
export interface ChargeableCall { name: string; arguments?: unknown }

/** The arguments in a form that does not depend on key order: objects with sorted keys, arrays in
 *  order, `undefined` dropped. Two calls that differ only in how the model ordered its argument
 *  object are the same call. */
function canonicalArguments(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort()) {
        const val = (x as Record<string, unknown>)[k];
        if (val !== undefined) out[k] = norm(val);
      }
      return out;
    }
    return x;
  };
  try { return JSON.stringify(norm(v ?? {})) ?? '{}'; } catch { return String(v); }
}

/** What a call IS, for the purpose of "has this task already done exactly this": the tool and its
 *  canonically ordered arguments. A re-read of the same file at the same offset is the same call;
 *  the next page, or the same file at another offset, is not. */
export function callSignature(call: ChargeableCall): string {
  return createHash('sha1').update(`${call.name}\u0000${canonicalArguments(call.arguments)}`).digest('hex');
}

function callLabel(call: ChargeableCall): string {
  const canon = canonicalArguments(call.arguments);
  return `${call.name}(${canon.length > 140 ? `${canon.slice(0, 140)}…` : canon})`;
}

/** What this process has seen a task do since it last advanced. In memory ON PURPOSE (see
 *  `chargeEffortCalls`): the DURABLE half of the meter is the two columns. */
interface TaskCallLedger {
  seen: Set<string>;
  repeats: Map<string, { label: string; n: number }>;
  novel: number;
  repeated: number;
}
const ledgers = new Map<string, TaskCallLedger>();

/**
 * Charge one iteration's chargeable calls to a task (t172) — the call the charge site makes.
 *
 * Every call raises the lifetime total `effort_calls`, exactly as before. A call that is NOT a
 * repeat (its signature has not been seen on this task since it last advanced) also moves the
 * baseline `effort_reviewed_calls` by one, in the same statement, so the meter
 * `effortDelta = effort_calls - effort_reviewed_calls` rises only by REPEATS. A sweep of
 * distinct pages leaves it at 0; a loop re-issuing the same call raises it by one per call.
 * Every reader of the two columns (the queue, the pending check, the PM's review, the tests that
 * write them directly) is unchanged, because the meter is still that subtraction.
 *
 * WHERE THE SEEN-SET LIVES: in this process, per task, cleared the instant the task advances
 * (`advanceBaseline`). The columns are the durable record of how much has repeated; the set only
 * decides whether the NEXT call is a repeat. A server restart empties it, which can only make a
 * call read as new that was a repeat — so a restart can delay a review, never invent one. Putting
 * it in storage would be a migration for a fact that is cheap to relearn within a few calls.
 */
export function chargeEffortCalls(taskId: string, calls: readonly ChargeableCall[]): void {
  if (calls.length === 0) return;
  const ledger = ledgers.get(taskId) ?? { seen: new Set<string>(), repeats: new Map(), novel: 0, repeated: 0 };
  const newlySeen = new Set<string>();
  const repeatHits: Array<{ sig: string; label: string }> = [];
  for (const call of calls) {
    const sig = callSignature(call);
    if (ledger.seen.has(sig) || newlySeen.has(sig)) repeatHits.push({ sig, label: callLabel(call) });
    else newlySeen.add(sig);
  }
  writeEffortCharge(taskId, calls.length, newlySeen.size);
  // The write landed; only now does the in-memory picture move with it.
  for (const sig of newlySeen) ledger.seen.add(sig);
  ledger.novel += newlySeen.size;
  ledger.repeated += repeatHits.length;
  for (const { sig, label } of repeatHits) {
    const prev = ledger.repeats.get(sig);
    if (prev) prev.n += 1; else ledger.repeats.set(sig, { label, n: 1 });
  }
  ledgers.set(taskId, ledger);
}

/** The novelty facts the PM's review is judged on: what this task has done since it last advanced,
 *  split into new calls and repeats, with each repeated call and how many times. `null` when this
 *  process has charged nothing to the task since it last advanced (a restart, or no calls). */
export interface EffortNoveltyFacts {
  novelCalls: number;
  repeatedCalls: number;
  repeatedSignatures: Array<{ label: string; count: number }>;
}
export function effortNoveltyFacts(taskId: string): EffortNoveltyFacts | null {
  const l = ledgers.get(taskId);
  if (!l) return null;
  return {
    novelCalls: l.novel,
    repeatedCalls: l.repeated,
    repeatedSignatures: [...l.repeats.values()].sort((a, b) => b.n - a.n).map((r) => ({ label: r.label, count: r.n })),
  };
}

/** The novelty facts as the PM's review prompt states them. After a restart there is no ledger, and
 *  the line says so rather than guessing. */
export function effortNoveltyLines(taskId: string): string {
  const facts = effortNoveltyFacts(taskId);
  if (!facts) {
    return 'Per-call detail is not held for this task (the server restarted since it last advanced); the repeat count above is exact.';
  }
  const lines = [`Since the task last advanced: ${facts.novelCalls} new (distinct) calls, ${facts.repeatedCalls} repeated calls.`];
  if (facts.repeatedSignatures.length === 0) {
    lines.push('Repeated calls: none.');
  } else {
    lines.push('Repeated calls, most repeated first (count: call):');
    for (const r of facts.repeatedSignatures.slice(0, 15)) lines.push(`  ${r.count}x ${r.label}`);
    if (facts.repeatedSignatures.length > 15) lines.push(`  (+${facts.repeatedSignatures.length - 15} more repeated calls)`);
  }
  return lines.join('\n');
}

/**
 * The meter itself: how much REPEATED effort has landed on this task SINCE it last genuinely
 * advanced (t172: novel calls move the baseline as they are charged, so what is left is the
 * repeats — see `chargeEffortCalls`). A plain subtraction, not a query — callers that already have the two
 * columns (a `listTasks`/`getTask` row extended with them, or a hand-picked SELECT)
 * pass them straight in, so this survives anything that wiped IN-MEMORY state (the
 * compaction this whole plan exists to route around) as long as the two columns
 * themselves were read from the database.
 */
export function effortDelta(row: { effort_calls: number; effort_reviewed_calls: number }): number {
  return row.effort_calls - row.effort_reviewed_calls;
}

/**
 * Move the baseline to the task's CURRENT monotonic total — the meter reads 0 again,
 * and the lifetime total in `effort_calls` is untouched (advancement moves the
 * baseline; it never erases history).
 *
 * TWO CALLERS, BOTH NAMED HERE SO THIS COMMENT STAYS TRUE (updated for SLOW-INFERENCE T79d,
 * which added the second):
 *
 *   1. `work/tracker-store.ts:setTrackerStatus`, and only when that call's own `transition()`
 *      result is `kind: 'applied'` — a genuine state move, never a refusal and never G4's
 *      "already in that state" no-op.
 *   2. `tracker/pm-agent.ts:runEffortReview` — the PM's out-of-band judgment on a task that
 *      tripped `EFFORT_REVIEW_DELTA_CALLS` without advancing, on EITHER verdict (advancing:
 *      the look confirms real progress, so the baseline extends to match; circling: the
 *      baseline still moves, so the stalled task re-reviews after another 150 calls instead
 *      of spinning every sweep tick — see that function's own header for the full argument).
 *
 * THE SAFETY INVARIANT THIS PROTECTS, RESTATED HONESTLY: a looping agent still cannot reset
 * its own meter. Neither caller is reachable from the assignee's own say-so — caller 1 is
 * gated on a REAL transition (never the agent's own same-status spam, the "[NO-OP]"
 * adversarial case), and caller 2 is gated on the PM's judgment, a SEPARATE agent's model
 * call reasoning over the durable record, never the assignee calling a tool. The assignee can
 * generate effort; it can never itself decide that effort counted.
 */
export function advanceBaseline(taskId: string): void {
  writeEffortBaseline(taskId);
  // t172: the task has moved, so what it has "already done" starts over with it.
  ledgers.delete(taskId);
}

// ════════════════════════════════════════════════════════════════════════════════════════
// T79 FIX WAVE, FINDING 2 — MOVED HERE FROM `tracker/pm-agent.ts` (T79d's original home),
// so the checkpoint side (`work/engine-checkpoint-note.ts`) can read a pending circling
// verdict TOO, without importing `pm-agent.ts` from the v2 loop — a module `pm-agent.ts`
// itself pulls in (`agent/runtime.ts`, the full A2A transport, the scheduler) would be a real
// import cycle the instant anything under `agent/v2/` reached back into it. This module is
// already the declared LEAF both the charge site and the advance site import without a cycle
// (see the file header above); `pendingCirclingVerdict` reading `work/audit-trail.ts` directly
// (see the import comment above for why NOT `tracker/task-log.ts`) adds nothing new to that
// shape.
//
// `pm-agent.ts`'s own poke-sweep fill-in (the guarded delivery path, unchanged by this move)
// now imports `pendingCirclingVerdict` from here instead of defining it locally — one
// function, two readers, the exact "one place" this whole plan's other leaves already argue
// for.
// ════════════════════════════════════════════════════════════════════════════════════════

/** Has a rung-2-or-higher poke already gone out for this task SINCE the given event id? */
function circlingPokeAlreadyDelivered(taskId: string, sinceEventId: number): boolean {
  const row = getDb().prepare(`
    SELECT 1 FROM work_events
     WHERE work_id = ? AND kind = 'poke' AND id > ?
       AND CAST(json_extract(payload, '$.rung') AS INTEGER) >= 2
     LIMIT 1
  `).get(taskId, sinceEventId);
  return !!row;
}

/**
 * A circling verdict `runEffortReview` (`tracker/pm-agent.ts`) recorded that has not yet
 * reached the assignee. Two readers deliver it, and BOTH latch through the same marker: the
 * poke sweep's guarded fill-in (behind the `assigneeStatus === 'working'` guard) and the
 * engine checkpoint park-message line (`work/engine-checkpoint-note.ts`, T79 FIX WAVE FINDING
 * 2 — surfaces it at the one moment a never-idle agent is guaranteed to read fresh context).
 *
 * `sinceEventId` is the `work_events.id` (never a timestamp) the verdict was recorded at, for
 * the same reason `work/poke-ladder.ts` bounds its own escalation cycle on an event id rather
 * than `created_at`: two writes can land in the same millisecond, an autoincrement id cannot
 * repeat. Returns `null` once a rung-2-or-higher poke has actually gone out since — see
 * `circlingPokeAlreadyDelivered` — so a delivered verdict cannot be re-forced forever, by
 * EITHER reader: whichever one delivers first records the SAME rung>=2 marker the other one
 * checks, so the two can never both deliver the same verdict.
 */
export function pendingCirclingVerdict(taskId: string): { reason: string; sinceEventId: number } | null {
  const last = readAuditTrail(taskId, { limit: 1, kinds: ['effort_review_intervene'] })[0];
  if (!last || !last.reason) return null;
  const sinceEventId = last.id;
  if (!Number.isFinite(sinceEventId)) return null;
  if (circlingPokeAlreadyDelivered(taskId, sinceEventId)) return null;
  return { reason: last.reason, sinceEventId };
}
