// recall_recent_thread: agent-callable transcript recall. It returns a clean transcript of the agent's recent
// user/assistant exchanges from the messages table, respecting session_started_at so a reset does not leak
// pre-reset content. It spans every lane the agent owns (owner, agent-to-agent, engine events); what a PERSON
// sees is the `chat_messages` view (lane='owner'), which these queries never read or feed.
// include_tool_results ("wordy mode") adds tool results truncated per result with a history_get pointer,
// before_id paginates, since filters by ISO timestamp, and the footer always says how to get older slices.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { turnContext as liveTurnContext } from '../agent/turn-context.js';
import { clauseFor, requestForAnotherTurn } from './awaiting-own-turn.js';
import { charBoundary } from './tool-result-view.js';
import { renderInstant } from './message-stamp.js';
import { sessionBoundaryText } from './session-boundary.js';

const logger = createLogger('memory-recall');

interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
  attachments: string | null;
}

// SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" (no T, no Z); normalize ISO-8601 input to that shape so
// string comparison works.
export function normalizeTimestampForSqlite(input: string): string {
  // An explicit zone (Z or +hh:mm) names an instant: read it and keep the UTC clock time, since dropping
  // "+07:00" shifts the boundary. A bare clock time has no zone and falls through unchanged.
  const trimmed = input.trim();
  const zoned = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i.exec(trimmed);
  if (zoned) {
    const time = zoned[2].split(':').length === 2 ? `${zoned[2]}:00` : zoned[2];
    const rawZone = zoned[3].toUpperCase();
    const zone = rawZone !== 'Z' && !rawZone.includes(':') ? `${rawZone.slice(0, 3)}:${rawZone.slice(3)}` : rawZone;
    const d = new Date(`${zoned[1]}T${time}${zone}`);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 19).replace('T', ' ');
  }
  let s = trimmed;
  s = s.replace('T', ' ');
  if (s.endsWith('Z')) s = s.slice(0, -1);
  s = s.replace(/[+-]\d{2}:?\d{2}$/, '');
  s = s.replace(/\.\d+$/, '');
  return s.trim();
}

function extractToolUseId(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      for (const block of parsed) {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            return b.tool_use_id;
          }
        }
      }
    }
  } catch { /* not JSON */ }
  return null;
}

export interface RecallOptions {
  turnCount: number;
  includeToolCalls: boolean;
  includeToolResults?: boolean;
  truncateToolResultChars?: number;
  /** Per-message cap on user/assistant text. Default 1500, max 8000. */
  truncateMessageChars?: number;
  beforeId?: string;
  since?: string;
  /**
   * Conversation scoping. Default 'conversation': recall is limited to the CURRENT conversation (rows carrying
   * this turn's `conversation_id`, plus untagged current-turn and legacy rows). Pass 'all' for cross-conversation
   * recovery.
   */
  scope?: 'conversation' | 'all';
  /**
   * The `conversations.id` THIS turn is serving, from the live turn state. An id scopes recall to it; explicit
   * null means an engine/A2A turn (untagged rows only); `undefined` (outside a turn) falls back to the most
   * recently stamped conversation.
   */
  turnConversationId?: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  user: 'USER',
  assistant: 'ASSISTANT',
  tool: 'TOOL',
  system: 'SYSTEM',
};

function clip(text: string, maxChars: number): { text: string; truncated: number } {
  if (text.length <= maxChars) return { text, truncated: 0 };
  // Cut at a whole character, never between the two halves of an emoji: a lone surrogate is malformed and some
  // providers reject it. charBoundary backs off to a grapheme boundary; the dropped count is taken from there.
  const cut = charBoundary(text, maxChars, 'back');
  return { text: `${text.slice(0, cut)}…`, truncated: text.length - cut };
}

interface AssistantPart {
  text: string | null;
  toolCalls: Array<{ id: string | null; name: string; args: string }>;
}

function parseAssistantContent(content: string): AssistantPart {
  // Content is a plain string or a JSON array of blocks; reduce to text plus a tidy list of tool calls.
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const texts: string[] = [];
      const toolCalls: Array<{ id: string | null; name: string; args: string }> = [];
      for (const block of parsed) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          let argsStr = '';
          try {
            const inputObj = b.input as Record<string, unknown> | undefined;
            if (inputObj) {
              const entries = Object.entries(inputObj)
                .map(([k, v]) => {
                  if (typeof v === 'string') return `${k}="${clip(v, 60).text}"`;
                  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return `${k}=${v}`;
                  return `${k}=…`;
                })
                .slice(0, 4);
              argsStr = entries.join(' ');
            }
          } catch { /* best effort */ }
          toolCalls.push({
            id: typeof b.id === 'string' ? b.id : null,
            name: b.name as string,
            args: argsStr,
          });
        }
      }
      return { text: texts.join('\n').trim() || null, toolCalls };
    }
  } catch {
    /* not JSON */
  }
  return { text: content.trim() || null, toolCalls: [] };
}

function parseToolContent(content: string): string {
  // Tool result content can be a plain string OR JSON. Reduce to plain text.
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const texts: string[] = [];
      for (const block of parsed) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if ((b.type === 'tool_result' || b.type === 'text') && typeof b.content === 'string') {
          texts.push(b.content);
        } else if (typeof b.text === 'string') {
          texts.push(b.text);
        } else if (typeof b.content === 'string') {
          texts.push(b.content);
        }
      }
      if (texts.length > 0) return texts.join('\n');
    } else if (typeof parsed === 'object' && parsed !== null) {
      const p = parsed as Record<string, unknown>;
      if (typeof p.content === 'string') return p.content;
      if (typeof p.text === 'string') return p.text;
    }
  } catch {
    /* not JSON */
  }
  return content;
}

/** The clauses bounding a history read: the session boundary, then the conversation scope. */
function historyScope(agentId: string, opts: Pick<RecallOptions, 'scope' | 'turnConversationId'>): { clauses: string[]; params: (string | number)[]; sessionBoundary: string | null } {
  const db = getDb();
  // Respect session boundary so a recent reset doesn't bleed pre-reset content into the recall.
  const sessionBoundary = sessionBoundaryText(agentId);

  const clauses: string[] = ['agent_id = ?'];
  const params: (string | number)[] = [agentId];
  if (sessionBoundary) {
    clauses.push('created_at >= (unixepoch(?) * 1000)');
    params.push(sessionBoundary);
  }
  // The current turn's trigger inbound carries its conversation_id (stamped at ingest, or re-stamped at pickup), so
  // the most recently stamped conversation in this session identifies where we are. Limit recall to it plus
  // untagged rows (current-turn, not-yet-stamped, legacy), dropping OTHER conversations' tagged output.
  if (opts.scope !== 'all') {
    // Prefer the LIVE turn's conversation over "most recently stamped" (on an engine/A2A turn that latches the last
    // human conversation). An id = that conversation; null = engine/A2A turn (untagged rows only); undefined = called
    // outside a turn, use the heuristic. The scope is conversations.id, never a conv_key string, so an events-lane
    // rider (which has no conversation) can never be picked up here.
    let scopeConversationId: string | null | undefined;
    if (opts.turnConversationId !== undefined) {
      scopeConversationId = opts.turnConversationId;
    } else {
      const cur = db
        .prepare(
          `SELECT conversation_id FROM messages
             WHERE agent_id = ? AND conversation_id IS NOT NULL${sessionBoundary ? ' AND created_at >= (unixepoch(?) * 1000)' : ''}
             ORDER BY seq DESC LIMIT 1`,
        )
        .get(...(sessionBoundary ? [agentId, sessionBoundary] : [agentId])) as { conversation_id: string } | undefined;
      scopeConversationId = cur?.conversation_id;
    }
    // An OWN row stays unless it is positively a person's reply in another conversation (subject_kind='conv'; an
    // unlabelled row is judged by its stamp); the live turn's rows are the turn fact. Never another human's inbound.
    const ownKept = "(role IN ('assistant','tool') AND (turn_number = ? OR IFNULL(subject_kind, "
      + "CASE WHEN conversation_id IS NULL THEN '' ELSE 'conv' END) <> 'conv'))";
    const peerUnfiled = '(source_agent_id IS NOT NULL AND conversation_id IS NULL)';
    const inFlight = liveTurnContext(agentId)?.turnNumber ?? -1;
    if (scopeConversationId) {
      clauses.push(`(conversation_id = ? OR ${ownKept} OR ${peerUnfiled})`);
      params.push(scopeConversationId, inFlight);
    } else if (opts.turnConversationId === null) {
      // Engine/A2A turn: no human conversation, so no person's reply and no person's inbound.
      clauses.push(`(${ownKept} OR ${peerUnfiled})`);
      params.push(inFlight);
    }
  }
  return { clauses, params, sessionBoundary };
}

export function recallRecentThread(agentId: string, opts: RecallOptions): string {
  const db = getDb();
  try {
    const includeToolResults = opts.includeToolResults === true;
    const truncateChars = Math.min(4000, Math.max(200, opts.truncateToolResultChars ?? 1500));
    // User/assistant message cap: default 1500 (parity with the tool result cap), max 8000.
    const messageChars = Math.min(8000, Math.max(200, opts.truncateMessageChars ?? 1500));

    // Resolve before_id to an insertion-key cursor; if invalid, fall back to newest first. The cursor is `seq` (the
    // insertion key, cannot tie), not second-granular created_at, so a page boundary never repeats or skips rows.
    let beforeSeq: number | null = null;
    if (opts.beforeId) {
      const cursorRow = db
        .prepare('SELECT seq FROM messages WHERE id = ? AND agent_id = ?')
        .get(opts.beforeId, agentId) as { seq: number } | undefined;
      if (cursorRow) {
        beforeSeq = cursorRow.seq;
      }
    }

    // Roles selected: include 'tool' when caller wants tool results.
    const rolesClause = includeToolResults
      ? "role IN ('user','assistant','system','tool')"
      : "role IN ('user','assistant','system')";

    // Pull more than we need, then trim to N user→assistant exchanges.
    const fetchLimit = Math.max(opts.turnCount * 8, 60);

    const { clauses, params, sessionBoundary } = historyScope(agentId, opts);
    if (opts.since) {
      clauses.push('created_at >= (unixepoch(?) * 1000)');
      params.push(normalizeTimestampForSqlite(opts.since));
    }
    if (beforeSeq != null) {
      clauses.push('seq < ?');
      params.push(beforeSeq);
    }
    // ONE query over ONE table: agent-to-agent rows are lane='a2a' in messages, so the scope clauses above reach
    // them, and recall deliberately spans every lane the agent owns (chat_messages is what a PERSON sees).
    const whereSql = `${clauses.join(' AND ')} AND ${rolesClause}`;
    const sql = `
      SELECT id, role, content, datetime(created_at/1000,'unixepoch') AS created_at, attachments
        FROM messages
       WHERE ${whereSql}
       ORDER BY seq DESC
      LIMIT ?`;
    const rows = db.prepare(sql).all(...params, fetchLimit) as MessageRow[];

    if (rows.length === 0) {
      if (beforeSeq != null) {
        return `No older messages before id=${opts.beforeId} in this session.`;
      }
      if (opts.since) {
        return `No messages found since ${opts.since} in this session.`;
      }
      return sessionBoundary
        ? 'No conversation in the current session yet, the session was just reset.'
        : 'No conversation history found.';
    }

    // Walk newest→oldest, count user messages until we hit turnCount.
    rows.reverse(); // chronological now
    let firstIncludedIdx = 0;
    {
      let userCount = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].role === 'user') {
          userCount += 1;
          if (userCount > opts.turnCount) {
            firstIncludedIdx = i + 1;
            break;
          }
        }
      }
    }
    const slice = rows.slice(firstIncludedIdx);

    // Build a quick lookup so we can show tool RESULTS next to the tool_use
    // that produced them (when includeToolResults=true).
    const toolResultsByUseId = new Map<string, MessageRow>();
    if (includeToolResults) {
      for (const r of slice) {
        if (r.role === 'tool') {
          const tid = extractToolUseId(r.content);
          if (tid) toolResultsByUseId.set(tid, r);
        }
      }
    }

    const lines: string[] = [];
    // Label the UNSCOPED view: live context is conversation-scoped but scope:'all' is the merged multi-conversation
    // view, and without the label the agent misreads the extra rows as its live context being corrupt. The
    // counterparty is not resolved at this layer, so the label says "the current conversation".
    if (opts.scope === 'all') {
      lines.push(
        `[UNSCOPED view: includes ALL conversations and background lanes; your live ` +
        `context is scoped to the current conversation. Rows here that you don't see ` +
        `live are NOT missing, they belong to other lanes.]`,
      );
    }
    const headerParts = [
      `last ${opts.turnCount} user/assistant exchanges`,
      sessionBoundary ? 'bounded by current session' : null,
      beforeSeq != null ? `before id=${opts.beforeId}` : null,
      opts.since ? `since ${opts.since}` : null,
      includeToolResults ? `wordy mode (tool results up to ${truncateChars} chars each)` : null,
    ].filter(Boolean);
    lines.push(`[Recent thread, ${headerParts.join(', ')}. Raw from messages table.]`);
    lines.push('');

    const elsewhere = requestForAnotherTurn(agentId);   // a peer's request awaiting ITS OWN turn says so
    let truncatedResultCount = 0;
    let oldestIncludedId: string | null = null;
    let messagesShown = 0;

    for (const msg of slice) {
      if (!oldestIncludedId) oldestIncludedId = msg.id;
      // Count a row as "shown" only if it emits at least one line, so a body-less row (a pure tool_use with
      // include_tool_calls=false, or a long system row) never inflates the "Showed N messages" footer.
      const linesBefore = lines.length;

      const role = ROLE_LABEL[msg.role] ?? msg.role.toUpperCase();
      const t = renderInstant(msg.created_at) ?? msg.created_at;

      if (msg.role === 'system') {
        const trimmed = msg.content.trim();
        if (trimmed.length <= 200) lines.push(`[${role} ${t}] ${trimmed}`);
      } else if (msg.role === 'user') {
        const userClip = clip(msg.content.trim(), messageChars);
        lines.push(`[${role} ${t}] ${clauseFor(elsewhere, msg.id)}${userClip.text || '(no text)'}`);
        if (userClip.truncated > 0) {
          lines.push(
            `  [truncated, ${userClip.truncated} more chars, call history_get(id="${msg.id}") for full body]`,
          );
        }
      } else if (msg.role === 'tool') {
        // Only reached when includeToolResults=true (otherwise the SQL filtered tool rows out). Results emitted next to
        // their tool_use are consumed from toolResultsByUseId; this branch is the fallback for orphaned tool rows.
        const tuid = extractToolUseId(msg.content);
        if (!tuid || toolResultsByUseId.has(tuid)) { // not already emitted next to a tool_use
          const resultText = parseToolContent(msg.content);
          const clipped = clip(resultText, truncateChars);
          lines.push(`[${role} ${t}] (result) ${clipped.text || '(empty)'}`);
          if (clipped.truncated > 0) {
            truncatedResultCount += 1;
            lines.push(
              `  [truncated, ${clipped.truncated} more chars, call history_get(id="${msg.id}") for full body]`,
            );
          }
        }
      } else {
        // assistant
        const parts = parseAssistantContent(msg.content);
        if (parts.text) {
          const asstClip = clip(parts.text, messageChars);
          lines.push(`[${role} ${t}] ${asstClip.text}`);
          if (asstClip.truncated > 0) {
            lines.push(
              `  [truncated, ${asstClip.truncated} more chars, call history_get(id="${msg.id}") for full body]`,
            );
          }
        }
        if (opts.includeToolCalls && parts.toolCalls.length > 0) {
          for (const tc of parts.toolCalls) {
            lines.push(`[${role} ${t}] (called: ${tc.name}${tc.args ? ' ' + tc.args : ''})`);
            if (includeToolResults && tc.id) {
              const resultRow = toolResultsByUseId.get(tc.id);
              if (resultRow) {
                const resultText = parseToolContent(resultRow.content);
                const clipped = clip(resultText, truncateChars);
                const resT = renderInstant(resultRow.created_at) ?? resultRow.created_at;
                lines.push(`[TOOL ${resT}] (result: ${tc.name}) ${clipped.text || '(empty)'}`);
                if (clipped.truncated > 0) {
                  truncatedResultCount += 1;
                  lines.push(
                    `  [truncated, ${clipped.truncated} more chars, call history_get(id="${resultRow.id}") for full body]`,
                  );
                }
                // Mark consumed so we don't double-emit below.
                toolResultsByUseId.delete(tc.id);
              }
            }
          }
        }
      }

      if (lines.length > linesBefore) messagesShown += 1;
    }

    // Footer: tells the agent how to get older slices, where the cursor is, and how many results were clipped.
    lines.push('');
    const footerParts: string[] = [];
    footerParts.push(`Showed ${messagesShown} messages from ${slice.length} fetched rows`);
    // When fetched > emitted, the gap is tool-activity-only rows that rendered nothing; say so, so a body-less footer
    // is never misread as corruption.
    if (messagesShown < slice.length) {
      footerParts.push(
        `${slice.length - messagesShown} rows in this window are tool-activity only; pass include_tool_calls=true to see them`,
      );
    }
    if (oldestIncludedId) {
      footerParts.push(
        `oldest in this slice: id="${oldestIncludedId}", call recall_recent_thread(before_id="${oldestIncludedId}") for older turns`,
      );
    }
    if (truncatedResultCount > 0) {
      footerParts.push(
        `${truncatedResultCount} tool result(s) truncated, use the history_get(id="…") hints inline above to fetch full bodies`,
      );
    }
    if (!includeToolResults) {
      footerParts.push(
        'tool RESULTS were omitted, call recall_recent_thread(include_tool_results: true) if you need them',
      );
    }
    lines.push(`[${footerParts.join('. ')}.]`);

    return lines.join('\n');
  } catch (err) {
    logger.warn('recall_recent_thread failed', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return `Error recalling recent thread: ${err instanceof Error ? err.message : String(err)}`;
  }
}
