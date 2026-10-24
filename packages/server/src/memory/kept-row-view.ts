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
// A tool row is already shown this way (`capLargeToolResultStrings`); a row of content blocks is left
// as it is (its parts are tool calls or tool results, each sized on its own).
// ════════════════════════════════════════════════════════════════════════════════════════

import type { Message } from '@dojo/shared';
import { storedRowCost } from './budget.js';
import { toolResultView, POINTER_VIEW_CHARS } from './tool-result-view.js';

/** The handle `tool_result_read` takes for a whole stored row: `msg:<message id>`. */
export const KEPT_ROW_PREFIX = 'msg:';
export const keptRowHandle = (messageId: string): string => `${KEPT_ROW_PREFIX}${messageId}`;

/** `msg` as the view shows it inside `roomTokens`: itself when it fits, else its head, tail and pointer. */
export function overRoomRowView(msg: Message, roomTokens: number): Message {
  if (msg.role === 'tool' || typeof msg.content !== 'string' || storedRowCost(msg) <= roomTokens) return msg;
  // A row no longer than the standard pointer is shown whole: its pointer would cost as much and show less.
  if (msg.content.length <= POINTER_VIEW_CHARS) return msg;
  if (msg.content.trimStart().startsWith('[') && isBlockArray(msg.content)) return msg;
  // The standard pointer (t200): an eighth of one view of head and tail, and the label.
  return { ...msg, content: toolResultView(msg.content, keptRowHandle(msg.id), POINTER_VIEW_CHARS), tokenCount: null };
}

function isBlockArray(text: string): boolean {
  try { return Array.isArray(JSON.parse(text)); } catch { return false; }
}
