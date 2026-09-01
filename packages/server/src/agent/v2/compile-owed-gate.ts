// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 12 T47 — "IS THE OWNER STILL OWED THE COMPILED REPLY?", asked in ONE place.
//
// ── WHY THIS GATE EXISTS (round-12 S5, `round12/S5-catalog.md` §8.6) ──
// The redrive steer says, in its own words, "Do NOT search, open files, run commands, or call
// any tools first — not the tracker, not the vault, not a peer notification; everything you
// need is quoted below." Three steers carried that sentence. The model answered them with
// `load_tool_docs`, `history_search`, `history_get`, `work_update` (errored ×2) and
// `history_get`, across 12m26s, and never composed the reply. PERSUASION FAILED 3/3 while the
// owner sat waiting on content the platform already held.
//
// The owner's doctrine for round 12 is STRUCTURE OVER PERSUASION: where the engine asks the
// model to behave, make the right outcome mechanical instead. The forcing pattern already
// existed and already worked — `steps/preflight/closeout-gate.ts` refuses non-tracker tool
// calls until a tracker call lands, and it bit fourteen seconds after it armed. This is that
// pattern, pointed at the one duty the redrive ladder has already come back for.
//
// ── THE CONSTRAINT INHERITED VERBATIM, AND IT IS THE LOAD-BEARING ONE ──
// BUG-2, from the close-out gate's own header: THE GATE IS NEVER ARMED ON A TURN A HUMAN IS
// WAITING ON. Armed on a conversation turn that gate "(a) DELETED the agent's just-streamed
// reply and (b) REFUSED the tool calls the agent needed to answer". The arming half of that
// separation lives at this gate's own section (`steps/preflight/compile-gate.ts`, the same
// `triggerRow ? [] : …` ternary), and the invariant test that drives it is the close-out
// gate's own, extended (`agent/v2/__tests__/integration.test.ts`). It costs this gate nothing:
// the redrive steers arrive on engine-wake and A2A turns (S5: turns 4900/4901 kind `a2a`, 4902
// kind engine), which is the same lane class where the close-out gate arms legally.
//
// ── WHY THE MODULE, RATHER THAN A FEW LINES IN THE STEPS ──
// `stale-work-ids.ts`'s shape, for `stale-work-ids.ts`'s reason: a gate whose decision is
// spread across a preflight section and an execute branch is a gate no test can drive without
// running a turn. The decision and the two spine reads are here; preflight arms, execute
// enforces, and neither holds a rule of its own.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../db/connection.js';
import { SATISFYING_WORK_OPS } from '../../tools/work-verbs.js';
import { AUDIT_KIND } from '../../work/audit-trail.js';
import { JOIN_DRIVE_ENTRY } from '../../work/join-drive.js';

/**
 * THE ALLOWED SET, CLOSED AND NAMED — and it is a UNION, deliberately.
 *
 *   * the tracker calls that SATISFY the close-out gate. This is the collision the task
 *     required argued, and the union is the whole answer: a turn armed by BOTH gates must
 *     always have a legal move. The close-out gate demands a tracker call FIRST, in its own
 *     text; if this gate refused those, a turn armed by both would have nothing it could
 *     legally call and the model's only escape would be silence — the failure BUG-2 is about,
 *     arrived at from the other side. Because every member here is also in the close-out
 *     gate's allowlist, one tracker close-out satisfies that gate and passes this one, and the
 *     owed compile is then discharged by TEXT, which no gate blocks.
 *   * `send_to_agent`, because the redrive steer itself names exactly one exception to its own
 *     no-tools rule (T43b: "If a piece reads as a hand-off … send ONE send_to_agent message to
 *     the agent it names asking them for the result directly"). A gate that refused the one
 *     call its own steer instructs would be the engine contradicting itself at the decision
 *     moment.
 *
 * DELIBERATELY NOT HERE, and this is the point of the whole task: `load_tool_docs` and the
 * tracker READS (`work_update:get`/`:list`/`:edit`), which the close-out gate's broader
 * allowlist does permit. Reading a tool's schema is not composing the owner's reply, and
 * `load_tool_docs` is literally the first call S5's model made instead of composing.
 */
export const COMPILE_OWED_ALLOWED_OPS: ReadonlySet<string> = new Set<string>([
  ...SATISFYING_WORK_OPS,
  'send_to_agent',
]);

/**
 * THE ASKS THIS AGENT OWES A COMPILED REPLY ON, AND THE SYSTEM HAS ALREADY COME BACK FOR.
 *
 * Three facts, all recorded, none inferred:
 *   * the ask is a live join whose countdown reached zero and whose compile is still pending
 *     (the same predicate `compilePendingJoins` uses, plus the explicit countdown check);
 *   * at least one REDRIVE rung has been spent on it. A deferred pass is not a rung (T10) and
 *     does not count here either — the engine has to have genuinely put the owed step in front
 *     of the model and been ignored before it starts refusing the model's tools.
 *
 * The rung requirement is what keeps this proportionate. The join completing and the compile
 * order going out is NOT enough: at that moment steering has not yet failed, and arming an
 * enforcement gate against a model that has not been asked once is the shape of a trap.
 */
export function compileOwedAfterRedrive(agentId: string): string[] {
  return (getDb().prepare(`
    SELECT w.id AS id FROM work w
     WHERE w.agent_id = ?
       AND w.compile_pending = 1
       AND w.remaining_children = 0
       AND w.state NOT IN ('done','failed','abandoned')
       AND EXISTS (
         SELECT 1 FROM work_events e
          WHERE e.work_id = w.id AND e.kind = ?
            AND json_extract(e.payload, '$.entry_kind') = ?
       )
     ORDER BY w.opened_at ASC
     LIMIT 5
  `).all(agentId, AUDIT_KIND, JOIN_DRIVE_ENTRY.redrive) as Array<{ id: string }>).map((r) => r.id);
}

/**
 * OF THESE, WHICH ARE STILL OWED — asked again at the moment the gate would refuse.
 *
 * THE DISARM IS A READ, NEVER A LATCH, and that is what makes "disarms the moment the owed
 * reply lands or the join resolves any other way" true rather than promised. Every road out of
 * the duty comes through this one predicate: the model's own compiled answer (the ask settles
 * `done`), T48's engine relay (same settle), a fail-closed notice (`state='failed'`), and the
 * relay that could not move the row but cleared the flag (`clearJoinCompilePending`). None of
 * them has to know this gate exists.
 *
 * It also drops a row that VANISHED underneath the turn, which is PHASE-6 T0D's finding at the
 * close-out gate stated once more: a gate that refuses the agent's live tool calls on the
 * strength of a row that no longer exists is a trap, not an enforcement.
 */
export function stillCompileOwed(ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  const live = new Set((getDb().prepare(`
    SELECT id FROM work
     WHERE id IN (${ids.map(() => '?').join(',')})
       AND compile_pending = 1
       AND state NOT IN ('done','failed','abandoned')
  `).all(...ids) as Array<{ id: string }>).map((r) => r.id));
  // Driven from the CALLER's list so the order is the caller's, the same discipline
  // `splitDanglers` states for itself.
  return ids.filter((id) => live.has(id));
}

/** Whether the compile gate refuses this call, and what its refusal may name. */
export interface CompileOwedGateDecision {
  /** The asks still owed. The turn's list is replaced with this. */
  readonly live: string[];
  /** True only when a call is refused BECAUSE a compile is still genuinely owed. */
  readonly refuse: boolean;
  /**
   * T68b: the gate is armed and the compile is genuinely owed, but the assembly could NOT
   * confirm the pieces are in front of the model — so nothing is refused. Distinguished from
   * the ordinary "not refused" so the loop can log the engine defect instead of silently
   * standing down.
   */
  readonly standDownUnverified: boolean;
}

/**
 * THE GATE'S WHOLE DECISION, re-validated against the spine at the moment it would refuse.
 *
 * The three cheap conditions are tested first and in this order — nothing armed, the duty
 * already discharged this turn, the call is in the allowed set — so a turn with no owed
 * compile asks the database nothing. Only the branch that was about to refuse pays a query.
 * That is `closeOutGateDecision`'s shape and it is copied on purpose: two gates that answer
 * "may this call run?" should not have two different ideas of when to consult the spine.
 *
 * ── T68b — THE FOURTH CONDITION: THE GATE MAY NOT ASSERT WHAT IT HAS NOT VERIFIED. ──────
 *
 * `orderReachedModel` is the assembly's own verdict on whether the fan-out compile order
 * arrived in the emitted messages WHOLE (`memory/assembler.ts compileOrderIntact` — a
 * substring test on the platform's own bytes, not a reading of prose).
 *
 * The refusal this decision authorises says, in its own words, *"the pieces are in the steer,
 * quoted verbatim"*, and W61 measured that sentence FALSE in six recorded grinds out of six.
 * The trap it made was closed on all four sides: the order said the content was below, the
 * assembler had removed it, the gate refused the tools that would have retrieved it, and the
 * redrive ladder re-posed the same impossible task. The model — correctly — reasoned until its
 * entire output budget was gone, three times in twelve minutes, and wrote "I'm fabricating…
 * I keep going in circles" on the way.
 *
 * So: when the pieces are NOT confirmed present, the gate does not forbid retrieval. It is
 * still armed, the compile is still owed, the ladder still redrives and T48's relay still
 * ships the pieces itself if none of that works — the ONE thing that stops is refusing a
 * model's lookup on the strength of a claim nobody checked. This is deliberately the LAST
 * condition tested: an unverified order costs a spine read before it stands down, because
 * "is the duty real" is still the more important question and the answer feeds the caller's
 * list either way.
 */
export function compileOwedGateDecision(
  ids: readonly string[], satisfied: boolean, opKey: string, orderReachedModel: boolean,
): CompileOwedGateDecision {
  if (ids.length === 0 || satisfied || COMPILE_OWED_ALLOWED_OPS.has(opKey)) {
    return { live: [...ids], refuse: false, standDownUnverified: false };
  }
  const live = stillCompileOwed(ids);
  const owed = live.length > 0;
  return { live, refuse: owed && orderReachedModel, standDownUnverified: owed && !orderReachedModel };
}
