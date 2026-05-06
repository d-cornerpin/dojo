// ════════════════════════════════════════
// recall_recent_thread — agent-callable transcript recall
// ════════════════════════════════════════
//
// Returns a tight, human-readable transcript of the agent's last N
// user/assistant exchanges. Tool calls are reduced to a single line
// each; tool RESULTS are never included. The transcript reads from the
// raw messages table and respects session_started_at, so it shows what
// was actually said in this session, regardless of what the assembler
// trimmed or stubbed for the active context.
//
// Use case: post-compaction reorientation, or any time the agent has
// "lost the thread."

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

export interface RecallOptions {
  turnCount: number;
  includeToolCalls: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  user: 'USER',
  assistant: 'ASSISTANT',
  tool: 'TOOL',
  system: 'SYSTEM',
};

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function formatTimestamp(iso: string): string {
  // Stored as "YYYY-MM-DD HH:MM:SS" — keep it compact.
  return iso.slice(11, 16); // "HH:MM"
}

interface AssistantPart {
  text: string | null;
  toolCalls: Array<{ name: string; args: string }>;
}

function parseAssistantContent(content: string): AssistantPart {
  // Assistant content can be a plain string OR a JSON array of content
  // blocks (text + tool_use). Reduce to text + a tidy list of tool calls.
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const texts: string[] = [];
      const toolCalls: Array<{ name: string; args: string }> = [];
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
                  if (typeof v === 'string') return `${k}="${clip(v, 60)}"`;
                  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return `${k}=${v}`;
                  return `${k}=…`;
                })
                .slice(0, 4);
              argsStr = entries.join(' ');
            }
          } catch { /* best effort */ }
          toolCalls.push({ name: b.name as string, args: argsStr });
        }
      }
      return { text: texts.join('\n').trim() || null, toolCalls };
    }
  } catch {
    /* not JSON */
  }
  return { text: content.trim() || null, toolCalls: [] };
}

export function recallRecentThread(agentId: string, opts: RecallOptions): string {
  const db = getDb();
  try {
    // Respect session boundary so a recent reset doesn't bleed pre-reset
    // content into the recall.
    const sessionRow = db
      .prepare('SELECT session_started_at FROM agents WHERE id = ?')
      .get(agentId) as { session_started_at: string | null } | undefined;
    const sessionBoundary = sessionRow?.session_started_at ?? null;

    // Pull more than we need, then trim to N user→assistant exchanges.
    // A "turn" here is one user message and the contiguous assistant
    // messages that follow it before the next user message.
    const fetchLimit = Math.max(opts.turnCount * 6, 40);
    const sql = sessionBoundary
      ? `SELECT id, role, content, created_at, attachments FROM messages
         WHERE agent_id = ? AND created_at >= ? AND role IN ('user','assistant','system')
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`
      : `SELECT id, role, content, created_at, attachments FROM messages
         WHERE agent_id = ? AND role IN ('user','assistant','system')
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`;
    const params = sessionBoundary ? [agentId, sessionBoundary, fetchLimit] : [agentId, fetchLimit];
    const rows = db.prepare(sql).all(...params) as MessageRow[];

    if (rows.length === 0) {
      return sessionBoundary
        ? 'No conversation in the current session yet — the session was just reset.'
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

    const lines: string[] = [];
    lines.push(
      `[Recent thread — last ${opts.turnCount} user/assistant exchanges, raw from messages table.${
        sessionBoundary ? ' Bounded by current session.' : ''
      }]`,
    );
    lines.push('');

    for (const msg of slice) {
      const role = ROLE_LABEL[msg.role] ?? msg.role.toUpperCase();
      const t = formatTimestamp(msg.created_at);
      if (msg.role === 'system') {
        // Only include short system markers (dividers, [New Session], etc.)
        const trimmed = msg.content.trim();
        if (trimmed.length <= 200) lines.push(`[${role} ${t}] ${trimmed}`);
        continue;
      }
      if (msg.role === 'user') {
        const text = clip(msg.content.trim(), 600);
        lines.push(`[${role} ${t}] ${text || '(no text)'}`);
        continue;
      }
      // assistant
      const parts = parseAssistantContent(msg.content);
      if (parts.text) {
        lines.push(`[${role} ${t}] ${clip(parts.text, 600)}`);
      }
      if (opts.includeToolCalls && parts.toolCalls.length > 0) {
        for (const tc of parts.toolCalls) {
          lines.push(`[${role} ${t}] (called: ${tc.name}${tc.args ? ' ' + tc.args : ''})`);
        }
      }
    }

    return lines.join('\n');
  } catch (err) {
    logger.warn('recall_recent_thread failed', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return `Error recalling recent thread: ${err instanceof Error ? err.message : String(err)}`;
  }
}
