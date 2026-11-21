// A summary is kept only whole: finished, no longer than its input, carrying its notes' facts; nothing here edits
// what the writer wrote. CUT (`length` on OpenAI-compatible/Ollama, `max_tokens` on Anthropic): asked once more with
// room up to the input's size, within `outputRoom` (Anthropic reports none, so its cut is refused at once); cut
// again is `tooBig`, so callers split the span and the rows stay whole. TOO LONG (over the target's slack or the
// input): rewritten once FROM THE SOURCE; a MERGE still too long is `tooBig`, and is kept only within its slack
// (`mergeTargetTokens`). A MERGE THAT DROPPED FACTS IT HAD ROOM FOR (`carriedFacts`) is rewritten once and the
// answer with fewer dropped facts is kept. The rewrite is sent only if the writer's window holds it; if it throws
// or is cut, the first answer is kept when it passed its own checks. Worst case: 4 writer calls per `writeWhole`,
// x2 for the accuracy check's rewrite, x the writers walked (`writer.ts`): at most 8 x candidate writers per span.

import { estimateTokens } from './budget.js';
import { factsDropped, TARGET_SLACK, textTokens } from './summary-target.js';
import type { SummaryResult } from './summarize.js';

export interface WriterAnswer { content: string; stopReason: string | null; outputRoom?: { sent: number; ceiling: number } }
export type WriterCall = (extra: string, outputRoomAsk?: number) => Promise<WriterAnswer>;

const CUT_STOP_REASONS: ReadonlySet<string> = new Set(['length', 'max_tokens']);
export const wasCut = (a: WriterAnswer): boolean => CUT_STOP_REASONS.has(a.stopReason ?? '');

type Done = { text: string } | { refused: SummaryResult };

export interface WholeArgs {
  call: WriterCall; content: string; depth: number; targetTokens: number; abortSignal?: AbortSignal;
  warn: (message: string, meta: Record<string, unknown>) => void;
  charsPerToken?: number;
  fits: (extra: string) => boolean;
}

/** One summary written over the source, finished: a cut answer is asked again with room, refused if cut again. */
async function finished(a: WholeArgs, extra: string, inputTokens: number): Promise<Done> {
  let answer = await a.call(extra);
  if (a.abortSignal?.aborted) return { refused: { ok: false, reason: 'summarizer call was aborted before it finished' } };
  if (wasCut(answer)) {
    const room = answer.outputRoom;
    const ask = room ? Math.min(room.ceiling, inputTokens) : 0;
    if (room && ask > room.sent) {
      answer = await a.call(extra, ask);
      if (a.abortSignal?.aborted) return { refused: { ok: false, reason: 'summarizer call was aborted before it finished' } };
    }
    if (wasCut(answer)) {
      a.warn('SUMMARY_REFUSED the summary was cut off by the output limit; the span is left whole for a smaller split', {
        depth: a.depth, inputTokens, sent: answer.outputRoom?.sent ?? null, ceiling: answer.outputRoom?.ceiling ?? null, stopReason: answer.stopReason,
      });
      return { refused: { ok: false, reason: 'the summary was cut off by the output limit before it finished', tooBig: true } };
    }
  }
  if (!answer.content || answer.content.trim().length === 0) return { refused: { ok: false, reason: 'summarizer returned empty text' } };
  return { text: answer.content };
}

function rewriteNote(tokens: number, allowed: number, inputTokens: number, target: number, dropped: readonly string[]): string {
  const parts: string[] = [];
  if (tokens > allowed) {
    parts.push(`REWRITE: your previous summary of this input was ${tokens} tokens, longer than ${allowed === inputTokens ? `the input itself (${inputTokens} tokens)` : `its target allows (${allowed} tokens)`}. Write it again from the input in about ${target} tokens: keep every fact, drop repetition and filler.`);
  }
  if (dropped.length > 0) {
    parts.push(`REWRITE: your previous summary left out these facts that the summaries being merged record: ${dropped.join(', ')}. Write it again from the input and carry each of them, exactly as written, with what the input says it refers to.`);
  }
  return parts.length > 0 ? `\n\n${parts.join('\n')}` : '';
}

export async function writeWhole(a: WholeArgs): Promise<SummaryResult> {
  // Lengths in the WRITER's tokens (its own density): the room asked and the limits are its tokens.
  const tok = (t: string): number => textTokens(t, a.charsPerToken);
  const inputTokens = tok(a.content);
  const merge = a.depth > 0;
  const slack = Math.ceil(a.targetTokens * TARGET_SLACK);
  const allowed = merge ? Math.min(inputTokens - 1, slack) : Math.min(inputTokens, slack);
  const keepable = (text: string): boolean => tok(text) <= (merge ? allowed : inputTokens);
  const dropped = (t: string): string[] => (merge ? factsDropped(a.content, t, a.targetTokens, a.charsPerToken) : []);
  const first = await finished(a, '', inputTokens);
  if ('refused' in first) return first.refused;
  const firstTokens = tok(first.text);
  const firstDropped = dropped(first.text);
  if (firstTokens <= allowed && firstDropped.length === 0) return { ok: true, text: first.text, tokenCount: estimateTokens(first.text) };
  // A MERGE that came out too long is `tooBig` like a cut one: its notes are marked refused (`merge-notes.ts`), so
  // none is offered to that writer again. A leaf longer than its input stays a plain refusal.
  const tooLong = (): SummaryResult => ({ ok: false, reason: merge ? 'the summary came out longer than it may be kept' : 'the summary came out longer than its input', ...(merge ? { tooBig: true as const } : {}) });
  const keepFirst = (why: string): SummaryResult => {
    if (keepable(first.text)) return { ok: true, text: first.text, tokenCount: estimateTokens(first.text) };
    a.warn('SUMMARY_REFUSED the summary came out longer than it may be kept, and no rewrite could be had; the span is left whole', { depth: a.depth, inputTokens, firstTokens, why });
    return tooLong();
  };
  if (merge && firstDropped.length === 0) return keepFirst('a merge that is only too long is not rewritten');

  const note = rewriteNote(firstTokens, allowed, inputTokens, a.targetTokens, firstDropped);
  if (!a.fits(note)) return keepFirst('the rewrite note does not fit the writer\'s window');
  let second: Done;
  try {
    second = await finished(a, note, inputTokens);
  } catch (err) {
    if (a.abortSignal?.aborted) throw err;
    return keepFirst(`the rewrite failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (a.abortSignal?.aborted && 'refused' in second) return second.refused;
  const secondText = 'text' in second && keepable(second.text) ? second.text : null;
  const firstText = keepable(first.text) ? first.text : null;
  const pick = secondText !== null && (firstText === null || dropped(secondText).length <= dropped(firstText).length) ? secondText : firstText;
  if (pick === null) {
    a.warn('SUMMARY_REFUSED the summary came out longer than it may be kept twice; the span is left whole', { depth: a.depth, inputTokens, firstTokens, allowed });
    return 'refused' in second && !second.refused.ok && second.refused.tooBig ? second.refused : tooLong();
  }
  const stillDropped = dropped(pick).length;
  if (stillDropped > 0) a.warn('Condensed summary kept with facts its notes record still left out', { depth: a.depth, stillDropped, firstDropped: firstDropped.length });
  return { ok: true, text: pick, tokenCount: estimateTokens(pick) };   // stored in the rows' dialect (`budget.ts`)
}
