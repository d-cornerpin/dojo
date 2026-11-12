// The assemble step's two tail appends: the explicit-delegation routing hint (advice voice, never
// an order) and the user's own attachments. Both append past the volatile boundary; neither writes `state`.

import { injectRegistryMessage } from '../../../../prompt/registry/assembler.js';
import type { AssemblyContext } from '../../../../prompt/registry/types.js';
import type { AssembledContext } from '../../../../memory/assembler.js';
import { insertEngineEventIfAbsent, insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { isHealerAgent, isPMAgent } from '../../../../config/platform.js';
import { broadcast } from '../../../../gateway/ws.js';
import { v4 as uuidv4 } from 'uuid';
import type { AgentTurnState } from '../../state.js';
import type { TurnCounterparty } from '../../counterparty.js';
import { createLogger } from '../../../../logger.js';
import { attachmentsWithinRoom } from '../../../../memory/kept-row-view.js';

const logger = createLogger('v2-loop');

// Conservative by design: a routing verb plus a "your agents/team" object, "delegate" as a verb, or "spawn
// ... agent"; unlisted phrasings miss, and a recorded negative firing is the STOP condition (both lists in
// `__tests__/delegation-hint.test.ts`). Never swap in the prose-keyed detector: standing ban.
const DELEGATION_PATTERNS: readonly RegExp[] = [
  // Possessive "your" is required, so "do you have any agents?" and "have you seen my agent" never match.
  /\b(have|get|ask|tell|assign|task)\s+(one of\s+)?your\s+(agents?|sub-?agents?|team|helpers?|assistants?)\b/i,
  // \s after "delegate" excludes "delegated"; the pronoun/the object excludes the noun "the delegate".
  /\bdelegate\s+(this|it|that|these|those|the\b)/i,
  // Bare "the team" does not match, so "hand this to the team lead" stays out.
  /\bhand\s+(this|it|that|these|those)\s+(off\s+)?to\s+(one of\s+)?(your|an?)\s+(agents?|sub-?agents?|team|helpers?)\b/i,
  // "spawn/spin up" requires an agent object, so "salmon spawn in the river" never matches.
  /\b(spawn|spin ?up|fire ?up|kick ?off)\s+(a |an |another |one )?(new\s+)?(sub-?)?agent\b/i,
  // Divide-the-work verbs keep the possessive shape; the verb-to-joiner gap is bounded and sentence-local.
  /\b(split|divide|distribute|farm\s*out|spread|share)\b[^.!?\n]{0,40}?\b(between|among|across|with)\s+(one of\s+)?your\s+(agents?|sub-?agents?|team|helpers?|assistants?)\b/i,
  // The trailing preposition keeps it an INSTRUCTION: "can you use your judgement" has no agent object.
  /\buse\s+your\s+(agents?|sub-?agents?|team|helpers?|assistants?)\s+(for|to|on)\b/i,
];

/** True when the user text EXPLICITLY routes the work to the agent's agents. */
export function detectExplicitDelegation(text: string): boolean {
  if (!text) return false;
  return DELEGATION_PATTERNS.some((re) => re.test(text));
}

// The hint body, shared by the live injection and the persisted EVENTS row: advice voice, never an order.
const DELEGATION_HINT_BODY =
  'the person you are talking to explicitly asked for this to be delegated to one of your agents. ' +
  'Either delegate it (spawn_agent for a fresh helper, or send_to_agent to task ' +
  'an existing one) and synthesize the result back to the person you are talking to, or, if doing it ' +
  'yourself is clearly better here, briefly tell the person you are talking to you are handling it ' +
  'directly and why. Do not silently override their routing instruction.';

export interface DelegationAndAttachmentsInput {
  readonly agentId: string;
  readonly turnNumber: number;
  readonly counterparty: TurnCounterparty;
  readonly lastUserMessageContent: string | null;
  readonly mctx: AssemblyContext;
  readonly messages: AssembledContext['messages'];
  /** The assembly's content room (`allocation.budgetTokens`); an attachment over it alone gets its note. */
  readonly roomTokens?: number;
}

export async function injectDelegationHintAndAttachments(state: AgentTurnState, input: DelegationAndAttachmentsInput): Promise<void> {
  const { agentId, turnNumber, counterparty, lastUserMessageContent, mctx, messages } = input;

  // Engine-shaped messages skip: an engine notice is not the user delegating.
  if (
    state.loopCount === 1 &&
    lastUserMessageContent &&
    counterparty.kind === 'user' &&
    !isPMAgent(agentId) &&
    !isHealerAgent(agentId) &&
    detectExplicitDelegation(lastUserMessageContent)
  ) {
    try {
      const { looksLikeEngineMessage } = await import('../../classifiers/multistep.js');
      if (!looksLikeEngineMessage(lastUserMessageContent)) {
        mctx.delegationHint = `[Engine hint: ${DELEGATION_HINT_BODY}]`;
        injectRegistryMessage('msg.delegation-hint', messages, mctx);

        // Persist for later turns as an EVENTS-lane row; a rider intent, so never picked as a pending engine event.
        // Label form "[Engine hint] body" (space not colon): a single wrapping bracket is stripped whole.
        insertEngineEventIfAbsent({
          work: null,
          id: uuidv4(),
          agentId,
          content: `[Engine hint] ${DELEGATION_HINT_BODY}`,
          sourceAgentId: null,
          originIntent: 'delegation_hint',
          turnNumber,
        });

        logger.info('v2 F9: explicit-delegation hint fired (user routed the work to the agent\'s agents; injected the delegate-or-say-why steer)', {
          agentId, turnNumber, loopCount: state.loopCount,
        }, agentId);
      }
    } catch (err) {
      logger.warn('v2 F9 delegation-hint failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  // Each FRESH image resize gets a one-shot system note; later turns hit the on-disk cache and stay silent.
  const { injectAttachmentBlocks } = await import('../../../runtime.js');
  const freshResizes = injectAttachmentBlocks(messages, agentId) ?? [];   // `??`: older mocks return undefined
  attachmentsWithinRoom(messages, input.roomTokens);   // never forced in whole over the room
  if (freshResizes.length > 0) {
    try {
      const { formatBytes } = await import('../../../image-prep.js');
      const lines = freshResizes.map((r) => {
        if (r.note) return r.note;
        const orig = r.originalSize ?? 0;
        const fin = r.finalSize ?? 0;
        return `Image \`${r.filename}\` was downscaled from ${formatBytes(orig)} to ${formatBytes(fin)} to fit the model's 5 MB per-image limit.`;
      });
      const noteContent = `[Engine: input preparation]\n${lines.join('\n')}`;
      const noteId = uuidv4();
      insertMessageIfAbsent({ id: noteId, agentId, role: 'system', content: noteContent, turnNumber });
      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: noteId, agentId, role: 'system' as const,
          content: noteContent,
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      logger.warn('v2: failed to persist image-resize system note (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }
}
