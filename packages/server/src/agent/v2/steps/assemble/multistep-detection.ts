// ════════════════════════════════════════
// PHASE-6 T4 (CUT 6) — the `assemble` step's MULTI-STEP DETECTION, moved
// byte-faithfully out of `loop.ts`. Engine-side detection of prompts that need a
// tracker project, plus the auto-scaffold it opens when it is confident and the
// start-ack steer that scaffold arms.
//
// It is the only one of this span's four sub-modules that RETURNS state: it is the
// span's second start-ack steer door (PHASE-4 T3's "27th steer site"), so it
// enqueues onto the steer queue and the advanced state has to come back.
//
// `staleTaskWindowMinutes` arrives as an INPUT rather than as an import: the
// constant is declared at module level in `loop.ts`, a guard pins it there by path
// on purpose, and the `execute` span reads it too. See the package header.
// ════════════════════════════════════════

import { getDb } from '../../../../db/connection.js';
import { isDreamerAgent, isHealerAgent, isPMAgent } from '../../../../config/platform.js';
import { taskScope } from '../../../../work/tracker-view.js';
import { advance, type AgentTurnState } from '../../state.js';
import { enqueueSteer } from '../../steer-queue.js';
import type { TurnContext } from '../../../turn-context.js';
import { engineAckReachesTheirChannel, type TurnCounterparty } from '../../counterparty.js';
import { createLogger } from '../../../../logger.js';
import { START_ACK_STEER_TEXT } from './steer-checkpoint.js';

const logger = createLogger('v2-loop');

export interface MultistepInput {
  readonly agentId: string;
  readonly turnCtx: TurnContext;
  readonly db: import('better-sqlite3').Database;
  readonly counterparty: TurnCounterparty;
  readonly counterpartyIsAgentSender: boolean;
  readonly lastUserMessageContent: string | null;
  readonly engineStartAckDeliveredThisTurn: boolean;
  readonly staleTaskWindowMinutes: number;
}

export async function detectMultistepAndScaffold(stateIn: AgentTurnState, input: MultistepInput): Promise<AgentTurnState> {
  const {
    agentId, turnCtx, counterparty, counterpartyIsAgentSender, lastUserMessageContent,
    engineStartAckDeliveredThisTurn,
  } = input;
  const STALE_TASK_WINDOW_MINUTES = input.staleTaskWindowMinutes;
  let state = stateIn;

  // ── THE PRE-CALL START-ACK DOOR, AND THE TWO OPENERS THAT SHARE IT ──
  // One arming path, asked twice. Both openers write the same three flags and enqueue the
  // same steer at the same loop, so whichever opens first makes the other a no-op through
  // `!turnCtx.startAckSteerArmedThisTurn` — exactly the "armed synchronously so a second
  // site can never double-steer" property the single opener had, now that there are two.
  // RC-4.2 lives in the gate: never start-ack an agent-flagged counterparty (ack ping-pong).
  const startAckDoorOpen = (): boolean =>
    counterparty.kind === 'user' && !counterpartyIsAgentSender
    && !engineStartAckDeliveredThisTurn && !turnCtx.startAckSteerArmedThisTurn;
  const armStartAckSteer = (s: AgentTurnState): AgentTurnState => {
    // Owner ruling 2026-07-22 (engine detects, agent speaks): the steer rides THIS first
    // model call (the messages array is mid-assembly here), so the model's very first
    // response opens with its own start line.
    turnCtx.startAckSteerArmedThisTurn = true;
    turnCtx.startAckSteersInjected = 1;
    turnCtx.startAckSteerInjectedAtLoop = s.loopCount;
    // PHASE-4 T3: the 27th steer site — §T0-PINS F derived by single-slot WRITER and this
    // one pushed straight into the array, the same floor through a second door. The drain
    // is still in THIS assemble phase.
    return advance(s, { steerQueue: enqueueSteer(s.steerQueue, { floor: 'start-ack', content: START_ACK_STEER_TEXT, atLoop: s.loopCount }) });
  };

  // ── Multi-step detection (v2.3.3) ──
  // Engine-side detection of prompts that need a tracker project.
  // When confident (heuristic high, or local-LLM classifier confirms),
  // create the project + initial task directly so the agent can't
  // forget to do it. Same lesson as the technique matcher above:
  // system-prompt instructions don't reliably get followed.
  //
  // Same fire conditions as technique matcher: loopCount === 1 with
  // a real user message (not auto-continuation / A2A / PM poke).
  //
  // v2.7.27: skip for the PM agent. The PM's situation reports land as
  // role='user' messages on its conversation; the classifier was treating
  // them as multistep user intent and auto-creating tracker projects
  // titled "Tracker review -- N active tasks:". Polluted the PM's view
  // every poke tick. PM never wants engine-auto-created projects.
  // D-B v2: also skip the Healer. It has no tracker tools and never touches
  // the tracker (its SOUL forbids it), so an engine-opened task it cannot
  // tend would go stale and trip the PM poke ladder against it, which is
  // exactly the state a held destructive consent must not leave behind.
  // P2b: also skip the Dreamer. Its cycle message (wakeupDreamer) is an
  // engine-synthetic role='user' row, not a user ask; its work is engine-
  // orchestrated memory maintenance. Auto-scaffolding it manufactured a
  // tracker project + task on the Dreamer every batch, which then same-turn-
  // closed and fired a notifyPrimaryAgent completion pair onto the primary's
  // chat (production transcript 2026-07-17). The tracker is the wrong
  // instrument for engine-lane maintenance, so the trigger simply skips it.
  if (state.loopCount === 1 && lastUserMessageContent && !isPMAgent(agentId) && !isHealerAgent(agentId) && !isDreamerAgent(agentId)) {
    // ── OPENER 2 — THE TEXTER (UX-REPAIR T41 option A, owner ruling 2026-08-12) ──
    //
    // The 30-second wall-clock door governs when the ENGINE NOTICES; it does not and
    // structurally cannot govern when the PERSON HEARS. After the threshold the request is
    // inert by design: it can only be armed at the next loop boundary — i.e. after waiting
    // out the model call already in flight — and can only be SPOKEN by the call after that.
    // Measured on the incident's own shape (W19, turn 4805, floor model): notice at +30 s,
    // armed at +84 s, the person's first word at +145 s. 115 seconds of engine chain on a
    // 30-second promise, and on the owner's real turn the ack lost the race to the answer
    // entirely — three minutes of dead air, then only the answer.
    //
    // The gates the slow door leans on are DASHBOARD-SHAPED in their own words: the
    // work-gate's justification is "a slow chat reply just streams (the working dots cover
    // the wait)" (`preflight/start-ack.ts`) and the threshold is "roughly where a texting
    // human starts wondering if they were heard" (`loop.ts`, `64a3bcd`). A person on
    // iMessage has no dots and no stream: the only thing that reaches them is a routing pass.
    //
    // So the door that already meets the promise opens for them too. NO new constant and no
    // new mechanism — the door, the steer and the delivery all exist; what changes is that
    // `decision.multistep` is no longer its only opener. The threshold is UNTOUCHED (#14):
    // the wall-clock timer still arms exactly as before for everyone this opener does not
    // cover, and on a covered turn it finds the steer already armed and stands down.
    if (engineAckReachesTheirChannel(counterparty) && startAckDoorOpen()) {
      state = armStartAckSteer(state);
      logger.info('v2 start-ack steer armed pre-call: the ask arrived on a routed channel, where nothing reaches the person but a routing pass', {
        agentId, channel: counterparty.kind === 'user' ? counterparty.channel : null,
      }, agentId);
    }
    try {
      const { detectMultistep, getMultistepConfig } = await import('../../classifiers/multistep.js');
      const cfg = getMultistepConfig();
      if (cfg.enabled) {
        // Skip if there's a RECENTLY-TENDED active tracker task assigned
        // to this agent, assume it's still being worked. This avoids
        // creating a sibling project on a quick follow-up message.
        //
        // v3.1.11 (FN-9): narrowed from "any open task" to "an open task
        // touched within STALE_TASK_WINDOW_MINUTES". The guard exists to
        // dodge sibling projects on quick follow-ups, and a quick follow-up
        // lands minutes after the agent last touched the task it is
        // continuing, so the window keeps that protection intact. But a
        // STALE open task (abandoned long ago) must NOT suppress, or new
        // untracked multi-step work rides in under the old task forever
        // (one of the two disarm holes this fix closes).
        const db = getDb();
        const existingTask = db.prepare(`
          SELECT w.id AS id FROM work w
          WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state IN ('on_deck', 'claimed', 'paused')
            AND w.updated_at >= ?
          LIMIT 1
        `).get(agentId, Date.now() - STALE_TASK_WINDOW_MINUTES * 60_000) as { id: string } | undefined;

        // F12 (harness finding, wave 2): agent CREATION stores the new agent's
        // system prompt as both a role='system' row AND a role='user' bootstrap
        // message (gateway/routes/agents.ts), so this classifier treated every
        // creation prompt as a user ask and auto-created a junk project, which
        // the PM then burned turns renaming, and which suppressed legitimate
        // auto-scaffolding later (existingTask). A bootstrap prompt is exactly
        // identifiable: the "user" text is byte-identical to a system row.
        const bootstrapTwin = db.prepare(
          `SELECT 1 FROM messages WHERE agent_id = ? AND role = 'system' AND content = ? LIMIT 1`,
        ).get(agentId, lastUserMessageContent);
        if (!existingTask && !bootstrapTwin) {
          const decision = await detectMultistep(lastUserMessageContent, agentId, cfg);
          turnCtx.inboundClassifiedAsWork =
            decision.multistep || decision.source === 'user_creating_explicitly';
          logger.info('v2 multistep classifier ran', {
            agentId,
            source: decision.source,
            multistep: decision.multistep,
            name: decision.name,
            signals: decision.heuristic.signals,
          }, agentId);

          // ══════════════════════════════════════════════════════════════════════
          // THE EMPTY-PROJECT MACHINE IS GONE (PHASE-2 T8c item 3)
          // ══════════════════════════════════════════════════════════════════════
          //
          // This block used to call `createProject` the moment the classifier judged an
          // inbound "multi-step": a project, a first task, an assignment notice, a
          // start-ack and a PM rename handoff, all before the model had done anything at
          // all. Research 03 measured what that produced on a real body — 1,135 of 1,183
          // projects EMPTY, auto-created and instantly closed — and PHASE-2's exit gates
          // name the classifier for deletion.
          //
          // WHAT IS KEPT, and it is the whole point of keeping the classifier at all:
          //   * `turnCtx.inboundClassifiedAsWork` — the SIGNAL. It gates the bare-[no-reply]
          //     refusal below, and the plan says keep it by name.
          //   * the START ACK. The requirement is "the person who asked hears that this
          //     is being worked on, once, before the model does anything", and it never
          //     depended on a project row existing — it only lived here because this was
          //     where the judgement was made. It now rides the judgement directly.
          // WHAT IS GONE: the project, its task, the assignment notice for a task the
          // model never asked for, and the PM rename handoff whose entire job was to give
          // that auto-named project a better name.
          //
          // requirement preserved (the weakest-model guarantee): a model that does real
          // multi-step work still ends the turn with a work row — that is the >=6 ENGINE
          // FLOOR below, which opens ONE `work(kind='task')` when nothing else did. The
          // difference is that the floor fires on OBSERVED WORK rather than on a
          // prediction made from the first sentence, which is exactly why the classifier's
          // rows were empty.
          if (decision.multistep) {
            // OPENER 1 — START ACK (NEXT-WAVE item 1), unchanged in requirement and in
            // wording. On a turn opener 2 already armed this is a no-op by the same latch
            // that always made a second site one.
            if (startAckDoorOpen()) {
              state = armStartAckSteer(state);
            }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isMissingTable = /no such table/i.test(msg);
      if (isMissingTable) {
        logger.debug('v2 multistep: tracker tables not present (expected in tests/fresh DBs)', { agentId }, agentId);
      } else {
        logger.warn('v2 multistep classifier failed (non-fatal)', { agentId, error: msg }, agentId);
      }
    }
  }

  return state;
}
