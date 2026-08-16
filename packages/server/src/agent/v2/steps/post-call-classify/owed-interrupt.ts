// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — THE OWED MID-TURN INTERRUPT (F3), moved byte-faithfully out of
// `loop.ts`'s `postCallClassify` span: a person who spoke WHILE the turn was running is
// owed an answer before the turn is allowed to end, and this is the re-prompt that gets
// them one.
//
// It opens with a TOMBSTONE that is kept deliberately — the same-turn scaffold close
// (`closeEngineScaffoldSameTurn`) died with the empty-project machine, and the note
// stays because a removal that cannot say what it removed comes back. `MAX_TOOL_LOOPS`
// is PASSED rather than moved: it has readers outside this span.
// ════════════════════════════════════════

import { createLogger } from '../../../../logger.js';
import { broadcast } from '../../../../gateway/ws.js';
import { advance, type AgentTurnState } from '../../state.js';
import { persistEngineSteer } from '../../engine-steer.js';
// T53: `enqueueSteer` is gone from this file — the re-prompt goes through the RC-19 door,
// which owns the enqueue and the durable row.
import { steerFired } from '../../steer-queue.js';
import { getOwedMidTurnArrivals } from '../../counterparty.js';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/** The owed mid-turn interrupt re-prompt. */
export async function runOwedInterrupt(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const {
    agentId, chosenConvKey, counterparty, isEngineTurn, maxToolLoops, turnCtx,
    turnNumber, turnStartedAt,
  } = ctx;
  const MAX_TOOL_LOOPS = maxToolLoops;
  const { persistedContent } = sc;

  // ── THE SAME-TURN SCAFFOLD CLOSE IS GONE (PHASE-2 T8c item 3) ──
  // `closeEngineScaffoldSameTurn` and this call site both die with the empty-project
  // machine, exactly as the plan's Step 4 says. The turn-start classifier no longer
  // opens a project+task before the model has done anything, so there is no pre-emptive
  // scaffold to dangle `in_progress` on a read-only turn and become a ghost-done
  // re-delivery. The >=6 floor's row describes work that DEMONSTRABLY happened (six
  // real tool calls), so closing it on the strength of a reply would be the engine
  // adjudicating success — the thing the two-key contract exists to refuse.
  // requirement preserved: an engine-opened row cannot dangle. Three surviving
  // mechanisms see it — the going-idle close-out gate, the PM ladder's
  // delivery-evidence consult (strike 1 steers the close, strike 2 closes on the
  // receipt), and the reaper. What is gone is the one path that bypassed all three.

  // ── F3: owed mid-turn interrupt re-prompt ──
  // A quick question that lands WHILE a turn is running is NOT an interrupt:
  // its wakeup row sits conv_key NULL and rides into the running turn's
  // per-iteration reassembled tail (runtime.ts). At teardown,
  // the assembled-context set covers every same-conversation user row that was in
  // the answered context (conv_key NULL, created_at <= the final assembly) so a
  // burst can't earn a duplicate answer, a requirement we KEEP intact. The gap
  // it leaves: "in context when we answered" is treated as "was answered", so a
  // DISTINCT factual question that arrived mid-task is claimed as served and
  // never answered anywhere (the weak model absorbs the interruption silently).
  //
  // Fix the CAUSE, don't suppress the claim: on a user turn that produced a
  // reply, give the model exactly ONE more round to address any owed mid-turn
  // arrival BEFORE the same teardown claim marks it served.
  // getOwedMidTurnArrivals scopes to the
  // EXACT set the claim will take (same conv-scoping + window) narrowed to
  // mid-turn arrivals (created_at > turnStartedAt), so the trigger and any
  // pre-turn burst siblings (answered as the turn's subject) are excluded.
  //
  // Placed AFTER the F2.1 scaffold close so that close still runs on THIS
  // iteration's reply (it must not be deferred into the extra
  // round), and it yields to the going-idle hardcap above (which breaks first on
  // a worked-task-with-danglers turn) so this never fights that reconciliation.
  // One-shot (the queue's own latch for `owed-interrupt`) and skipped at the loop cap, so it
  // can neither spin the loop nor push past MAX_TOOL_LOOPS.
  //
  // ── UX-REPAIR ROUND 7.5 T31 — WHAT THE ROUND IS FOR CHANGED, AND SO DID WHO ANSWERS ──
  //
  // The paragraph above says the round exists so the model can ADDRESS the arrival, and the
  // steer used to say "Reply ONLY to it". Measured twice on the dev box (W11's replay and my
  // own control at `e0b5804`), that is what produced two answers to one question: the arrival
  // is answered here AND on the turn the wakeup drains into, with different content both
  // times ("Darknet Diaries…" then "Hardcore History…"). T25's record — correctly — keeps this
  // turn's delivery off that ask, so the second turn always comes.
  //
  // Ruling: the arrival's ONE answering turn is its own. This round now exists so the model
  // can STOP or ADJUST work the arrival changed; the steer says so, and `closeout-floors.ts`
  // holds whatever it writes as a working note, keyed on `owedInterruptGrant` below.
  //
  // A DISCRIMINATOR THAT WAS TRIED HERE AND FAILED, recorded so it is not tried again: the
  // old text offered `[no-reply]` for "my earlier reply already answered it", and honouring
  // that declaration would let the earlier delivery close the ask instead of it re-serving. It
  // was built and driven (2026-08-11, floor model, luggage/podcast replay): the turn answered
  // its OWN subject only, the arrival untouched — and the model returned `[no-reply]` anyway.
  // Acting on it closed the podcast ask on the LUGGAGE delivery: T25's defect restored by a
  // change meant to help. The owner priority (`ask-settlement.ts:19-26`) settles the direction
  // of error — ambiguity resolves toward answering, never toward closing — so the sentinel is
  // no longer asked for and nothing here reads the round's outcome.
  // ── UX-REPAIR ROUND 7.5 T32 LEG B1 — THE STEER STOPS WAITING FOR A REPLY TO EXIST ──
  //
  // Round-7 S6, verified in the ledger: "Never mind, forget the earbuds" landed at 00:40:58,
  // twenty seconds into turn 4679's research, and turn 4679 delivered the full 1,900-character
  // earbuds comparison at 00:41:05 — SEVEN SECONDS AFTER the user said not to bother. The
  // arrival was in the reassembled tail the whole time; the only step that POINTS at it could
  // not run, because the gate below required a reply to already exist. On a turn spent in tool
  // calls, that is after the answer nobody wanted has been written.
  //
  // So the two jobs this block used to do in one instant are separated, and the split is a
  // T25 guarantee rather than a tidy-up:
  //   * STEERING may happen as early as the arrival is visible — that is the whole point;
  //   * RECORDING may not move with it. `recordOwedInterruptSubjects` takes MAX(deliveries
  //     .rowid) as its high water AT THE MOMENT OF WRITING, and T25's narrowing excludes only
  //     deliveries at or below it. Written on a pass before the turn's own answer exists, the
  //     water would predate that answer and hand it back the right to close an ask it never
  //     addressed — T25's defect, restored by a change meant to help. It therefore stays where
  //     it was: the first pass on which a reply exists, once per turn (`state
  //     .owedInterruptSubjectsRecorded`).
  // One steer per turn either way (the queue's own latch), still bounded by MAX_TOOL_LOOPS.
  const hasReply = !!persistedContent && persistedContent.trim().length > 0;
  const mayRecord = hasReply && !state.owedInterruptSubjectsRecorded;
  const maySteer = !steerFired(state.steerQueue, 'owed-interrupt') && state.loopCount < MAX_TOOL_LOOPS;
  // A pass that RODE TOOL CALLS is the in-flight case, and it must not take the loop: the model
  // is already getting another round to run them in, and returning `continue` here would skip
  // the execute phase and drop the calls on the floor. The steer rides into the next assembly
  // on its own.
  const ridingToolCalls = ctx.result.toolCalls.length > 0;
  if (
    counterparty.kind === 'user' &&
    !isEngineTurn &&
    (maySteer || mayRecord) &&
    turnCtx.lastAssembledAtIso &&
    chosenConvKey &&
    chosenConvKey !== 'engine'
  ) {
    let owed = getOwedMidTurnArrivals(agentId, chosenConvKey, turnStartedAt, turnCtx.lastAssembledAtIso);
    if (owed.length > 0) {
      // Belt-and-suspenders on top of the query's origin_kind='engine' filter:
      // never quote human text that merely opens with an engine tag ([System:,
      // [A2A:, [SOURCE: ...) back into a model-visible re-prompt.
      const { looksLikeEngineMessage } = await import('../../classifiers/multistep.js');
      owed = owed.filter((m) => !looksLikeEngineMessage(m.content));
    }
    if (owed.length > 0) {
      const quoted = owed
        .slice(0, 3)
        .map((m) => `"${m.content.replace(/\s+/g, ' ').trim().slice(0, 200)}"`)
        .join('; ');
      const itThem = owed.length === 1 ? 'it' : 'them';
      // ── UX-REPAIR ROUND 7.5 T31 — THE STEER STOPS ASKING FOR A SECOND ANSWER ──
      //
      // It used to say "Reply ONLY to it, in one or two sentences", and that sentence is what
      // bought the duplicate: the arrival is not this turn's to answer. Its own turn serves it
      // — the wakeup is already queued, `getOwedMidTurnArrivals` found it precisely because
      // nothing has claimed it, and T25's record keeps this turn's earlier delivery off it. So
      // the round exists to let the model STOP or ADJUST what it is doing in light of what the
      // person just said, not to write them a second bubble.
      //
      // The `[no-reply]` escape is GONE from this text, deliberately, and the reason is the
      // tombstone above: it was invoked when it was not true, so asking for it invited a
      // declaration the model does not reliably make. What replaces it is not another
      // declaration — it is that nothing this round writes reaches the person as a reply
      // (`closeout-floors.ts` holds it), so the model cannot cost the person a duplicate by
      // getting this wrong.
      const isAre = owed.length === 1 ? 'it is' : 'they are';
      const itsTheir = owed.length === 1 ? 'its' : 'their';
      // ── THE SELF-LIMITING CLAUSE, AND IT IS NOT DECORATION ──
      // This row is PERSISTED and model-visible (that is how every steer reaches the model),
      // which means it is still in the tail on the arrival's OWN turn — the turn whose whole
      // job is to answer it. Driven at 02:32 on 2026-08-11 with the clause absent: turn 4697
      // picked the podcast ask up as its trigger, read "Do NOT answer it here", and spent its
      // whole budget on history searches without ever answering. A steer that outlives its turn
      // has to say when it stops applying, so it does.
      const laterTurnRelease =
        ` (If you are reading this on a LATER turn, that turn IS ${itsTheir} turn — answer ${itThem} normally.)`;
      const afterReplyPrompt = (
        `[System] While you were working, the user also sent: ${quoted}. ` +
        `Do NOT answer ${itThem} in this turn — ${isAre} queued and will be served on ${itsTheir} own turn next, ` +
        `and a second answer from you now would reach the user as a duplicate.${laterTurnRelease} ` +
        `Do not re-run the tools you used for the main task; that work is done and delivered. ` +
        `Do NOT repeat, summarize, or re-deliver ANY part of your earlier reply; the user already has it. ` +
        `If what they sent CANCELS or CHANGES work you are still doing, stop that work now and record it; otherwise finish this turn without adding anything.`
      );
      // ── T32 LEG B1 — THE IN-FLIGHT FORM, and it is a DIFFERENT INSTRUCTION, not a reworded
      // one. Nothing has reached the person yet, so there is no duplicate to prevent and no
      // earlier reply to point at. What there is, is work in progress that the person may have
      // just called off — the incident's own shape — and the ONE reply this turn is going to
      // write, which is still ahead.
      //
      // Aligned with T31's ruling (T32's GROUND says so in as many words): it asks the model to
      // finish-or-abort ITS OWN work, never to answer the arrival. The arrival's own turn
      // serves it, and asking for it here would manufacture exactly the duplicate T31 measured.
      // The withdrawal door is named because it exists and the model has to be told which one
      // it is: `work_close_request(action="commitment", disposition="dropped")` on the ask's
      // own bracketed id (T32 leg B2), so the ledger carries the user's words instead of the
      // engine guessing at them.
      // The id is SUPPLIED, not left to be found: the ask this turn is serving is `claimed`, and
      // the OPEN WORK block lists what is owed and NOT being worked, so it is correctly absent
      // from the one surface the model would look at. The engine knows it — `turnCtx.root` is
      // that ask — so it says it, and the door accepts a claimed ask for `dropped` (leg B2).
      const servingAskId = turnCtx.root?.kind === 'ask' && turnCtx.root.id ? `ask:${turnCtx.root.id}` : null;
      const inFlightPrompt = (
        `[System] While you are working, the user also sent: ${quoted}. ` +
        `Nothing has reached them yet this turn. Do NOT answer ${itThem} in this turn — ${isAre} queued and will be served on ${itsTheir} own turn next.${laterTurnRelease} ` +
        `What this changes is the work you are doing RIGHT NOW: if it cancels or replaces that work, STOP — do not finish it and do not deliver its answer, ` +
        `and record the cancellation with work_close_request(action="commitment", disposition="dropped"` +
        `${servingAskId ? `, id="${servingAskId}"` : ', id=<the id in [brackets] from your OPEN WORK block>'}` +
        `, note="<the user's own words>"). ` +
        `If it only adds to the work, carry on and cover it when its turn comes. ` +
        `Whatever you say in your one reply this turn, do not deliver the cancelled task's answer as though they had not spoken.`
      );
      const rePrompt = hasReply ? afterReplyPrompt : inFlightPrompt;
      // ── UX-REPAIR ROUND 6 T25 — THE KNOWLEDGE STOPS BEING THROWN AWAY ──
      // Everything above knows exactly which asks are still owed: `owed` holds their rows.
      // Until now the only thing that survived this block was the QUOTED PROSE inside the
      // re-prompt, which no predicate can read as evidence — so three seconds later, at the
      // same turn's finalize, settlement closed one of these very asks on the OTHER ask's
      // delivery (agent 57b52025, 2026-08-10 23:01:18, ask seq 60569 on delivery 6a20d864).
      // The subjects are now recorded BY ID on their own spine rows, which is what the
      // settlement authority's eighth narrowing reads. Written through `work/`, the spine's
      // single writer; best-effort, because a bookkeeping failure must never cost the
      // re-prompt this step exists to send.
      //
      // T32 LEG B1 PINS IT TO `mayRecord`, AND THAT IS THE WHOLE CARE IN THE SPLIT ABOVE: the
      // water is taken here, so this may not run on a pass that predates the turn's own answer.
      if (mayRecord) {
        try {
          const { recordOwedInterruptSubjects } = await import('../../../../work/ask-settlement.js');
          recordOwedInterruptSubjects(agentId, owed.map((m) => m.id), turnNumber);
        } catch (err) {
          logger.warn('owed-interrupt subjects not recorded; settlement will fall back to its other narrowings', {
            agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
        state = advance(state, { owedInterruptSubjectsRecorded: true });
      }
      if (!maySteer) return proceed(state);
      // ── T53 (owner ruling 5) — ONE MODEL-FACING CHANNEL, AND IT IS THE QUEUE ──
      // The paragraph that stood at the deleted write said the events row was the
      // model-visible half and the queue entry reached "the model on the very next
      // iteration". Only the second clause is true. The row could not reach that iteration
      // (the tail query drops `role='user'` rows created after the turn boundary) and
      // reached a LATER turn as a ≤400-char gist — under a header telling the model these
      // are notices it is merely aware of. That framing is the exact opposite of this
      // re-prompt's instruction, which is that the arrival is NOT this turn's to answer and
      // that a cancellation must be recorded through a named door; and the door
      // (`work_close_request(action="commitment", disposition="dropped", id=…)`) sits at the
      // END of the text, where the cut lands. The old comment's "label form so the
      // events-lane bracket strip keeps the body" note goes with the write it was about;
      // the `[System]` label stays, because the queue delivers it verbatim and the model
      // reads it as the engine speaking.
      // `persistEngineSteer` files the same entry and writes the durable `role='system'`
      // row, so the re-prompt is still on the record for the settlement investigation this
      // step's own T25 note describes.
      state = persistEngineSteer(
        state,
        { agentId, content: rePrompt, turnNumber, floor: 'owed-interrupt', atLoop: state.loopCount },
        { broadcast },
      );
      state = advance(state, {
        // T31: the seam writes down WHAT the round is for, beside the queue's record of THAT
        // it was bought. Everything downstream that has to tell the arrival's answer from the
        // turn's own answer reads this and nothing else.
        owedInterruptGrant: {
          atLoop: state.loopCount,
          messageIds: owed.map((m) => m.id),
          afterReply: hasReply,
        },
      });
      logger.info('v2 owed-interrupt steer: a mid-turn user message was assembled and is not this turn\'s to answer; pointing the model at it before the teardown claim marks it served', {
        agentId, turnNumber, owedCount: owed.length, convKey: chosenConvKey,
        inFlight: !hasReply, ridingToolCalls,
      }, agentId);
      // The in-flight pass keeps its tool calls: the loop is already going to come back, and
      // the steer is in the queue for the next assembly.
      return ridingToolCalls ? proceed(state) : continueLoop(state);
    }
  }

  return proceed(state);
}
