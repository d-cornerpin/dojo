// ════════════════════════════════════════════════════════════════════════════════════════
// t211 (D7a, ctx 11) — THE RESULTS OF ONE RESPONSE ARE ADMITTED TOGETHER, AGAINST THE ROOM THE TURN HAS.
//
// Each result is admitted on its own at the executor (`admitToolResult`): shown whole up to one view, a pointer
// beyond it. But one response can call several tools at once and all their results land in ONE stored `tool`
// row, which the trim and the fold treat as one unit with its call. Six results of 12,000 tokens were six
// whole results, ~72K tokens in one row on a 65K window: more than the live conversation's whole room, so the
// newest group (kept whatever it costs) pushed the rest of the conversation out of view.
//
// THE ROOM is read off the assembler's own gauge (`estimateAssembledTokens`): the live conversation's room in
// the content budget, of which the newest whole groups may take up to half (the protected recent part,
// `viewOf`'s law: owner decision 7b), less the response's own calls. There is no constant here; a bigger window
// or a smaller system prompt gives the batch more.
//
// WHEN THE BATCH DOES NOT FIT, results give way in the order of what each costs:
//   1. the LARGEST result becomes its pointer first (the start, the end with the engine's trailer, a label that
//      names the size and the exact `tool_result_read` call), then the next largest, and so on until it fits;
//   2. if every result is already a pointer and the batch still does not fit, the room is shared equally
//      (small results keep what they need, the rest share what is left) and each pointer's excerpt narrows to
//      its share. The label stays whatever the share, so every result says how big it is and how to read it.
// NOTHING IS LOST: the whole of every result switched is kept in `kept_tool_results` by the recorder
// (`keptWhole`), exactly as for a result past one view. The row stores the bytes the model will see, so every
// later assembly renders the same ones (the cache tenet forbids a view that moves as headroom moves), and
// there is nothing else to store: no migration, and a row recorded before this is untouched.
// ════════════════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../../../../logger.js';
import { getContextWindow } from '../../../model.js';
import { estimateAssembledTokens } from '../../../../memory/compaction.js';
import { estimateTokens, CHARS_PER_TOKEN } from '../../../../memory/budget.js';
import { POINTER_VIEW_CHARS, toolResultView } from '../../../../memory/tool-result-view.js';
import { admitToolResult } from '../../../tools/index.js';
import type { ExecuteContext, PendingToolResult } from './index.js';

const logger = createLogger('v2-batch-admission');

interface Item {
  r: PendingToolResult;
  /** The whole result as the tool produced it. */
  whole: string;
  /** What the row stores around the result's own view (an engine warning ahead of it, a notice after it). */
  before: string;
  after: string;
  tokens: number;
}

/** The result as a text candidate for a smaller view, or null when it is not one (an image, a document). */
function itemOf(r: PendingToolResult): Item | null {
  if (r.contentBlocks || typeof r.content !== 'string') return null;
  if (r.keptWhole === undefined) return { r, whole: r.content, before: '', after: '', tokens: estimateTokens(r.content) };
  // Already a pointer: find it inside the content, so what was added around it survives a narrower one.
  const own = admitToolResult(r.name, r.toolCallId, r.keptWhole, r.isError).content;
  const at = r.content.indexOf(own);
  if (at < 0) return null;
  return { r, whole: r.keptWhole, before: r.content.slice(0, at), after: r.content.slice(at + own.length), tokens: estimateTokens(r.content) };
}

/** Show the result at `viewChars`. Returns false when that changes nothing (it already fits that view). */
function narrow(it: Item, viewChars: number): boolean {
  const view = toolResultView(it.whole, it.r.toolCallId, viewChars);
  if (view === it.whole) return false;
  const content = `${it.before}${view}${it.after}`;
  if (content === it.r.content) return false;
  it.r.content = content;
  it.r.keptWhole = it.whole;
  it.tokens = estimateTokens(content);
  return true;
}

/**
 * Admit this response's results against the room. Changes `content` (and `keptWhole`) of results in place; never
 * throws (an unmeasurable room leaves every result as the executor admitted it).
 */
export async function admitBatchToRoom(ctx: ExecuteContext, results: PendingToolResult[]): Promise<void> {
  try {
    const items = results.map(itemOf).filter((it): it is Item => it !== null);
    // Nothing to give: no result is long enough for its pointer to be shorter than it is.
    if (!items.some((it) => it.whole.length > POINTER_VIEW_CHARS)) return;
    const { view } = await estimateAssembledTokens(ctx.agentId, getContextWindow(ctx.effectiveModelIdForPersist), ctx.effectiveModelIdForPersist);
    if (view.tailRoomTokens <= 0) return;   // the room could not be measured: leave the results as they are
    const calls = estimateTokens(JSON.stringify(ctx.result.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments }))));
    const room = Math.max(0, Math.floor(view.tailRoomTokens / 2) - calls);
    const fixed = results.length > items.length
      ? results.reduce((t, r) => t + (items.some((it) => it.r === r) ? 0 : estimateTokens(typeof r.content === 'string' ? r.content : '')), 0)
      : 0;
    const total = (): number => fixed + items.reduce((t, it) => t + it.tokens, 0);
    if (total() <= room) return;

    // 1. Largest first, to the standard pointer.
    const before = total();
    for (const it of [...items].sort((a, b) => b.tokens - a.tokens)) {
      if (total() <= room) break;
      narrow(it, POINTER_VIEW_CHARS);
    }
    // 2. Still over with every result at its pointer: share what is left equally; small results keep what they need.
    if (total() > room) {
      let left = room - fixed;
      const ascending = [...items].sort((a, b) => a.tokens - b.tokens);
      ascending.forEach((it, i) => {
        const share = Math.max(0, Math.floor(left / (ascending.length - i)));
        if (it.tokens > share) narrow(it, share * CHARS_PER_TOKEN);
        left -= it.tokens;
      });
    }
    logger.info('v2: a batch of tool results was admitted against the room the turn has', {
      results: results.length, roomTokens: room, tokensBefore: before, tokensAfter: total(),
    }, ctx.agentId);
  } catch (err) {
    logger.warn('v2: batch admission could not measure the room; results left as the executor admitted them', {
      error: err instanceof Error ? err.message : String(err),
    }, ctx.agentId);
  }
}
