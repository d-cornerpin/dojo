// ════════════════════════════════════════════════════════════════════════════════════════
// t210 — THE SUMMARIES LANE: render, selection and room-driven truncation, in one place.
//
// THE DEFECT THIS MODULE CLOSES (live on the dev box: 2,031 of 4,475 receipted summaries lanes
// since 2026-10-01 were cut, every one at the 6,000-token ceiling). The selector counted each
// summary's STORED `tokenCount`; the lane renders more (a header, and an XML wrapper per
// summary), so a set packed to the ceiling always rendered over it; the recency floor forced
// the two newest in even when they alone were over it; and the fit cut the block from the END.
// The block is chronological, so the cut always landed in the NEWEST summary — the one that
// bridges to the live conversation. One agent with 62 small summaries lost its newest 31 whole.
//
// THE RULE NOW, measured in the bytes the model receives:
//   - the NEWEST summary is always in, whole;
//   - then older ones, newest-first, while the RENDERED block fits; the first that does not
//     fit ends the run, so what yields is always the OLDEST and the shown history has no gaps;
//   - what is left out is SAID (one line with the count and where to find them), never hidden;
//   - the fit's truncate re-selects under the grant the ROOM gave, so a small window drops older
//     summaries whole. Only a newest summary that alone exceeds the room is cut as text, with
//     the shared truncation marker; nothing smaller is left.
// The 6,000-token figure (`LANE_LIMITS['lane.summaries'].tokens.relevanceBudget`) still decides
// how many OLDER summaries ride along. It never cuts the newest: the lane's own bound is the
// room (its share of the content budget), which is the no-hard-limits law.
//
// CACHE: a pure function of (the summary set, the budget). Two assemblies with no summary
// written between them render the same bytes, so message 0 still moves only at folds.
// ════════════════════════════════════════════════════════════════════════════════════════

import type { Summary } from './dag.js';
import { summaryConversationLabel, LabelFacts } from './summary-subject.js';
import { renderInstant } from './message-stamp.js';
import { CHARS_PER_TOKEN } from './budget.js';
import { renderTokens, truncateTextLane, type LaneRender } from './lanes.js';

const HEAD = '═══ COMPRESSED HISTORY (summaries of earlier messages, not live conversation) ═══\nThe following are compressed summaries of older conversation history. These capture key facts and decisions but are NOT live messages. Do not respond to them directly, they are context only. Any "couldn\'t do X" / "not supported" noted here may be outdated (the platform gains tools over time); check your current tool list before repeating it. Obligation lines here are HISTORICAL — the OPEN COMMITMENTS snapshot below is the complete current record of what is owed, whatever tense a summary uses.';
const FOOT = '═══ END COMPRESSED HISTORY ═══';
const JOIN = '\n\n';

/** What the lane carries beside its text: every rendered piece, and the ones it showed. */
export interface SummariesPayload {
  pieces: Array<{ summary: Summary; xml: string }>;
  chosen: Summary[];
}

// t141 — ONE CLOCK: `earliest`/`latest` were bare UTC beside a local-time tail. Cached region:
// moves ONCE per agent (argued in the t141 report), never again — stored columns only.
// t144 — and the ONE conversation the note is about (labelled, never filtered: OR-LABEL-NOT-HIDE).
export function formatSummaryXml(summary: Summary, facts: LabelFacts): string {
  const earliest = renderInstant(summary.earliestAt) ?? summary.earliestAt;
  const latest = renderInstant(summary.latestAt) ?? summary.latestAt;
  return `<summary id="${summary.id}" depth="${summary.depth}" kind="${summary.kind}" tokens="${summary.tokenCount}" conversation="${summaryConversationLabel(summary, facts)}" earliest="${earliest}" latest="${latest}">
${summary.content}
</summary>`;
}

/** The line that says older summaries were left out. Empty when none were. */
function omittedLine(n: number): string {
  return n > 0 ? `(${n} older ${n === 1 ? 'summary is' : 'summaries are'} not shown here, to fit; history_search reaches them.)${JOIN}` : '';
}

function blockText(xmls: string[], omitted: number): string {
  return `${HEAD}${JOIN}${omittedLine(omitted)}${xmls.join(JOIN)}${JOIN}${FOOT}`;
}

/**
 * Newest always; then older pieces newest-first while the RENDERED block fits `budgetTokens`;
 * the first that does not fit ends the run. Returned chronologically, with the count left out.
 * Exact, not estimated: the lane's cost is `ceil(chars / CHARS_PER_TOKEN)`, so a block of at
 * most `budget x CHARS_PER_TOKEN` chars costs at most `budget`.
 */
export function selectSummaries<T extends { xml: string }>(pieces: T[], budgetTokens: number): { chosen: T[]; omitted: number } {
  const n = pieces.length;
  if (n === 0) return { chosen: [], omitted: 0 };
  const limit = Math.max(0, Math.floor(budgetTokens)) * CHARS_PER_TOKEN;
  const all = blockText(pieces.map((p) => p.xml), 0).length;
  if (all <= limit) return { chosen: pieces, omitted: 0 };
  // Something will be left out, so the omission line is paid for up front at its widest.
  let used = blockText([pieces[n - 1].xml], 0).length + omittedLine(n).length;
  let first = n - 1;
  for (let i = n - 2; i >= 0; i--) {
    const cost = pieces[i].xml.length + JOIN.length;
    if (used + cost > limit) break;
    used += cost;
    first = i;
  }
  return { chosen: pieces.slice(first), omitted: first };
}

function renderChosen(pieces: SummariesPayload['pieces'], budgetTokens: number): LaneRender<SummariesPayload> {
  const { chosen, omitted } = selectSummaries(pieces, budgetTokens);
  const messages = [{ role: 'user' as const, content: blockText(chosen.map((p) => p.xml), omitted) }];
  return { messages, tokens: renderTokens(messages), payload: { pieces, chosen: chosen.map((p) => p.summary) } };
}

/** The lane's render: every context summary rendered once, the set chosen under `ceilingTokens`. */
export function renderSummariesLane(summaries: Summary[], agentId: string, ceilingTokens: number): LaneRender<SummariesPayload> | null {
  if (summaries.length === 0) return null;
  const facts = new LabelFacts(agentId);
  return renderChosen(summaries.map((summary) => ({ summary, xml: formatSummaryXml(summary, facts) })), ceilingTokens);
}

/** The fit's truncate: the ROOM decides. Re-select under the grant; the text cut is the last resort. */
export function truncateSummariesLane(render: LaneRender<SummariesPayload>, grant: number): LaneRender<SummariesPayload> {
  if (!render.payload) return truncateTextLane(render, grant);
  const shrunk = renderChosen(render.payload.pieces, grant);
  return shrunk.tokens <= grant ? shrunk : truncateTextLane(shrunk, grant);
}
