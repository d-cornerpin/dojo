// Admits one response's tool results together against the turn's room: they share one stored `tool` row,
// so several whole results could push the rest of the conversation out of view. The room is half the live
// conversation's room (`estimateAssembledTokens`) less the calls; largest results become pointers first, then
// the room is shared equally. Whole results stay in `kept_tool_results` via `keptWhole`, and the row stores
// exactly the bytes the model sees so every later assembly renders the same ones (prompt cache).

import { createLogger } from '../../../../logger.js';
import { agentTurnWindow } from '../../../../router/router-window.js';
import { estimateAssembledTokens } from '../../../../memory/compaction.js';
import { estimateTokens, CHARS_PER_TOKEN } from '../../../../memory/budget.js';
import { POINTER_VIEW_CHARS, toolResultView } from '../../../../memory/tool-result-view.js';
import { admitToolResult } from '../../../tools/index.js';
import type { ExecuteContext, PendingToolResult } from './index.js';

const logger = createLogger('v2-batch-admission');

interface Item {
  r: PendingToolResult;
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

/** Narrows results in place to fit the room; never throws (an unmeasurable room leaves them as admitted). */
export async function admitBatchToRoom(ctx: ExecuteContext, results: PendingToolResult[]): Promise<void> {
  try {
    const items = results.map(itemOf).filter((it): it is Item => it !== null);
    // Nothing to give: no result is long enough for its pointer to be shorter than it is.
    if (!items.some((it) => it.whole.length > POINTER_VIEW_CHARS)) return;
    const { view } = await estimateAssembledTokens(ctx.agentId, agentTurnWindow(ctx.agentId, ctx.effectiveModelIdForPersist), ctx.effectiveModelIdForPersist);
    if (view.tailRoomTokens <= 0) return;   // the room could not be measured: leave the results as they are
    const calls = estimateTokens(JSON.stringify(ctx.result.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments }))));
    const room = Math.max(0, Math.floor(view.tailRoomTokens / 2) - calls);
    const fixed = results.length > items.length
      ? results.reduce((t, r) => t + (items.some((it) => it.r === r) ? 0 : estimateTokens(typeof r.content === 'string' ? r.content : '')), 0)
      : 0;
    const total = (): number => fixed + items.reduce((t, it) => t + it.tokens, 0);
    if (total() <= room) return;

    const before = total();
    for (const it of [...items].sort((a, b) => b.tokens - a.tokens)) {
      if (total() <= room) break;
      narrow(it, POINTER_VIEW_CHARS);
    }
    // 2. Still over with every result a pointer: share the rest equally; small results keep what they need.
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
