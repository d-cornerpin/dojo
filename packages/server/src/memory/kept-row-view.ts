// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 D18 fix round 3 — A STORED ROW THAT ALONE EXCEEDS THE ROOM IS KEPT WHOLE, SHOWN AS A POINTER.
//
// The trim drops whole groups off the front and forces the newest in even when it alone is over
// budget (`budgetFreshTail`), and the served owner message is re-emitted whatever it costs
// (`served-ask.ts`). So a single owner message (or a reply) larger than the room made every assembly
// over budget, and no fold could change it: the re-review's probe, a ~39.6K-token message on a 32K
// window, refused identically for ever. The ruling: such a row is shown as its head, its tail and the
// kept-result pointer of t200 (`tool-result-view.ts`), with the existing pointer phrasing, and is read
// with the existing reader (`tool_result_read`), extended to name a row: the whole is the stored row
// itself, so nothing is copied and nothing is lost (`kept-results.ts`, `findToolResult`).
// A tool row is already shown this way (`capLargeToolResultStrings`).
//
// Fix round 4 (re-review 3, finding 1): A STRUCTURED ROW IS HANDLED BLOCK BY BLOCK, NEVER FORCED IN WHOLE.
// Round 3 left ANY row whose text parsed as a JSON array whole, so an owner's pasted JSON export over the
// room refused identically for ever and was reported as a false stall. Now a row is structured only when it
// is a real content-block array (every element a provider block, `contentBlocksOf`); anything else, a JSON
// export included, is text and is pointered like any row. In a structured row each TEXT block longer than
// the pointer becomes its own head + tail + pointer, named `msg:<id>#<block>`; image, document and tool
// blocks keep the representation they already have. If the row is still over the room, its text blocks
// collapse into one pointer (fix round 5, `structuredRowView`), so no text of a structured row is forced in whole.
// ════════════════════════════════════════════════════════════════════════════════════════

import type { Message } from '@dojo/shared';
import { storedRowCost } from './budget.js';
import { toolResultView, POINTER_VIEW_CHARS } from './tool-result-view.js';
import { getDb } from '../db/connection.js';

/** The handle `tool_result_read` takes for a whole stored row (`msg:<message id>`), or for one text block of a
 *  structured row (`msg:<message id>#<block index>`). */
export const KEPT_ROW_PREFIX = 'msg:';
export const keptRowHandle = (messageId: string, block?: number): string =>
  `${KEPT_ROW_PREFIX}${messageId}${block === undefined ? '' : `#${block}`}`;

/** The block types a stored row's content array carries (what the providers take as content blocks). */
const BLOCK_TYPES = new Set(['text', 'image', 'document', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking',
  'search_result', 'server_tool_use', 'web_search_tool_result']);

export type StoredBlock = { type: string; text?: unknown; [k: string]: unknown };

/** The row's content blocks when it is a real content-block array, else null (it is text — a pasted JSON array too). */
export function contentBlocksOf(content: string): StoredBlock[] | null {
  if (!content.trimStart().startsWith('[')) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const isBlock = (b: unknown): b is StoredBlock => !!b && typeof b === 'object' && BLOCK_TYPES.has((b as { type?: unknown }).type as string);
  return parsed.every(isBlock) ? parsed : null;
}

/** `msg` as the view shows it inside `roomTokens`: itself when it fits, else its head, tail and pointer. */
export function overRoomRowView(msg: Message, roomTokens: number): Message {
  if (msg.role === 'tool' || typeof msg.content !== 'string' || storedRowCost(msg) <= roomTokens) return msg;
  const blocks = contentBlocksOf(msg.content);
  if (blocks) return structuredRowView(msg, blocks, roomTokens);
  // A row no longer than the standard pointer is shown whole: its pointer would cost as much and show less.
  if (msg.content.length <= POINTER_VIEW_CHARS) return msg;
  // The standard pointer (t200): an eighth of one view of head and tail, and the label.
  return pointered(msg, toolResultView(msg.content, keptRowHandle(msg.id), POINTER_VIEW_CHARS));
}

/**
 * A structured row over the room. First, block by block: each long text block is its own pointer. Fix round 5:
 * when the row is STILL over the room although no single block is (thousands of short text blocks, or a paste
 * of `"type":"text"` items), its text blocks collapse into ONE head + tail + pointer named `msg:<id>`, which
 * reads their text joined (`kept-results.ts`). Image, document and tool blocks are kept as they are, in place.
 */
function structuredRowView(msg: Message, blocks: StoredBlock[], roomTokens: number): Message {
  const each = blocks.map((b, i) =>
    (b.type === 'text' && typeof b.text === 'string' && b.text.length > POINTER_VIEW_CHARS ? { ...b, text: toolResultView(b.text, keptRowHandle(msg.id, i), POINTER_VIEW_CHARS) } : b));
  const view: Message = { ...msg, content: JSON.stringify(each), tokenCount: null };
  if (storedRowCost(view) <= roomTokens) return view.content === msg.content ? msg : pointered(msg, view.content);
  const text = keptRowText(blocks);
  if (text === null || text.length <= POINTER_VIEW_CHARS) return view.content === msg.content ? msg : pointered(msg, view.content);
  const first = blocks.findIndex((b) => b.type === 'text');
  const collapsed = blocks.flatMap((b, i) => (i === first ? [{ type: 'text', text: toolResultView(text, keptRowHandle(msg.id), POINTER_VIEW_CHARS) }] : b.type === 'text' ? [] : [b]));
  return pointered(msg, JSON.stringify(collapsed));
}

/** The text a structured row's `msg:<id>` reads: its text blocks joined, or null when it has none. */
export function keptRowText(blocks: StoredBlock[]): string | null {
  const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string);
  return texts.length > 0 ? texts.join('\n') : null;
}

// ── Fix round 5 (ruling 2): A `msg:` READ IS ALLOWED EXACTLY WHEN THE VIEW SHOWED THE POINTER ──
// Round 4 scoped the read by the history tools' filter, which is narrower than the view: an engine turn's own
// trigger row and another thread's question the human-turn scoper keeps were pointered and then refused. The
// read now asks the view itself: the rows a view of this agent pointered, in the session that view belonged to
// (a reset starts a view that cannot show them). Never stricter than the view, never wider.
const pointeredRows = new Map<string, Map<string, string | null>>();
const sessionOf = (agentId: string): string | null =>
  (getDb().prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined)?.session_started_at ?? null;

function pointered(msg: Message, content: string): Message {
  const rows = pointeredRows.get(msg.agentId) ?? new Map<string, string | null>();
  rows.set(msg.id, sessionOf(msg.agentId));
  pointeredRows.set(msg.agentId, rows);
  return { ...msg, content, tokenCount: null };
}

/** Did a view of this agent, in its current session, point at row `messageId`? */
export function viewPointeredRow(agentId: string, messageId: string): boolean {
  const rows = pointeredRows.get(agentId);
  if (!rows?.has(messageId)) return false;
  if (rows.get(messageId) === sessionOf(agentId)) return true;
  rows.delete(messageId);   // shown before a reset: the new session's view cannot show it
  return false;
}
