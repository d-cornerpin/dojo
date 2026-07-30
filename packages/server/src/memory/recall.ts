// ════════════════════════════════════════
// recall_recent_thread, agent-callable transcript recall
// ════════════════════════════════════════
//
// Returns a clean transcript of the agent's recent user/assistant
// exchanges, read directly from the messages table. Respects
// session_started_at so a recent reset doesn't leak pre-reset content
// into the recall.
//
// SCOPE (PHASE-1 T5): this is an AGENT surface, and it spans every lane the agent owns —
// the owner conversation, agent-to-agent coordination and engine events alike. That is
// deliberate and it is the defect this phase closes: coordination history used to live in a
// separate table with no FTS index, so an agent could hold thousands of rows it was
// structurally unable to recall. What a PERSON sees is the `chat_messages` view
// (`lane='owner'`), which these queries never read and never feed.
//
// v2.5.11, Expanded for memory-recovery use cases:
//   - include_tool_results=true ("wordy mode") includes tool RESULTS,
//     truncated per result with a history_get pointer for the full
//     body. Used when the agent needs to recover actual content
//     (file_read output, web_fetch body, etc.) after compaction or
//     a model switch.
//   - before_id paginates: "give me the N turns BEFORE message X."
//   - since filters by ISO timestamp.
//   - Footer always tells the agent how to get older slices or full
//     bodies, impossible to misread as "you have all the data."
//
// Use case: post-compaction reorientation, post-sanitizer recovery,
// or any time the agent has lost the thread.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('memory-recall');

interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
  attachments: string | null;
}

// SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" (no T, no Z). Agents
// will reasonably pass ISO-8601 ("2026-05-12T00:33:00Z" or with offset), 
// normalize to the SQLite shape so string comparison works correctly.
function normalizeTimestampForSqlite(input: string): string {
  let s = input.trim();
  // Replace the T separator with a space.
  s = s.replace('T', ' ');
  // Drop a trailing Z.
  if (s.endsWith('Z')) s = s.slice(0, -1);
  // Drop a trailing timezone offset like "+00:00" or "-07:00".
  s = s.replace(/[+-]\d{2}:?\d{2}$/, '');
  // Drop fractional seconds.
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
   * Conversation scoping (OPEN-15). Default 'conversation', recall is limited
   * to the CURRENT conversation (rows carrying this turn's `conversation_id`, plus
   * untagged current-turn / legacy rows). This stops an unrelated task's output
   * (e.g. an `apt autoremove` exec from a different conversation) bleeding into
   * the recall when the agent asks "what was just said." Pass 'all' for the
   * genuine cross-conversation recovery case ("show me everything recent").
   */
  scope?: 'conversation' | 'all';
  /**
   * E-C1: the `conversations.id` of the conversation THIS turn is serving, threaded from the
   * live turn state. An id scopes recall to that conversation; explicit null
   * means an engine/A2A turn (no human conversation) so recall stays on untagged
   * rows and never latches a prior human conversation; `undefined` (called outside
   * a turn) falls back to the legacy "most-recently-stamped conversation" heuristic.
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
  return { text: `${text.slice(0, maxChars)}…`, truncated: text.length - maxChars };
}

function formatTimestamp(iso: string): string {
  // Stored as "YYYY-MM-DD HH:MM:SS", keep it compact.
  return iso.slice(11, 16); // "HH:MM"
}

interface AssistantPart {
  text: string | null;
  toolCalls: Array<{ id: string | null; name: string; args: string }>;
}

function parseAssistantContent(content: string): AssistantPart {
  // Assistant content can be a plain string OR a JSON array of content
  // blocks (text + tool_use). Reduce to text + a tidy list of tool calls.
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

export function recallRecentThread(agentId: string, opts: RecallOptions): string {
  const db = getDb();
  try {
    const includeToolResults = opts.includeToolResults === true;
    const truncateChars = Math.min(4000, Math.max(200, opts.truncateToolResultChars ?? 1500));
    // User/assistant message cap. Default 1500 (parity with tool result cap)
    //, before this it was hardcoded to 600 with no escape hatch and no
    // truncation marker, so messages got silently cut and the agent had no
    // way to know or fetch the rest. Max 8000.
    const messageChars = Math.min(8000, Math.max(200, opts.truncateMessageChars ?? 1500));

    // Respect session boundary so a recent reset doesn't bleed pre-reset
    // content into the recall.
    const sessionRow = db
      .prepare('SELECT session_started_at FROM agents WHERE id = ?')
      .get(agentId) as { session_started_at: string | null } | undefined;
    const sessionBoundary = sessionRow?.session_started_at ?? null;

    // Resolve before_id → insertion-key cursor. If invalid, fall back to "newest first".
    // T5: the cursor is `seq`, not `created_at`. Pagination has to be strictly monotonic or
    // a page boundary that lands inside one second either repeats rows or skips them, and
    // `created_at` is second-granular TEXT. `seq` is the insertion key and cannot tie.
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

    const clauses: string[] = ['agent_id = ?'];
    const params: (string | number)[] = [agentId];
    if (sessionBoundary) {
      clauses.push('created_at >= (unixepoch(?) * 1000)');
      params.push(sessionBoundary);
    }
    // Conversation scoping (OPEN-15). The current turn's trigger inbound carries its
    // `conversation_id` — resolved by the producer at ingest and re-stamped at pickup if the
    // producer could not (loop.ts) — so the most recently stamped conversation in this
    // session identifies the conversation we're in.
    // Limit recall to that conversation plus untagged rows (current-turn,
    // not-yet-stamped work and legacy rows), which keeps the live thread while
    // dropping OTHER conversations' tagged output, the cross-task bleed that
    // surfaced unrelated `apt`/package output during a flight-info question.
    if (opts.scope !== 'all') {
      // E-C1: prefer the LIVE turn's conversation over re-deriving "most recently
      // stamped", which on an engine/A2A turn latched the last HUMAN conversation
      // and bled it into the recall. An id = that conversation; explicit null =
      // engine/A2A turn (untagged rows only, no human-conv bleed); undefined =
      // called outside a turn, use the legacy heuristic.
      //
      // PHASE-2 T10I: the scope is `conversations.id`, not a `conversationKey()` string. The
      // fallback query below cannot latch a SENTINEL any more, and that was a real hazard in
      // the string form: `engine`, `engine-steer` and `engine-notice` were valid `conv_key`
      // values on events-lane rows, so "the most recently stamped key in this session" could
      // scope a human recall to a rider. An events-lane rider has no conversation, so it can
      // no longer be picked up here at all.
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
      if (scopeConversationId) {
        // C17: keep the current conversation's stamped rows, but restrict the NULL part to
        // the agent's OWN activity (assistant/tool) or A2A rows, NEVER a bare
        // `conversation_id IS NULL`, which also matches ANOTHER human's not-yet-claimed
        // waiting inbound and legacy rows, bleeding a different human's conversation into
        // this recall (inv 4). The current conversation's own user rows are stamped at ingest
        // by their producer (C15), so they're covered by `conversation_id = ?`; the NULL
        // branch is only for this turn's still-untagged own scratch.
        clauses.push("(conversation_id = ? OR (conversation_id IS NULL AND (role IN ('assistant','tool') OR source_agent_id IS NOT NULL)))");
        params.push(scopeConversationId);
      } else if (opts.turnConversationId === null) {
        // Engine/A2A turn (no human conversation): restrict to the agent's own untagged
        // activity / A2A rows, never a human's unclaimed inbound or a prior human
        // conversation's tagged output.
        clauses.push("conversation_id IS NULL AND (role IN ('assistant','tool') OR source_agent_id IS NOT NULL)");
      }
    }
    if (opts.since) {
      clauses.push('created_at >= (unixepoch(?) * 1000)');
      params.push(normalizeTimestampForSqlite(opts.since));
    }
    if (beforeSeq != null) {
      clauses.push('seq < ?');
      params.push(beforeSeq);
    }
    // T5: ONE query over ONE table. This used to UNION `messages` with
    // `inter_agent_messages`, NULL-pad the columns the second table lacked and dedup the
    // double-homed ids with an anti-join, because peer A2A traffic had its own home. It no
    // longer does: agent-to-agent rows are `lane='a2a'` in this table, so the scope clauses
    // above reach them by reading columns instead of by reaching into a second store — and,
    // for the first time, so do FTS and the summaries. Recall deliberately spans every lane
    // the agent owns; the `chat_messages` view is what a PERSON sees.
    // STRIP; requirement preserved: recall covers agent-to-agent history.
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
    // RC-3 item 3: label the UNSCOPED view. Live context is conv-scoped, but
    // scope:'all' recall is the raw merged multi-conversation soup; without this
    // label the agent flips between two inconsistent views of "what just happened"
    // and misreads the extra rows as its live context being corrupt (the "I see you
    // in the recall but not your actual message text" panic). Explain the difference
    // at the source instead. (The counterparty name is not resolved at this layer, so
    // the label says "the current conversation" rather than naming it.)
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

    let truncatedResultCount = 0;
    let oldestIncludedId: string | null = null;
    let messagesShown = 0;

    for (const msg of slice) {
      if (!oldestIncludedId) oldestIncludedId = msg.id;
      // RC-3 item 1: count a row as "shown" ONLY if it actually emits at least one
      // line. The old `messagesShown += 1` counted every FETCHED row, so a body-less
      // response (an assistant row that is pure tool_use with include_tool_calls=false,
      // or a system row > 200 chars) footed "Showed 5 messages" with nothing visible,
      // which the agent read as corruption ("I see you in the recall but not your
      // message text"). Comparing lines.length before/after makes the count truthful.
      const linesBefore = lines.length;

      const role = ROLE_LABEL[msg.role] ?? msg.role.toUpperCase();
      const t = formatTimestamp(msg.created_at);

      if (msg.role === 'system') {
        const trimmed = msg.content.trim();
        if (trimmed.length <= 200) lines.push(`[${role} ${t}] ${trimmed}`);
      } else if (msg.role === 'user') {
        const userClip = clip(msg.content.trim(), messageChars);
        lines.push(`[${role} ${t}] ${userClip.text || '(no text)'}`);
        if (userClip.truncated > 0) {
          lines.push(
            `  [truncated, ${userClip.truncated} more chars, call history_get(id="${msg.id}") for full body]`,
          );
        }
      } else if (msg.role === 'tool') {
        // Only emitted when includeToolResults=true; otherwise tool rows
        // were filtered out by the SQL. Render with truncation.
        // Note: tool results emitted next to their tool_use (in the assistant
        // branch below) are consumed from toolResultsByUseId and won't appear
        // here. This branch is the fallback for orphaned tool rows.
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
                const resT = formatTimestamp(resultRow.created_at);
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

    // Footer, impossible to misread. Always tells the agent how to get
    // older slices, where the truncation cursor is, and how many results
    // were clipped.
    lines.push('');
    const footerParts: string[] = [];
    footerParts.push(`Showed ${messagesShown} messages from ${slice.length} fetched rows`);
    // RC-3 item 1: when fetched > emitted, the gap is tool-activity-only rows that
    // rendered nothing. Say so explicitly so a body-less footer is never misread as
    // corruption. This single line would have prevented the 7/12 panic.
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
