// A stored row that alone exceeds the room is shown as its head, tail and a `msg:<id>` pointer;
// `tool_result_read` reads it whole (`kept-results.ts`), so no row is forced in whole and none is copied.
// A structured row (a real content-block array, `contentBlocksOf`) is handled block by block: long text
// blocks and call arguments are pointered; an oversize image or document is a note (`oversizeMediaNote`).
// Costs are `lanes.ts` `messageTokens` (an image by its pixels, never its base64 length).

import type { Message } from '@dojo/shared';
import { storedRowCost, replayedReasoningTokens } from './budget.js';
import { messageTokens } from './lanes.js';
import { toolResultView, POINTER_VIEW_CHARS, POINTER_LABEL_ROOM_CHARS } from './tool-result-view.js';
import { getDb } from '../db/connection.js';
import { attachmentBrackets, defangExternalMarkers } from '../tools/external-content.js';
import { sessionBoundaryText } from './session-boundary.js';

/** The handle `tool_result_read` takes for a stored row (`msg:<id>`) or a block (`msg:<id>#<block>`). */
export const KEPT_ROW_PREFIX = 'msg:';
/** Kind of a summaries-lane note for a stored row no summary writer could take whole (`writer.ts`). */
export const KEPT_WHOLE_KIND = 'kept_whole';
export const KEPT_NOTE_PREFIX = 'note:';
export const keptNoteHandle = (summaryId: string): string => `${KEPT_NOTE_PREFIX}${summaryId}`;
export const keptRowHandle = (messageId: string, block?: number): string =>
  `${KEPT_ROW_PREFIX}${messageId}${block === undefined ? '' : `#${block}`}`;

const BLOCK_TYPES = new Set(['text', 'image', 'document', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking',
  'search_result', 'server_tool_use', 'web_search_tool_result']);

export type StoredBlock = { type: string; text?: unknown; [k: string]: unknown };

/** The row's content blocks when it is a real content-block array, else null (it is text). */
export function contentBlocksOf(content: string): StoredBlock[] | null {
  if (!content.trimStart().startsWith('[')) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const isBlock = (b: unknown): b is StoredBlock => !!b && typeof b === 'object' && BLOCK_TYPES.has((b as { type?: unknown }).type as string);
  return parsed.every(isBlock) ? parsed : null;
}

export function overRoomRowView(msg: Message, roomTokens: number): Message {
  if (msg.role === 'tool' || typeof msg.content !== 'string' || storedRowCost(msg) <= roomTokens) return msg;
  const blocks = contentBlocksOf(msg.content);
  if (blocks) return structuredRowView(msg, blocks, roomTokens);
  // A row no longer than the standard pointer is shown whole: its pointer would cost as much and show less.
  if (msg.content.length <= POINTER_VIEW_CHARS) return msg;
  return pointered(msg, toolResultView(msg.content, keptRowHandle(msg.id), POINTER_VIEW_CHARS, 'message'));
}

/**
 * A structured row over the room. First block by block (long text blocks and call arguments pointered,
 * oversize media as notes); if still over, its text blocks collapse into one pointer named `msg:<id>`;
 * if still over, every image and document is its note and every long call input is its label alone.
 */
function structuredRowView(msg: Message, blocks: StoredBlock[], roomTokens: number): Message {
  const fits = (view: StoredBlock[]): boolean => messageTokens({ role: 'user', content: view as never }) + replayedReasoningTokens(msg) <= roomTokens;
  const done = (view: StoredBlock[]): Message => { const content = JSON.stringify(view); return content === msg.content ? msg : pointered(msg, content); };
  const each = blocks.map((b, i) => (b.type === 'text' && typeof b.text === 'string' && b.text.length > POINTER_VIEW_CHARS ? { ...b, text: toolResultView(b.text, keptRowHandle(msg.id, i), POINTER_VIEW_CHARS, 'message') }
    : b.type === 'tool_use' && inputChars(b.input) > POINTER_VIEW_CHARS ? { ...b, input: inputView(keptRowHandle(msg.id, i), b.input) }
      : isMedia(b) && mediaTokens(b) > roomTokens ? oversizeMediaNote(b) : b));
  if (fits(each)) return done(each);
  const text = keptRowText(blocks);
  const first = blocks.findIndex((b) => b.type === 'text');
  // Both steps take a view aligned with `blocks` (index i is block i), so each handle names its own block.
  const collapse = (view: StoredBlock[]): StoredBlock[] => (text === null || text.length <= POINTER_VIEW_CHARS ? view
    : view.flatMap((b, i) => (i === first ? [{ type: 'text', text: toolResultView(text, keptRowHandle(msg.id), POINTER_VIEW_CHARS, 'message') }] : blocks[i].type === 'text' ? [] : [b])));
  const squeeze = (view: StoredBlock[]): StoredBlock[] => view.map((b, i) => (isMedia(b) ? oversizeMediaNote(b)
    : b.type === 'tool_use' && inputChars(b.input) > POINTER_LABEL_ROOM_CHARS ? { ...b, input: { input: toolResultView(callInputText(blocks[i].input), keptRowHandle(msg.id, i), POINTER_LABEL_ROOM_CHARS, 'call input') } } : b));
  const collapsed = collapse(each);
  return done(fits(collapsed) ? collapsed : collapse(squeeze(each)));
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const inputChars = (input: unknown): number => JSON.stringify(input ?? {}).length;
export const argumentText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? String(v));
export const callInputText = (input: unknown): string =>
  (isObject(input) ? Object.entries(input).map(([k, v]) => `${k}: ${argumentText(v)}`).join('\n') : argumentText(input));

function inputView(handle: string, input: unknown): Record<string, unknown> {
  if (!isObject(input)) return { input: toolResultView(callInputText(input), handle, POINTER_VIEW_CHARS, 'call input') };
  return Object.fromEntries(Object.entries(input).map(([k, v]) => {
    const whole = argumentText(v);
    return [k, whole.length > POINTER_VIEW_CHARS ? toolResultView(whole, `${handle}.${k}`, POINTER_VIEW_CHARS, 'argument') : v];
  }));
}

export const isMedia = (b: StoredBlock): boolean => (b.type === 'image' || b.type === 'document') && typeof (b.source as { data?: unknown } | undefined)?.data === 'string';
const mediaTokens = (b: StoredBlock): number => messageTokens({ role: 'user', content: [b] as never });

export function oversizeMediaNote(b: StoredBlock): StoredBlock {
  const source = b.source as { media_type?: unknown; data?: unknown };
  return { type: 'text', text: mediaNoteText({ image: b.type === 'image', mediaType: typeof source.media_type === 'string' ? source.media_type : b.type,
    title: typeof b.title === 'string' ? b.title : undefined, bytes: Buffer.byteLength(String(source.data), 'base64'), tokens: mediaTokens(b) }) };
}

export function mediaNoteText(m: { image: boolean; mediaType: string; title?: string; bytes: number; tokens: number }): string {
  const kind = m.image ? 'image' : m.mediaType === 'application/pdf' ? 'PDF' : 'document';
  const reader = kind === 'PDF' ? ' Where its Path is given with the attachment, pdf_read reads its text.' : ' If the person you are talking to asks about it, say it is too large for the current model to see.';
  return `[Engine note: the attached ${kind} ${m.title ? `"${m.title}" ` : ''}(${m.mediaType}, ${m.bytes.toLocaleString('en-US')} bytes, ~${m.tokens.toLocaleString('en-US')} tokens) `
    + `is larger than the room this model has for the conversation, so it is NOT shown to you. Do not describe or assume its contents.${reader}]`;
}

/** The turn's injected attachments (`injectAttachmentBlocks`) never ride over the room. */
export function attachmentsWithinRoom(messages: Array<{ role: string; content: unknown }>, roomTokens: number | undefined): void {
  if (roomTokens === undefined) return;
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    const over = (b: StoredBlock): boolean => isMedia(b) && mediaTokens(b) > roomTokens;
    const blocks = m.content as StoredBlock[];
    if (!blocks.some(over)) continue;
    // A contact's attachment is bracketed by its fence (`tools/inbound-fences.ts`). Its note is the
    // engine's, so it goes OUTSIDE the fence; the sender's file name stays inside, and an empty fence goes.
    const { around } = attachmentBrackets(blocks);
    const dropped = new Set(blocks.flatMap((b, i) => (over(b) && around[i] ? [i - 1, i + 1] : [])));
    m.content = blocks.flatMap((b, i): StoredBlock[] => {
      const fence = around[i];
      if (dropped.has(i) || !over(b)) return dropped.has(i) ? [] : [b];
      if (!fence) return [oversizeMediaNote(b)];
      const note = oversizeMediaNote({ ...b, title: undefined });
      return typeof b.title === 'string' ? [note, { type: 'text', text: fence.head }, { type: 'text', text: defangExternalMarkers(`File name: ${b.title}`) }, { type: 'text', text: fence.end }] : [note];
    });
  }
}

export function keptRowText(blocks: StoredBlock[]): string | null {
  const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string);
  return texts.length > 0 ? texts.join('\n') : null;
}

// A `msg:` read is allowed exactly when a view of this agent pointered the row, in the session that view
// belonged to (a reset starts a view that cannot show it): never stricter than the view, never wider.
const pointeredRows = new Map<string, Map<string, string | null>>();

function pointered(msg: Message, content: string): Message {
  const rows = pointeredRows.get(msg.agentId) ?? new Map<string, string | null>();
  rows.set(msg.id, sessionBoundaryText(msg.agentId));
  pointeredRows.set(msg.agentId, rows);
  return { ...msg, content, tokenCount: null };
}

/** Did a view of this agent, in its current session, point at row `messageId`? A kept-whole note counts. */
export function viewPointeredRow(agentId: string, messageId: string): boolean {
  if (keptWholeNoteShows(agentId, messageId)) return true;
  const rows = pointeredRows.get(agentId);
  if (!rows?.has(messageId)) return false;
  if (rows.get(messageId) === sessionBoundaryText(agentId)) return true;
  rows.delete(messageId);   // shown before a reset: the new session's view cannot show it
  return false;
}

function keptWholeNoteShows(agentId: string, messageId: string): boolean {
  try {
    return !!getDb().prepare(
      `SELECT 1 FROM summaries s JOIN summary_messages sm ON sm.summary_id = s.id
        WHERE s.agent_id = ? AND s.kind = ? AND sm.message_id = ? AND instr(s.content, ?) > 0 LIMIT 1`,
    ).get(agentId, KEPT_WHOLE_KIND, messageId, JSON.stringify(keptRowHandle(messageId)));
  } catch {
    return false;
  }
}
