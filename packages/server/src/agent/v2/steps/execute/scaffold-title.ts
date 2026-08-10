// ════════════════════════════════════════
// PHASE-6 T7 (CUT 7) — the ENGINE FLOOR's interim TITLE and the PM rename hand-off
// it dispatches, moved out of `loop.ts` module level with the floor that calls
// them. Both were used only inside the `execute` span.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../../../../gateway/ws.js';
import { insertEngineEventIfAbsent } from '../../../../memory/message-store.js';
import { getAgentRuntime } from '../../../runtime.js';
import { createLogger } from '../../../../logger.js';

const logger = createLogger('v2-loop');

// PHASE-6 T3: the ladder's own three numbers (breaker 6, soft drift 8, hard drift 24)
// went with the ladder to `steps/pre-call-gates/thrash-gate.ts`, unchanged and with
// their reasoning. The two above stay because their reader — `detectTaskThrashing`
// below — stays: the DETECTOR answers "is this agent thrashing", the LADDER decides
// what to do about it, and only the second one moved.

// F12.5: shared derivation of an auto-scaffold title from a raw user message.
// Both scaffold sites (turn-start classifier + mid-turn engine floor) used to
// slice the raw prompt, producing kanban titles like "Can you go through my
// inbox and put together a lis". Strip leading politeness/filler, truncate at a
// word boundary within ~50 chars, capitalize. May return '' (no meaningful
// content), callers apply their own fallback. The PM rename handoff still runs
// afterward to give a proper umbrella name; this only makes the interim name
// readable instead of a mangled slice.
export function deriveScaffoldTitle(raw: string): string {
  let s = (raw ?? '').split('\n')[0].trim();
  // Repeatedly strip leading politeness/filler so "Hey, can you ..." also cleans up.
  const FILLER_PREFIX = /^(can you|could you|would you|will you|please|hey|hi|ok so|okay so|ok|also)\b[,:\s]*/i;
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(FILLER_PREFIX, '').trimStart();
  }
  if (s.length > 50) {
    const cut = s.slice(0, 50);
    const lastSpace = cut.lastIndexOf(' ');
    s = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
  }
  s = s.replace(/[.!?]+$/, '').trim();
  if (s.length === 0) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
// PHASE-6 T4 (CUT 6): the F9 delegation matcher — DELEGATION_PATTERNS,
// detectExplicitDelegation and DELEGATION_HINT_BODY — MOVED to
// `steps/assemble/delegation-and-attachments.ts` with the one site that binds them.

// F12.5: fire-and-forget PM rename handoff, factored out so BOTH scaffold sites
// (turn-start classifier and mid-turn engine floor) hand the ugly interim names
// to the PM agent to rewrite on its own turn via its local model. The user-facing
// agent never waits; a failed PM call just leaves the interim names in place.
export async function dispatchPMRenameHandoff(params: {
  callingAgentId: string;
  taskId: string;
  taskTitle: string;
  originalPrompt: string;
  /** UX-REPAIR T1: the counters the floor actually fired on, so this handoff states the
   *  SAME fact the engine note states. The sentence below used to hardcode the prose
   *  "6+ work calls" beside a note that printed the per-turn counter, so a firing at
   *  per-turn 2 produced two strings that contradicted each other on the same row.
   *  Optional so the shape survives a caller that has not measured them. */
  untrackedInConversation?: number;
  untrackedThisTurn?: number;
  floor?: number;
}): Promise<void> {
  try {
    const { getPMAgentId, getPMAgentName, getPrimaryAgentName } = await import('../../../../config/platform.js');
    const pmId = getPMAgentId();
    const pmName = getPMAgentName();
    const primaryName = getPrimaryAgentName();
    if (!pmId || !pmName) return;
    // T8c item 3: the engine floor opens ONE task, so there is one name to fix, not a
    // project name and a first-step name that had to be made distinct from each other.
    const why = typeof params.untrackedInConversation === 'number'
      ? `the agent reached ${params.untrackedInConversation} untracked work calls in this conversation` +
        (typeof params.untrackedThisTurn === 'number' ? ` (${params.untrackedThisTurn} this turn)` : '') +
        (typeof params.floor === 'number' ? `, at or over its floor of ${params.floor},` : '')
      : `the agent did untracked multi-step work`;
    const renameRequest = (
      `[ENGINE RENAME REQUEST] An engine-opened task needs a better name. ` +
      `The multi-step floor just opened this because ${why} with nothing ` +
      `tracked, and named it with a slice of the user's prompt, which looks bad on the kanban.\n\n` +
      `Task id: ${params.taskId}\n` +
      `Current title: ${params.taskTitle}\n\n` +
      `Original user prompt:\n${params.originalPrompt.slice(0, 1500)}\n\n` +
      `Please call work_update(action="edit", task_id="${params.taskId}", title="<short 3-6 word name>"). ` +
      `The name describes the WHOLE effort the user asked for. After the edit lands, send NO message ` +
      `back to anyone, this is a silent rename. Do not contact ${primaryName}.`
    );
    const renameMsgId = uuidv4();
    // T8c item 1 (the PM voice half): an ENGINE rename request is the engine writing to the
    // PM, not the owner talking. Same reasoning and same door as the situation report — see
    // `tracker/pm-agent.ts`'s note at the `insertEngineEventIfAbsent` call there.
    insertEngineEventIfAbsent({
      id: renameMsgId, agentId: pmId, content: renameRequest,
      sourceAgentId: null, originIntent: 'pm_rename', work: null,
    });
    broadcast({
      type: 'chat:message',
      agentId: pmId,
      message: {
        id: renameMsgId, agentId: pmId, role: 'user' as const,
        content: renameRequest,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
    // Fire-and-forget wake. handleMessage queues itself if PM is busy.
    void getAgentRuntime().handleMessage(pmId, renameRequest).catch(err => {
      logger.warn('v2 multistep: PM rename wake failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      }, params.callingAgentId);
    });
    logger.info('v2 multistep: dispatched PM rename request', {
      agentId: params.callingAgentId, pmId, taskId: params.taskId,
    }, params.callingAgentId);
  } catch (renameErr) {
    logger.warn('v2 multistep: PM rename dispatch failed (non-fatal)', {
      agentId: params.callingAgentId,
      error: renameErr instanceof Error ? renameErr.message : String(renameErr),
    }, params.callingAgentId);
  }
}
