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
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';

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
    const db = getDb();
    // conv_key sentinel 'engine-notice' (C6): a notice is role='user' origin_kind='engine',
    // which is exactly the shape getPendingEngineEvent selects (conv_key-NULL engine rows) —
    // without a non-NULL conv_key every awareness notice would be mistaken for a pending
    // engine EVENT and drive a spurious engine turn. The sentinel keeps it out of the
    // pending-event and human-waiting pools while it still surfaces in the EVENTS/awareness
    // lane (which filters on origin_kind, not conv_key) and is excluded from compaction.
    db.prepare(
      `INSERT OR IGNORE INTO messages (id, agent_id, role, content, conv_key, origin_kind, origin_intent, created_at)
       VALUES (?, ?, 'user', ?, 'engine-notice', 'engine', ?, datetime('now'))`,
    ).run(id, toAgentId, content, opts.intent ?? 'agent_notice');
    broadcast({
      type: 'chat:message',
      agentId: toAgentId,
      message: {
        id, agentId: toAgentId, role: 'user' as const, content,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
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
