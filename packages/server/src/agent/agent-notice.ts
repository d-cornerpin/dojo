// ════════════════════════════════════════════════════════════════════════
// agent-notice — the ONE sanctioned way for a helper/service agent or engine
// subsystem to make another agent (usually the primary) AWARE of something.
//
// The owner's model: an agent reaching the primary should be like a PERSON messaging
// it — a brief, first-person, self-attributed line ("Hey, this is the Healer
// agent. I found a problem with X and fixed it."), NEVER a firehose that dumps the
// agent's entire internal work log into the primary's conversation, context, or
// dashboard chat. The primary does not need to see everything another agent DOES,
// only what that agent chooses to SEND.
//
// A notice posted here is:
//   • BRIEF — one short first-person sentence. The FULL detail belongs elsewhere
//     (the agent bus via sendAgentMessage, the tracker/healer tables, etc.) for
//     the primary to pull DELIBERATELY if it decides to act.
//   • Structurally an AWARENESS event — stored role='user' with origin_kind='engine'
//     so deriveOrigin classifies it as an engine/awareness item. The assembler lifts
//     it into the EVENTS/awareness lane (the primary SEES it and may CHOOSE to surface
//     it to the user in its own voice or act on it), NOT the live user conversation.
//     role='user' (not 'system') matters: role='system' rows are skipped by the model-
//     context builder, so an actionable "reset this stuck agent?" alert posted as
//     role='system' is invisible to the primary and can never be acted on. This path
//     is model-visible AND out of the user's chat.
//   • Excluded from compaction: the "[SOURCE: AGENT NOTICE" prefix is in
//     memory/platform-noise.ts, so it never gets folded into a context summary and
//     re-narrated.
//   • Not a user-chat row: origin_kind='engine' tiers it agent-only in the dashboard.
// ════════════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import { insertEngineEventIfAbsent } from '../memory/message-store.js';

const logger = createLogger('agent-notice');

export interface AgentNoticeOpts {
  /** The agent to make aware (usually the primary). */
  toAgentId: string;
  /** The helper/service agent's display name ("Healer", "Dreamer", "PM"). */
  fromName: string;
  /**
   * The message body — ONE short first-person sentence, as a person would text.
   * Do NOT paste a full report/changelog/enumeration here; keep the detail on the bus.
   */
  brief: string;
  /** origin_intent tag for the awareness lane label (default 'agent_notice'). */
  intent?: string;
  /**
   * Prefix the body with "Hey, this is the <fromName> agent." (default true). Set false
   * for engine SUBSYSTEMS (Scheduler, Tracker) that are not agents — the "[SOURCE: … from
   * <fromName>]" attribution tag still identifies the sender, and `brief` carries the
   * whole self-contained message.
   */
  selfIntro?: boolean;
}

/**
 * Post a brief, self-attributed awareness notice from an agent to another agent.
 * Best-effort: a notice must never break the caller, so all errors are swallowed.
 * Returns the message id (or null if it could not be written).
 */
export function postAgentNotice(opts: AgentNoticeOpts): string | null {
  const { toAgentId, fromName, brief } = opts;
  if (!toAgentId || !fromName || !brief) return null;
  const trimmed = brief.replace(/\s+/g, ' ').trim();
  const intro = opts.selfIntro === false ? '' : `Hey, this is the ${fromName} agent. `;
  const content = `[SOURCE: AGENT NOTICE from ${fromName}] ${intro}${trimmed}`;
  const id = uuidv4();
  try {
    // D-A step 4: an engine notice is inter-agent traffic (origin_kind='engine'),
    // so it lands on the EVENTS lane, structurally outside the primary's owner chat
    // chat table where a forgetful downstream filter could leak it into human chat.
    // The merged tail loaders + assembler classify it into the EVENTS/awareness lane
    // byte-identically to the old `messages` row.
    // ⚠ PHASE-2 T10H — THIS SENTINEL NO LONGER DOES THE JOB THIS COMMENT DESCRIBED, AND FOR A
    // DAY NOTHING DID. The paragraph below used to read: "without a non-NULL conv_key every
    // awareness notice would be mistaken for a pending engine EVENT and drive a spurious
    // engine turn." That was true while `getPendingEngineEvent` selected on `conv_key IS NULL`.
    // T9 correctly moved that claim onto `served_by_turn` and the sentinel stopped excluding
    // anything — so every notice DID become a pending-event candidate, silently, until T10H
    // gave the predicate `ENGINE_RIDER_INTENTS`. The exclusion now reads this row's
    // `origin_intent`, which means the requirement no longer depends on a fake conversation key
    // and survives `conv_key`'s deletion.
    //
    // The `convKey: 'engine-notice'` write below is therefore RESIDUE for the pending-event
    // job — but it is NOT dead: `re-answer-guard.ts` and the dashboard's `isBackgroundTurnRow`
    // still read the sentinels to tell engine chatter from a human conversation. Both of those
    // readers need the column's IDENTITY half re-pointed (`conversation_id`), which is the
    // migration T10H did NOT reach. So the write stays, named as owed, rather than being
    // deleted out from under two live readers.
    // It still surfaces in the EVENTS/awareness lane (which filters on `lane`, not `conv_key`)
    // and is still excluded from compaction.
    insertEngineEventIfAbsent({
      work: null,
      id,
      agentId: toAgentId,
      content,
      sourceAgentId: null,             // a subsystem/service name, not a peer agent id
      originIntent: opts.intent ?? 'agent_notice',
      convKey: 'engine-notice',
    });
    // D-A step 5: an engine notice is inter-agent traffic (origin_kind='engine'),
    // so it broadcasts on the dedicated `interagent:message` lane, NOT chat:message.
    // Before D-A it rode chat:message and the dashboard hid it in regular mode /
    // surfaced it only in wordy-mode chat (as an EVENTS/awareness item); it now
    // lives in the Inter-Agent lane instead. Regular-mode chat is unaffected (it
    // never showed there). recipientName is left null; the lane is scoped to the
    // viewed agent and fills it from the name it already knows.
    broadcast({
      type: 'interagent:message',
      agentId: toAgentId,
      message: {
        id,
        agentId: toAgentId,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
        sourceAgentId: null,
        senderName: fromName,
        recipientName: null,
        threadId: null,
        intent: opts.intent ?? 'agent_notice',
        requiresResponse: false,
        originKind: 'engine',
      },
    });
    return id;
  } catch (err) {
    logger.warn('postAgentNotice failed (non-fatal)', {
      toAgentId, fromName, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
