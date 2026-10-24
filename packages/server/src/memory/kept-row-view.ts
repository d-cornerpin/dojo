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
//
// D18b (t257's final re-review): A ROW WHOSE BULK IS NOT TEXT IS NEVER FORCED IN WHOLE EITHER. A `tool_use` whose
// input is long keeps its id and name (so it still pairs with its result on every provider shape), and each long
// argument is its head + tail + `msg:<id>#<block>.<argument>`; `msg:<id>#<block>` reads the whole input. An image
// or document block whose own cost exceeds the room is its note (`oversizeMediaNote`): kind, name, type, size, and
// that it is not shown. The same note stands in for an owner's attachment the turn injects after the assembly
// (`attachmentsWithinRoom`), beside the attachment pointer the row already carries (name, size, Path, reader).
// Costs are the boundary's own (`lanes.ts` `messageTokens`: an image by its pixels, never its base64 length).
// ════════════════════════════════════════════════════════════════════════════════════════

import type { Message } from '@dojo/shared';
import { storedRowCost, replayedReasoningTokens } from './budget.js';
import { messageTokens } from './lanes.js';
import { toolResultView, POINTER_VIEW_CHARS, POINTER_LABEL_ROOM_CHARS } from './tool-result-view.js';
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
 * A structured row over the room. First, block by block: each long text block is its own pointer, each long call
 * input is pointered argument by argument, and an image or document over the room alone is its note. Fix round 5:
 * when the row is STILL over the room although no single block is (thousands of short text blocks, or a paste
 * of `"type":"text"` items), its text blocks collapse into ONE head + tail + pointer named `msg:<id>`, which
 * reads their text joined (`kept-results.ts`). D18b: if it is over the room even then, no non-text bulk rides
 * whole: every image and document is its note, and every call input longer than a label is its label alone.
 */
function structuredRowView(msg: Message, blocks: StoredBlock[], roomTokens: number): Message {
  const fits = (view: StoredBlock[]): boolean => messageTokens({ role: 'user', content: view as never }) + replayedReasoningTokens(msg) <= roomTokens;
  const done = (view: StoredBlock[]): Message => { const content = JSON.stringify(view); return content === msg.content ? msg : pointered(msg, content); };
  const each = blocks.map((b, i) => (b.type === 'text' && typeof b.text === 'string' && b.text.length > POINTER_VIEW_CHARS ? { ...b, text: toolResultView(b.text, keptRowHandle(msg.id, i), POINTER_VIEW_CHARS) }
    : b.type === 'tool_use' && inputChars(b.input) > POINTER_VIEW_CHARS ? { ...b, input: inputView(keptRowHandle(msg.id, i), b.input) }
      : isMedia(b) && mediaTokens(b) > roomTokens ? oversizeMediaNote(b) : b));
  if (fits(each)) return done(each);
  const text = keptRowText(blocks);
  const first = blocks.findIndex((b) => b.type === 'text');
  // Both steps below take a view aligned with `blocks` (index i is block i, so each handle names its own block).
  const collapse = (view: StoredBlock[]): StoredBlock[] => (text === null || text.length <= POINTER_VIEW_CHARS ? view
    : view.flatMap((b, i) => (i === first ? [{ type: 'text', text: toolResultView(text, keptRowHandle(msg.id), POINTER_VIEW_CHARS) }] : blocks[i].type === 'text' ? [] : [b])));
  const squeeze = (view: StoredBlock[]): StoredBlock[] => view.map((b, i) => (isMedia(b) ? oversizeMediaNote(b)
    : b.type === 'tool_use' && inputChars(b.input) > POINTER_LABEL_ROOM_CHARS ? { ...b, input: { input: toolResultView(callInputText(blocks[i].input), keptRowHandle(msg.id, i), POINTER_LABEL_ROOM_CHARS) } } : b));
  const collapsed = collapse(each);
  return done(fits(collapsed) ? collapsed : collapse(squeeze(each)));
}

// ── D18b: a call's input, an image, a document ──
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const inputChars = (input: unknown): number => JSON.stringify(input ?? {}).length;
/** One argument as `msg:<id>#<n>.<argument>` reads it: a string as it is (its own lines), anything else as JSON. */
export const argumentText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? String(v));
/** A call's whole input as `msg:<id>#<n>` reads it: each argument as `name: value`. */
export const callInputText = (input: unknown): string =>
  (isObject(input) ? Object.entries(input).map(([k, v]) => `${k}: ${argumentText(v)}`).join('\n') : argumentText(input));

/** A long call input as the view shows it: its short arguments as they are, each long one as its pointer. */
function inputView(handle: string, input: unknown): Record<string, unknown> {
  if (!isObject(input)) return { input: toolResultView(callInputText(input), handle, POINTER_VIEW_CHARS) };
  return Object.fromEntries(Object.entries(input).map(([k, v]) => {
    const whole = argumentText(v);
    return [k, whole.length > POINTER_VIEW_CHARS ? toolResultView(whole, `${handle}.${k}`, POINTER_VIEW_CHARS) : v];
  }));
}

export const isMedia = (b: StoredBlock): boolean => (b.type === 'image' || b.type === 'document') && typeof (b.source as { data?: unknown } | undefined)?.data === 'string';
const mediaTokens = (b: StoredBlock): number => messageTokens({ role: 'user', content: [b] as never });

/** What the view shows for an image or document block the room cannot hold: what it is, and that it is not shown. */
export function oversizeMediaNote(b: StoredBlock): StoredBlock {
  const source = b.source as { media_type?: unknown; data?: unknown };
  return { type: 'text', text: mediaNoteText({ image: b.type === 'image', mediaType: typeof source.media_type === 'string' ? source.media_type : b.type,
    title: typeof b.title === 'string' ? b.title : undefined, bytes: Buffer.byteLength(String(source.data), 'base64'), tokens: mediaTokens(b) }) };
}

/** The note's words, from what the attachment is (also priced before injection, `turn-attachments.ts`). */
export function mediaNoteText(m: { image: boolean; mediaType: string; title?: string; bytes: number; tokens: number }): string {
  const kind = m.image ? 'image' : m.mediaType === 'application/pdf' ? 'PDF' : 'document';
  const reader = kind === 'PDF' ? ' Where its Path is given with the attachment, pdf_read reads its text.' : ' If the user asks about it, say it is too large for the current model to see.';
  return `[Engine note: the attached ${kind} ${m.title ? `"${m.title}" ` : ''}(${m.mediaType}, ${m.bytes.toLocaleString('en-US')} bytes, ~${m.tokens.toLocaleString('en-US')} tokens) `
    + `is larger than the room this model has for the conversation, so it is NOT shown to you. Do not describe or assume its contents.${reader}]`;
}

/** D18b: the turn's injected attachments (`injectAttachmentBlocks`, after the assembly) never ride over the room. */
export function attachmentsWithinRoom(messages: Array<{ role: string; content: unknown }>, roomTokens: number | undefined): void {
  if (roomTokens === undefined) return;
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    const over = (b: StoredBlock): boolean => isMedia(b) && mediaTokens(b) > roomTokens;
    if ((m.content as StoredBlock[]).some(over)) m.content = (m.content as StoredBlock[]).map((b) => (over(b) ? oversizeMediaNote(b) : b));
  }
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
