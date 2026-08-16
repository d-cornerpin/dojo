// PHASE-2 T10H — ENGINE RIDERS: engine rows that ride a turn and must never BE one.
//
// The sibling of `engine-steer.ts`, and deliberately beside it: that module owns "an engine
// directive must reach the model through the sanctioned channel"; this one owns "and it must
// never become a turn of its own." Both exist because the rule used to live as a comment plus
// a list of corrected sites, which is how F-18 recurred.
//
// ── THE TWO KINDS OF EVENTS-LANE ROW ──
// A **deliverable event** IS the reason for a turn: a schedule fire, a tracker assignment, a
// reminder, a healer action, a peer's completion report, an a2a request, a spawn kickoff, a PM
// review. The runtime drain exists to give it one.
//
// A **rider** is content that must be SEEN during a turn that is happening anyway: a thrash
// steer, a delegation hint, an owed-work interrupt, a promise floor, an a2a-handoff floor, an
// auto-scaffold prompt, the fan-out join's compile order, and every inter-agent awareness
// notice. Its delivery is `pendingNudge` or the deliverable's own wake.
//
// requirement preserved: content that rides a turn is never itself the reason for one.
//
// ── WHY THIS LIST EXISTS AT ALL, AND WHY IT IS NOT A COLUMN OR A LANE ──
// The requirement used to be carried by writing a fake conversation key —
// `conv_key='engine-steer'` at nine steer sites, `'engine-notice'` at every awareness notice —
// purely so `getPendingEngineEvent`'s `conv_key IS NULL` predicate would stop returning the
// row. PHASE-2 T9 correctly moved that claim onto `served_by_turn`, the real serve edge,
// because `conv_key` is conversation IDENTITY and a claim had no business living there.
//
// ⚠ BUT THE SENTINEL WAS THE ONLY THING EXCLUDING RIDERS, AND NOTHING TOOK OVER THE JOB.
// The predicate's own exclusion named three intents (`thrash_gate`, `hint`, `system`) against
// ten writers, and only one of the three is ever written. So after T9, 21 rider intents were
// eligible to drive a turn of their own while ten comments still said they were not.
//
// It failed SILENTLY for four sittings, and the silence is the interesting part: the drain's
// engine arm (`agent/runtime.ts:767`) calls `underWakeBudget` and logs NOTHING, so a rider
// left unclaimed at the end of a session re-arms a wake on every turn end until the per-agent
// wake budget trips at 30. The trip is the only visible symptom, it logs at ERROR level, and
// it is the entirety of `fanout-serves-all-pieces`' recorded red — one product event that
// `NO_WAKE_CHURN` counts as `[BREAKER]` and `NO_UNHANDLED_ERROR` counts again as an error
// line. Run `bms6sz1vbdt` left the proof on the box: one `origin_intent='fanout_join'` row
// carrying `conv_key='engine-steer'` with `served_by_turn` NULL, returned by
// `getPendingEngineEvent` — the sentinel excluding nothing.
//
// Measured before choosing the shape of the fix (#14/#15):
//   * `lane` is a hard CHECK of three values (`owner`/`a2a`/`events`), so a fourth lane is a
//     table rebuild plus every lane reader in the tree;
//   * `display_kind` is `engine-note` for all 399 events-lane rows on this box and therefore
//     distinguishes nothing;
//   * adding a column in the phase whose job is deletion is the disease this overhaul exists
//     to cure.
// The predicate ALREADY carried an `origin_intent NOT IN (...)` exclusion. This module does
// not introduce that mechanism — it gives it one owner and makes it COMPLETE.
//
// Every intent below was re-derived from its writer by command at `e04850f`, never inherited:
//
//   grep -na "convKey: 'engine-steer'" packages/server/src/agent/v2/loop.ts \
//            packages/server/src/agent/a2a-transport.ts          -> 9 sites
//   grep -rna -A6 "postAgentNotice({" packages/server/src | grep -o "intent: '[a-z0-9_]*'"
//                                                          -> 12 distinct intents
//
// `hint` and `system` have no live writer on this tree and are KEPT anyway: the predicate
// excluded them before this change, and removing a value from an exclusion list ADMITS those
// rows as turn drivers. A dead value inside a live predicate is residue to REPORT, never a
// widening to perform quietly (#15).
//
// A new rider must join this list, and `__tests__/engine-rider-never-drives-a-turn.test.ts`
// fails the build if one does not — 21 of its clauses were RED before this module existed.

export const ENGINE_RIDER_INTENTS = [
  // the nine steer sites (loop.ts ×8, a2a-transport.ts ×1)
  'thrash_gate', 'thrash_drift', 'thrash_block', 'delegation_hint', 'owed_interrupt',
  'promise_floor', 'a2a_handoff_floor', 'auto_scaffold', 'fanout_join',
  // PHASE-4 T4 (OR2) — the tenth, and it is a CONVERSION: the reminder-silence floor used to
  // have no steer at all because the ENGINE delivered the reminder itself, as the agent, on
  // the owner's lane. It steers now, so it needs a rider intent, and a rider must never drive
  // a turn of its own — which is exactly right here: the note is the engine asking the agent
  // to say something on THIS turn, not a new turn's worth of work.
  'reminder_silence_floor',
  // PHASE-4 T4 (the 2026-07-30 owner ruling) — the fallen-project note. It used to be an
  // OWNER-LANE `role='system'` owner-alert (nine such rows on the dev box, user-visible, on
  // the dashboard's allowlist — measured, against an inherited claim that it reached nobody).
  // The ruling is that the platform does not alert the owner directly here: the agent is told
  // and decides. A rider is exactly the right shape for that — it never drives a turn of its
  // own, so the note rides the agent's next turn instead of manufacturing one.
  'project_needs_attention',
  // postAgentNotice: its own default plus every intent its callers pass
  'agent_notice', 'agent_health', 'block_validated', 'engine_event_expired',
  'image_delivery_outcome', 'learning_loop', 'pm_review_failed', 'schedule_run_failed',
  'schedule_run_failed_owner', 'scheduler_missed_runs', 'spawn_timeout_decision',
  'spawn_timeout_undecided', 'validation_check',
  // SWEEP CORE-2 item 3 (SWEEP-F T2) — the skipped-reminder heads-up, converted off the dead
  // `role='system'` channel. Same shape and same reasoning as `project_needs_attention` above:
  // a reminder the owner asked for is not going to happen, the AGENT is the one who tells him,
  // and the note rides the agent's next turn rather than manufacturing one of its own.
  'reminder_skipped_owner',
  // SWEEP CORE-2 item 3 — the version-gap reconciliation pass's ONE plain line. Same shape and
  // same 2026-07-30 ruling as `project_needs_attention` above: the platform does not alert the
  // owner directly about the state of his projects; the AGENT is told and decides. A rider is
  // exactly right — a report about wreckage from an older version is not urgent enough to
  // manufacture a turn, and it must not be, on the first boot after an update.
  'version_gap_reconcile',
  // carried from the predicate's previous exclusion list; no live writer, still excluded
  'hint', 'system',
] as const;

// ════════════════════════════════════════════════════════════════════════════════════════
// HL4 STEP 2 (2c) — THE SECOND CHANNEL, DECLARED.
//
// The list above governs ONE property of a rider: it must never drive a turn of its own.
// W27's census (§5.7, "THE BIG ONE") found a second property nothing governed at all, and
// called it the honest answer to *"is the queue the one door?"* — today it is not. Some
// queue floors write their steer's text to BOTH channels: the queue (delivered inside this
// turn, ordered by `STEER_PRECEDENCE`, latched per floor) and the events lane (lifted into
// `lane.events` on a LATER turn by `memory/assembler.ts`, ordered by recency, with no
// priority and no budget of its own). Nothing dedups across them.
//
// THE PAIRING WAS UNDECLARED, AND THE INHERITED COUNT WAS WRONG. The plan and the census
// both say SIX floors; re-derived from the writers at `e8b7b56` there are SEVEN — `thrash-*`
// is two distinct floors with two distinct steers, not one. That is exactly why this belongs
// in code beside the writers rather than in a report: a hand-counted set drifts, and the
// conformance clause that reads this map fails the build when it does.
//
// WHAT IS DECLARED, AND IT IS THREE THINGS:
//   1. THE PAIRING — which steer floor writes which rider intent, in one place.
//   2. THE BUDGET — at most ONE paired rider per floor per turn. This is not a new bound:
//      every one of the seven sites is already gated on the queue's own latch BEFORE it
//      writes (`steerFired` / `steerFireCount` / the shared tracker latch), so the rider
//      inherits the queue's budget by construction. Declaring it is what stops the eighth
//      site from being written without one.
//   3. THE CONTENT IDENTITY — the rider carries the steer's OWN bytes, so the two channels
//      can never diverge into two different instructions about the same fact.
//
// ⚠ WHAT WAS NOT DONE HERE, AND WHO DECIDED IT — T53 (owner ruling 5, 2026-08-16).
// Step 2 declared the pairing and handed the design call up: *fallback worth a duplicate, or
// duplicate worth losing the fallback?* The owner ruled CLEAN UP, with absolute care, and the
// measurement that settled WHICH channel goes is driven in
// `agent/v2/__tests__/the-second-channel-stops-double-writing.test.ts`:
//
//   * THE RIDER IS ABSENT FROM THE TURN ITS FLOOR FIRES. The tail query drops `role='user'`
//     rows created after the turn boundary (`memory/store.ts`), and an events row is
//     `role='user'` by construction. The "cross-turn fallback" reading was right that the row
//     outlives the turn and wrong that it stands in for the steer: it cannot reach the extra
//     model call the floor's own `continueLoop` was spent to buy.
//   * WHAT IT DELIVERS LATER IS A TRUNCATED ECHO. `lane.events` renders a ≤400-char gist with
//     the leading bracket stripped, under a header framing it as something the agent is merely
//     AWARE of. The queue delivers the steer's own bytes, verbatim, in-turn.
//
// So the queue was always the carrier, and each retired site keeps it: `persistEngineSteer`
// (the RC-19 door) files the SAME entry and writes the durable `role='system'` row that used
// to be the events row — same bytes, same display classification (`agent-only`/`engine-note`),
// no model-facing second copy. The map below is the LEDGER of what has not been cleaned yet;
// a site leaves it in the same commit that stops its write, and `the-second-channel-is-governed`
// fails the build in both directions if the two disagree.
//
// THE INTENTS THEMSELVES STAY IN `ENGINE_RIDER_INTENTS` ABOVE, with no live writer, for the
// reason that list already states: rows stamped with them exist on every box, and removing a
// value from a live exclusion ADMITS those rows as turn drivers.
// ════════════════════════════════════════════════════════════════════════════════════════

/** A steer floor that writes its text to the events lane as well as to the queue. */
export interface QueuePairedRider {
  /** The events-lane `originIntent` the floor writes beside its steer. */
  readonly intent: string;
  /**
   * THE DECLARED BUDGET, as the exact guard the site is gated on — one paired rider per
   * floor per turn (per KEY, where the latch is keyed). Four spellings exist and they are
   * named rather than pattern-matched, because "some latch is nearby" is not a bound: the
   * conformance clause requires THIS expression above THIS site.
   */
  readonly latch: string;
}

export const QUEUE_PAIRED_RIDERS: Readonly<Record<string, QueuePairedRider>> = Object.freeze({
  'owed-interrupt':    { intent: 'owed_interrupt',          latch: "steerFired(state.steerQueue, 'owed-interrupt')" },
  'promise-floor':     { intent: 'promise_floor',           latch: "steerFired(state.steerQueue, 'promise-floor')" },
  'a2a-handoff-floor': { intent: 'a2a_handoff_floor',       latch: "steerFireCount(state.steerQueue, 'a2a-handoff-floor')" },
  'reminder-silence':  { intent: 'reminder_silence_floor',  latch: "steerFireCount(state.steerQueue, 'reminder-silence')" },
  // RETIRED by T53, both thrash rungs: they now steer through `persistEngineSteer` and write
  // no events-lane row. Their intents stay excluded above; only the pairs are gone. The gate's
  // entry recorded the one bound that was NOT a queue read — the per-SIGNATURE latch on
  // `state.thrashGatedSignatures` — and that latch is untouched by the removal: it is still
  // the gate's own guard, and the queue entry it files is still keyed by `thrash.signature`.
  // The shared subsystem latch: either tracker floor speaking is enough, which is the
  // requirement the retired `nudgedForTrackerThisTurn` boolean carried beside its latch duty.
  'tracker-scaffold':  { intent: 'auto_scaffold',           latch: 'steerFiredAny(state.steerQueue, TRACKER_STEER_FLOORS)' },
});

/** The rider exclusion as a SQL fragment, so the predicate and the writers cannot drift.
 *  Literal by construction — every element is a lowercase identifier from the frozen list
 *  above, so this is not an interpolation surface and `kit-schema-conformance`-style prepare
 *  checks can still read the statement that embeds it. */
export const ENGINE_RIDER_INTENTS_SQL =
  `(${ENGINE_RIDER_INTENTS.map((i) => `'${i}'`).join(', ')})`;
