// ════════════════════════════════════════════════════════════════════════════════════════
// KEPT TOOL RESULTS (t200, D12) — the whole of a result too long for the view, and the one
// lookup that finds any tool result by its call id.
//
// WRITE. The loop's recorder hands over the `tool` row (which carries what the agent sees: for a
// long result, its pointer) together with the whole of each long result. They are written as ONE
// unit, so a pointer never exists without the result it points at, and the foreign key on
// `message_id` (migration 199) makes the whole live exactly as long as that row.
//
// READ. `tool_result_read` asks for a result by the tool call id its pointer names. A result
// admitted since t200 is in `kept_tool_results`. A result recorded before t200, or one short enough
// to have been shown whole, is whole on its own `tool` row already — that row is READ, never copied,
// which is the "reuse what is already stored" half of the owner's design.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { withUnit } from '../db/unit.js';
import { insertMessageIfAbsent, type NewMessage } from './message-store.js';

/** The whole of one long result, as the recorder hands it over. */
export interface KeptWhole {
  toolUseId: string;
  toolName: string;
  content: string;
}

/** Write a `tool` row and the whole of every long result it points at, as one unit. */
export function insertToolRowKeepingWhole(row: NewMessage & { id: string }, kept: readonly KeptWhole[]): void {
  if (kept.length === 0) {
    insertMessageIfAbsent(row);
    return;
  }
  withUnit(() => {
    if (insertMessageIfAbsent(row) === null) return;
    const keep = getDb().prepare(
      `INSERT OR IGNORE INTO kept_tool_results (message_id, tool_use_id, agent_id, tool_name, content)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const k of kept) keep.run(row.id, k.toolUseId, row.agentId, k.toolName, k.content);
  });
}

/** A tool result found by its call id. */
export interface FoundResult {
  content: string;
  toolName: string | null;
}

/** The text of a stored `tool_result` block: a string as it is, an array of content blocks as
 *  its text parts (an image or a document has nothing to read as text). */
function blockText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? (b as { text?: unknown }).text : null))
    .filter((t): t is string => typeof t === 'string');
  return texts.length > 0 ? texts.join('\n') : null;
}

/** The whole of this agent's tool result with this call id, or null when none is stored. */
export function findToolResult(agentId: string, toolUseId: string): FoundResult | null {
  const db = getDb();
  const kept = db.prepare(
    `SELECT content, tool_name FROM kept_tool_results WHERE agent_id = ? AND tool_use_id = ?
     ORDER BY rowid DESC LIMIT 1`,
  ).get(agentId, toolUseId) as { content: string; tool_name: string | null } | undefined;
  if (kept) return { content: kept.content, toolName: kept.tool_name };

  // Newest first: the row a pointer in the live view names is a recent one, so the walk stops early.
  const needle = `"tool_use_id":${JSON.stringify(toolUseId)}`;
  const row = db.prepare(
    `SELECT content FROM messages WHERE agent_id = ? AND role = 'tool' AND instr(content, ?) > 0
     ORDER BY seq DESC LIMIT 1`,
  ).get(agentId, needle) as { content: string } | undefined;
  if (!row) return null;
  try {
    const blocks = JSON.parse(row.content) as Array<{ type?: string; tool_use_id?: string; content?: unknown }>;
    const block = Array.isArray(blocks) ? blocks.find((b) => b?.type === 'tool_result' && b.tool_use_id === toolUseId) : undefined;
    const text = block ? blockText(block.content) : null;
    return text === null ? null : { content: text, toolName: null };
  } catch {
    return null;
  }
}
