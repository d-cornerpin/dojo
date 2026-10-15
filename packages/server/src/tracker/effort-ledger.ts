// t172 — THE LEDGER OF WHAT A TASK HAS ALREADY DONE: what makes a repeated call a repeat.
//
// The effort meter (`effort-governor.ts`: `effort_calls - effort_reviewed_calls`) used to be a bare
// call count, so a long walk of distinct pages was reviewed, and ruled circling, at the same 150
// calls as a loop re-reading one page. Circling is REPEATING the same calls with nothing new landing
// (the PM's own definition), so the meter now rises only by repeats: a call whose signature this task
// has not made since it last advanced is new, and moves the baseline in the same statement it is
// charged. This module is the signature, the per-task seen-set, and the facts the PM's review is
// given. A leaf: it imports only the one write function it needs.
import { createHash } from 'node:crypto';
import { writeEffortCharge } from '../work/effort-meter.js';

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

/** The task advanced (`advanceBaseline`): what it has "already done" starts over with it. */
export function forgetTaskCalls(taskId: string): void {
  ledgers.delete(taskId);
}
