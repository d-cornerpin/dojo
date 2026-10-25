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
import { KEPT_ROW_PREFIX, KEPT_NOTE_PREFIX, argumentText, callInputText, contentBlocksOf, isMedia, keptRowText, oversizeMediaNote, viewPointeredRow } from './kept-row-view.js';

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
  // v3.5 D18 r3: a stored row too long for the view (`kept-row-view.ts`) is named `msg:<id>`; the row is the whole.
  if (toolUseId.startsWith(KEPT_ROW_PREFIX)) return findKeptRow(agentId, toolUseId.slice(KEPT_ROW_PREFIX.length));
  // t269 fix round 2: a note the summaries lane showed as its pointer (`summaries-lane.ts`) is read whole here.
  if (toolUseId.startsWith(KEPT_NOTE_PREFIX)) {
    const note = db.prepare('SELECT content FROM summaries WHERE agent_id = ? AND id = ?').get(agentId, toolUseId.slice(KEPT_NOTE_PREFIX.length)) as { content: string } | undefined;
    return note ? { content: note.content, toolName: null } : null;
  }
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

/**
 * The whole of a stored row named `msg:<id>` (or one block of a structured row, `msg:<id>#<block>[.<argument>]`). Read
 * exactly when a view of this agent pointered that row in its current session (`viewPointeredRow`, v3.5 D18 r5):
 * never stricter than what the view showed, never wider. Any other id is not found, as for an unknown one.
 */
function findKeptRow(agentId: string, handle: string): FoundResult | null {
  const read = (id: string): string | null => (viewPointeredRow(agentId, id)
    ? (getDb().prepare('SELECT content FROM messages WHERE agent_id = ? AND id = ?').get(agentId, id) as { content: string } | undefined)?.content ?? null
    : null);
  const whole = read(handle);
  if (whole !== null) {
    const blocks = contentBlocksOf(whole);
    // D18b r1: a row with no text reads with each image/document as its note (what it is, its reader), never its base64.
    return { content: blocks ? keptRowText(blocks) ?? blocks.map((b) => (isMedia(b) ? String(oversizeMediaNote(b).text) : JSON.stringify(b))).join('\n') : whole, toolName: null };
  }
  // `msg:<id>#<n>`: text block n, or call n's whole input; D18b `msg:<id>#<n>.<argument>`: one argument of call n.
  const named = /^(.+?)#(\d+)(?:\.(.+))?$/.exec(handle);
  const row = named ? read(named[1]) : null;
  const block = row === null ? undefined : contentBlocksOf(row)?.[Number(named![2])];
  const arg = named?.[3];
  if (block?.type === 'text' && typeof block.text === 'string' && arg === undefined) return { content: block.text, toolName: null };
  if (block?.type !== 'tool_use') return null;
  const input = block.input as Record<string, unknown> | undefined;
  const toolName = typeof block.name === 'string' ? block.name : null;
  if (arg === undefined) return { content: callInputText(input), toolName };
  return input && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, arg) ? { content: argumentText(input[arg]), toolName } : null;
}
