// ════════════════════════════════════════════════════════════════════════════════════════
// t269 — A SUMMARY IS KEPT ONLY WHOLE: finished, no longer than its input, carrying its notes' facts.
//
// THE DEFECTS (v35-summary-quality-investigation.md):
//   H3.1  the provider's stop reason was never read. 32 DeepSeek summary calls ended at the 16,384-token
//         cap; 12 of the 14 stored ones end mid-text, without their closing RESOLVED / DECIDED section,
//         and were kept as if whole — and the condensed ones became inputs to later condensations.
//   H3.2  an over-long answer was re-summarised ("cut ruthlessly", a summary of the summary, not of the
//         source), and if still long its MIDDLE was cut out (`truncateDeterministic`; 10 stored notes
//         carry its marker). Both are deleted; nothing here edits what the writer wrote.
//   H3.3  445 leaves came out longer than their input.
//   H5    a condensed note keeps 65% of its children's ids and amounts at depths 4–8.
//
// THE RULES NOW:
//   · CUT (`length` on the OpenAI-compatible and Ollama transports, `max_tokens` on Anthropic's): the
//     call is made once more with the room a keepable summary can need — its input's size, since a
//     summary is never longer than its input — up to the most this call could be given (`outputRoom`,
//     reported by the OpenAI-compatible and Ollama transports; Anthropic's reports none, so its cut is
//     refused at once). Cut again, or no more room to give: NOT kept. The refusal is `tooBig`, so every
//     caller splits the span (or offers it to a writer that holds it) and the rows stay whole.
//   · TOO LONG (over the target's slack, or over the input): written once more FROM THE SOURCE, told how
//     long it was. A MERGE still too long is `tooBig` (proof-fix G): the batch is halved and the refusal recorded. A summary longer than its input is never kept; a MERGE is kept only within its slack
//     (`mergeTargetTokens`: strictly smaller than its children, so notes cannot grow level over level).
//   · A MERGE THAT DROPPED FACTS IT HAD ROOM FOR (`carriedFacts`: newest first, within its ask): written
//     once more, told which. The one with fewer dropped facts is kept.
//   · THE REWRITE IS SIZED FIRST (fix round 1, I2): it is sent only if the writer's window holds it with
//     its note, and if it throws or is cut, the first answer is kept when it passed its own checks.
// Worst case: 4 writer calls per `writeWhole` (the first and its cut retry, the rewrite and its cut retry), each
// over the source. PER SPAN: × 2 for the accuracy check's one rewrite (`writeThenCheck`), × the writers walked —
// a pair is handed to each writer left for it once, a refusal recorded (`writer.ts`), so at most
// 8 × (candidate writers) calls for one span, once per content and writer setting.
//
// Cache: summariser calls only; nothing here is in a prompt prefix.
// ════════════════════════════════════════════════════════════════════════════════════════

import { estimateTokens } from './budget.js';
import { factsDropped, TARGET_SLACK, textTokens } from './summary-target.js';
import type { SummaryResult } from './summarize.js';

/** What one writer call returned, in the transport's own terms (`ModelCallResult`'s fields). */
export interface WriterAnswer { content: string; stopReason: string | null; outputRoom?: { sent: number; ceiling: number } }
/** One writer call over the source: `extra` is appended to the system prompt, `outputRoomAsk` asks for more room. */
export type WriterCall = (extra: string, outputRoomAsk?: number) => Promise<WriterAnswer>;

/** The providers' own words for "stopped at the output limit": OpenAI-compatible and Ollama say `length`,
 *  Anthropic says `max_tokens` (each passes its reason through `resolveProviderStopReason` unchanged). */
const CUT_STOP_REASONS: ReadonlySet<string> = new Set(['length', 'max_tokens']);
export const wasCut = (a: WriterAnswer): boolean => CUT_STOP_REASONS.has(a.stopReason ?? '');

type Done = { text: string } | { refused: SummaryResult };

export interface WholeArgs {
  call: WriterCall; content: string; depth: number; targetTokens: number; abortSignal?: AbortSignal;
  warn: (message: string, meta: Record<string, unknown>) => void;
  /** The writer's characters per token (`modelCharsPerToken`); absent, the stored-row dialect. */
  charsPerToken?: number;
  /** Does the writer's window hold this input with `extra` appended to the system prompt? */
  fits: (extra: string) => boolean;
}

/** One summary written over the source, finished: a cut answer is asked again with room, and refused if cut again. */
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

/** The rewrite instruction for what the first answer got wrong (the writer's own prompt; listed in the t269 report). */
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

/** Write a summary that may be kept (header). */
export async function writeWhole(a: WholeArgs): Promise<SummaryResult> {
  // Lengths in the WRITER's tokens (t268's per-model density): the room asked and the limits are its tokens.
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
  // A MERGE that came out too long is `tooBig` like a cut one: its limit is 0.8 of ONE child, so a batch of n notes must
  // shrink to 0.8/n of its input, and a smaller group asks less of the writer. Every caller then halves the batch and
  // records the refusal (`writer.ts`), so a pass reclaims what a pair can give and the same group is not
  // dialled again. A leaf's verdict (longer than its input) stays a plain refusal.
  const tooLong = (): SummaryResult => ({ ok: false, reason: merge ? 'the summary came out longer than it may be kept' : 'the summary came out longer than its input', ...(merge ? { tooBig: true as const } : {}) });
  const keepFirst = (why: string): SummaryResult => {
    if (keepable(first.text)) return { ok: true, text: first.text, tokenCount: estimateTokens(first.text) };
    a.warn('SUMMARY_REFUSED the summary came out longer than it may be kept, and no rewrite could be had; the span is left whole', { depth: a.depth, inputTokens, firstTokens, why });
    return tooLong();
  };

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
