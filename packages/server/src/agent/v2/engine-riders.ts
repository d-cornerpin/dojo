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
  // postAgentNotice: its own default plus every intent its callers pass
  'agent_notice', 'agent_health', 'block_validated', 'engine_event_expired',
  'image_delivery_outcome', 'learning_loop', 'pm_review_failed', 'schedule_run_failed',
  'schedule_run_failed_owner', 'scheduler_missed_runs', 'spawn_timeout_decision',
  'spawn_timeout_undecided', 'validation_check',
  // carried from the predicate's previous exclusion list; no live writer, still excluded
  'hint', 'system',
] as const;

/** The rider exclusion as a SQL fragment, so the predicate and the writers cannot drift.
 *  Literal by construction — every element is a lowercase identifier from the frozen list
 *  above, so this is not an interpolation surface and `kit-schema-conformance`-style prepare
 *  checks can still read the statement that embeds it. */
export const ENGINE_RIDER_INTENTS_SQL =
  `(${ENGINE_RIDER_INTENTS.map((i) => `'${i}'`).join(', ')})`;
