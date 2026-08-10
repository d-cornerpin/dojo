// ════════════════════════════════════════
// PHASE-6 T4 (CUT 6) — the `assemble` step's LAST TWO TAIL APPENDS, moved
// byte-faithfully out of `loop.ts`: the F9 explicit-delegation routing hint and
// the user's own attachments.
//
// One file because they are adjacent in the span and both are pure appends onto
// the tail past the volatile boundary; neither writes `state`. The delegation hint
// is advice voice (tier-7) and never an order — the owner's middle stance — and
// the attachment injection is the same call v1 made at `runtime.ts:1929`.
// ════════════════════════════════════════

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

const logger = createLogger('v2-loop');

// F9 (harness finding): the user EXPLICITLY routed work to the agent's own
// agents and the floor model silently did it itself, never mentioning the
// choice. Owner stance (middle): the agent keeps judgment, but the routing
// instruction must be SURFACED (delegate, or say why not); a silent override
// must be impossible in practice. This conservative detector recognizes an
// EXPLICIT routing instruction so the engine can inject the advice-voice steer.
//
// Anchor on an imperative delegation VERB + a "your agent(s)/team" object, or
// the word "delegate" used as a verb, or an explicit "spawn/spin up ... agent".
// It must NOT fire on mere MENTIONS of agents ("do you have any agents?", "how
// many agents...", "your agents are great"), so a bare noun reference never
// matches. Canonical positive (the battery phrase):
//   "Have one of your agents research it and report back to me."
//
// UX-REPAIR T3 widened the IMPERATIVE grammar only (two patterns added below);
// the object requirement is unchanged, and every recorded negative still
// refuses — `__tests__/delegation-hint.test.ts` holds both directions, and a
// negative firing is the task's STOP condition. ACCEPTED RESIDUAL, recorded so
// nobody mistakes this for coverage: an allowlist misses unlisted phrasings by
// design ("assign this to your sub-agents" still refuses). The general
// un-addressed-instruction detector is NOT the answer to that — it is
// prose-keyed and under a standing ban (`turn-end-floors.mjs:32-36`).
const DELEGATION_PATTERNS: readonly RegExp[] = [
  // Imperative delegation verb targeting the agent's OWN agents/team. Requires
  // the possessive "your" (optionally "one of your ..."), so "do you have any
  // agents?" / "have you seen my agent" never match.
  /\b(have|get|ask|tell|assign|task)\s+(one of\s+)?your\s+(agents?|sub-?agents?|team|helpers?|assistants?)\b/i,
  // "delegate" as a verb with a work object ("delegate this/it/that", "delegate
  // the research"). \s after the word excludes "delegated"; a pronoun/the-object
  // excludes the noun "the delegate for ...".
  /\bdelegate\s+(this|it|that|these|those|the\b)/i,
  // "hand this/it (off) to (one of) your/an agent(s)/team". "the team" (not
  // "your"/"a"/"an") does not match, so "hand this to the team lead" is out.
  /\bhand\s+(this|it|that|these|those)\s+(off\s+)?to\s+(one of\s+)?(your|an?)\s+(agents?|sub-?agents?|team|helpers?)\b/i,
  // Explicit "spawn/spin up ... agent" (with an agent object, so "salmon spawn
  // in the river" and "the spawn point" never match).
  /\b(spawn|spin ?up|fire ?up|kick ?off)\s+(a |an |another |one )?(new\s+)?(sub-?)?agent\b/i,
  // UX-REPAIR T3: the IMPERATIVE ROUTING grammar. The 2026-08-10 UX review's S4
  // message — "Split the research between your helpers if that's faster" — has
  // the possessive OBJECT the first pattern wants and none of its verbs, so all
  // four patterns above returned false on the plainest routing instruction in
  // the battery. This adds the divide-the-work verb family and its joiner, and
  // it keeps the SAME conservative shape as pattern 0: the possessive "your"
  // plus the agent-object is still required, so "split the bill between the
  // four of us" and "share the doc with my team" never match. The gap between
  // the verb and the joiner is bounded and sentence-local (no `.!?` and no
  // newline inside it), so the verb of one sentence can never pair with the
  // joiner of the next.
  /\b(split|divide|distribute|farm\s*out|spread|share)\b[^.!?\n]{0,40}?\b(between|among|across|with)\s+(one of\s+)?your\s+(agents?|sub-?agents?|team|helpers?|assistants?)\b/i,
  // "use your agents/helpers/team for|to|on <work>" — the same instruction in
  // its other common form. The trailing preposition is what keeps it an
  // INSTRUCTION: "can you use your judgement" has no agent object, and "your
  // helpers are great" has no verb.
  /\buse\s+your\s+(agents?|sub-?agents?|team|helpers?|assistants?)\s+(for|to|on)\b/i,
];

/** True when the user text EXPLICITLY routes the work to the agent's agents. */
export function detectExplicitDelegation(text: string): boolean {
  if (!text) return false;
  return DELEGATION_PATTERNS.some((re) => re.test(text));
}

// F9 hint body (shared by the live model-visible injection and the persisted
// EVENTS-lane row). Advice voice per the precedence ladder (tier-7), never an
// order. No em-dashes; plain layman language.
const DELEGATION_HINT_BODY =
  'the user explicitly asked for this to be delegated to one of your agents. ' +
  'Either delegate it (spawn_agent for a fresh helper, or send_to_agent to task ' +
  'an existing one) and synthesize the result back to the user, or, if doing it ' +
  'yourself is clearly better here, briefly tell the user you are handling it ' +
  'directly and why. Do not silently override their routing instruction.';

export interface DelegationAndAttachmentsInput {
  readonly agentId: string;
  readonly turnNumber: number;
  readonly counterparty: TurnCounterparty;
  readonly lastUserMessageContent: string | null;
  readonly mctx: AssemblyContext;
  readonly messages: AssembledContext['messages'];
}

export async function injectDelegationHintAndAttachments(state: AgentTurnState, input: DelegationAndAttachmentsInput): Promise<void> {
  const { agentId, turnNumber, counterparty, lastUserMessageContent, mctx, messages } = input;


  // ── F9: explicit-delegation routing hint ───────────────────────────────
  // The user EXPLICITLY routed work to the agent's own agents ("have one of
  // your agents research it and report back to me") and the floor model was
  // observed silently doing the work itself, never mentioning the choice.
  // Owner stance (middle): keep the agent's judgment, but the routing
  // instruction must be SURFACED (delegate, or say why not); a silent
  // override must be impossible in practice. Same guard family as the
  // multistep classifier: first tool round with a real user message, this
  // turn is FOR a user (not A2A), not the PM, not the Healer. Skips
  // engine-shaped messages (an engine notice is not the user delegating).
  // Advice voice (tier-7), never an order; the agent still decides.
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
        // Model-visible THIS turn: inject the hint right after the user's ask
        // via the registry channel (same path as msg.tracker-notif). The
        // colon-bracket "[Engine hint: ...]" form is the live advice voice.
        mctx.delegationHint = `[Engine hint: ${DELEGATION_HINT_BODY}]`;
        injectRegistryMessage('msg.delegation-hint', messages, mctx);

        // Persist for later turns: a lane='events' row the EVENTS lane
        // surfaces next turn. conv_key sentinel 'engine-steer'
        // keeps it un-selectable as a pending engine event. Label form
        // ("[Engine hint] body", space not colon) so the events-lane
        // leading-bracket strip drops only the label and keeps the body; a
        // single wrapping "[Engine hint: ...]" bracket would be stripped whole.
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


  // Inject user-uploaded attachments (images, PDFs) as content blocks.
  // Without this, the agent never sees images/PDFs the user attached, 
  // it only sees the text content of those messages and hallucinates.
  // Same path v1 uses (runtime.ts:1929 in v1).
  //
  // v2.3.18: oversized images get downscaled to fit the 5MB model cap
  // here. Persist a one-shot system note for any FRESH resize so the
  // user knows what happened (later turns hit the on-disk cache and
  // stay silent).
  const { injectAttachmentBlocks } = await import('../../../runtime.js');
  // Defensive default, older mocks may return undefined.
  const freshResizes = injectAttachmentBlocks(messages, agentId) ?? [];
  if (freshResizes.length > 0) {
    try {
      // v2.3.19, rectifier supplies the agent-facing note directly.
      // Fall back to the legacy size-based formatter for back-compat
      // when only originalSize/finalSize are present.
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
