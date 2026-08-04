// ════════════════════════════════════════
// "IS THAT WORK ROW STILL THERE?" — asked in ONE place (PHASE-6 T0D).
//
// ── WHY THIS MODULE EXISTS ──
// The stale-task-id class has two halves. The WRITE half is the doors: the state
// door (`transition()` G1) and the attribute door (`patchWork`) both refuse a
// row that is not there, by name and with the same steerable sentence.
//
// This is the OTHER half — the one the issues-log item names and the one that
// was still open: *session context must not carry dead task ids*. Two turn-state
// facts carried them, and both could REFUSE THE AGENT'S OWN LIVE TOOL CALLS on
// the strength of a row that no longer exists, which is the worst shape this
// class takes. A refused write is a fact the model can act on; a turn spent
// being refused because of a task that cannot be closed is a trap.
//
// The question was asked inline, in two different ways, inside an 8,787-line
// function. Asking it once, here, is what makes it testable — and the answers
// below are the whole of what `loop.ts` needs to decide.
//
// ── THE BOUNDARY THIS MODULE RESPECTS ──
// Collapsing the ambient turn-state maps into `TurnContext` is PHASE-6 T1's
// work. NOTHING here moves a map, and `ServedWork` is imported as a type from
// where it already lives. This is the validation half only; T1 re-verifies it
// once the maps collapse.
// ════════════════════════════════════════

import { getDb } from '../../db/connection.js';
import { CLOSE_OUT_WORK_OPS } from '../../tools/work-verbs.js';
import type { ServedWork } from '../turn-context.js';

/**
 * The three things a dangling id can be, and they are three and not two.
 *
 * The pre-fix split asked only `state = 'claimed'` and put EVERYTHING ELSE in
 * the on-deck bucket — so a DELETED id was indistinguishable from a live on-deck
 * straggler and was carried forward as one. `gone` is the fact that was missing.
 */
export interface DanglerSplit {
  /** Still claimed: the one-shot danglers the PM escalation is about. */
  readonly claimed: string[];
  /** Still there, not claimed: on-deck stragglers, left in place as before. */
  readonly onDeck: string[];
  /** No row. Dropped — never escalated, never refused against, never carried. */
  readonly gone: string[];
}

/** One query, three buckets, and every input id lands in exactly one of them. */
export function splitDanglers(ids: readonly string[]): DanglerSplit {
  // `id IN ()` is a syntax error, and an empty turn is the common case.
  if (ids.length === 0) return { claimed: [], onDeck: [], gone: [] };
  const rows = getDb()
    .prepare(`SELECT id, state FROM work WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as Array<{ id: string; state: string }>;
  const stateById = new Map(rows.map((r) => [r.id, r.state]));
  const claimed: string[] = [];
  const onDeck: string[] = [];
  const gone: string[] = [];
  // Driven from the CALLER's list rather than the query's, so order is the
  // caller's and a duplicate id cannot silently collapse into one bucket.
  for (const id of ids) {
    const state = stateById.get(id);
    if (state === undefined) gone.push(id);
    else if (state === 'claimed') claimed.push(id);
    else onDeck.push(id);
  }
  return { claimed, onDeck, gone };
}

/** The danglers that still exist, in the caller's order. */
export function survivingDanglers(ids: readonly string[]): string[] {
  const split = splitDanglers(ids);
  return ids.filter((id) => !split.gone.includes(id));
}

/** Whether the pre-turn close-out gate refuses this call, and what it may name. */
export interface CloseOutGateDecision {
  /** The danglers that still exist. The turn's list is replaced with this. */
  readonly live: string[];
  /** True only when a call is refused BECAUSE of work that is still there. */
  readonly refuse: boolean;
}

/**
 * THE GATE'S WHOLE DECISION, re-validated against the spine at the moment it
 * would refuse.
 *
 * The gate arms once, at turn start, from a live query — and a turn can run for
 * up to 75 loops and fifteen minutes. Anything can delete one of those rows in
 * between: another agent, the owner at the dashboard, a cascading parent close.
 * The gate then refused every tool call the agent made, naming ids the tracker
 * verbs correctly refuse in their turn, and instructing the model to close a
 * task that cannot be closed. That is the class's worst shape and it is what
 * this function exists to make impossible.
 *
 * The re-validation costs one query and only on the branch that was about to
 * refuse — the gate's three cheap conditions are tested first, in the order they
 * were tested before, so a turn with nothing dangling still asks the database
 * nothing.
 *
 * The other two conditions are copied verbatim and NOT reconsidered: `satisfied`
 * disengages the gate for the rest of the turn, and `CLOSE_OUT_WORK_OPS` is the
 * hand-picked work-family allowlist whose reasoning lives at its declaration.
 */
export function closeOutGateDecision(
  ids: readonly string[], satisfied: boolean, opKey: string,
): CloseOutGateDecision {
  if (ids.length === 0 || satisfied || CLOSE_OUT_WORK_OPS.has(opKey)) {
    return { live: [...ids], refuse: false };
  }
  const live = survivingDanglers(ids);
  return { live, refuse: live.length > 0 };
}

/**
 * The work this turn serves — or `null`, which is a DIFFERENT fact from "served
 * work whose kind we could not read".
 *
 * The engine event carries a task referent; the pre-fix code read that row for
 * its kind and published the referent to turn-state EVEN WHEN THE READ CAME BACK
 * EMPTY, so a deleted task rode the whole turn as `{ taskId, taskKind: null }`.
 * Five readers take that map, and one of them refuses the agent's `imessage_send`
 * when the kind is `reminder`; another stamps the id onto the turn record, and a
 * third onto a destructive-approval row. None of them re-checks.
 */
export function resolveServedWork(
  taskId: string | null | undefined, runId: string | null | undefined,
): ServedWork | null {
  if (!taskId) return null;
  const row = getDb().prepare('SELECT task_kind AS kind, origin_conv_key FROM work WHERE id = ?')
    .get(taskId) as { kind: string | null; origin_conv_key: string | null } | undefined;
  if (!row) return null;
  return {
    taskId,
    runId: runId ?? null,
    taskKind: row.kind ?? null,
    originConvKey: row.origin_conv_key ?? null,
  };
}
