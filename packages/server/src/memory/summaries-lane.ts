// The summaries lane: render, selection and room-driven truncation, measured in the bytes the model receives.
// The newest summary is always in, whole; older ones ride along newest-first while the RENDERED block fits, so only
// the oldest yield and the shown history has no gaps. Left-out summaries are SAID (count line), never hidden.
// A pure function of (summary set, budget): no new summary between assemblies means identical bytes (cache).

import type { Summary } from './dag.js';
import { summaryConversationLabel, LabelFacts } from './summary-subject.js';
import { renderInstant } from './message-stamp.js';
import { CHARS_PER_TOKEN } from './budget.js';
import { renderTokens, truncateTextLane, type LaneRender } from './lanes.js';
import { toolResultView, POINTER_LABEL_ROOM_CHARS } from './tool-result-view.js';
import { keptNoteHandle } from './kept-row-view.js';

const HEAD = '═══ COMPRESSED HISTORY (summaries of earlier messages, not live conversation) ═══\nThe following are compressed summaries of older conversation history. These capture key facts and decisions but are NOT live messages. Do not respond to them directly, they are context only. Any "couldn\'t do X" / "not supported" noted here may be outdated (the platform gains tools over time); check your current tool list before repeating it. Obligation lines here are HISTORICAL — the OPEN COMMITMENTS snapshot below is the complete current record of what is owed, whatever tense a summary uses.';
const FOOT = '═══ END COMPRESSED HISTORY ═══';
const JOIN = '\n\n';

/** What the lane carries beside its text: every rendered piece, and the ones it showed. */
export interface SummariesPayload {
  pieces: Array<{ summary: Summary; xml: string }>;
  chosen: Summary[];
}

// Stored columns only (cached region); the note's conversation is labelled, never filtered.
export function formatSummaryXml(summary: Summary, facts: LabelFacts): string {
  const earliest = renderInstant(summary.earliestAt) ?? summary.earliestAt;
  const latest = renderInstant(summary.latestAt) ?? summary.latestAt;
  return `<summary id="${summary.id}" depth="${summary.depth}" kind="${summary.kind}" tokens="${summary.tokenCount}" conversation="${summaryConversationLabel(summary, facts)}" earliest="${earliest}" latest="${latest}">
${summary.content}
</summary>`;
}

/** The line that says older summaries were left out, and the tool that finds them. Empty when none were. */
function omittedLine(n: number): string {
  return n > 0 ? `(${n} older ${n === 1 ? 'summary is' : 'summaries are'} not shown here, to fit; they are still stored, and history_search finds them if you have it.)${JOIN}` : '';
}

function blockText(xmls: string[], omitted: number): string {
  return `${HEAD}${JOIN}${omittedLine(omitted)}${xmls.join(JOIN)}${JOIN}${FOOT}`;
}

/** Newest always, then older pieces newest-first while the RENDERED block fits `budgetTokens`. Exact: lane cost is
 *  `ceil(chars / CHARS_PER_TOKEN)`, so `budget x CHARS_PER_TOKEN` chars cost at most `budget`. */
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

export function renderSummariesLane(summaries: Summary[], agentId: string, ceilingTokens: number): LaneRender<SummariesPayload> | null {
  if (summaries.length === 0) return null;
  const facts = new LabelFacts(agentId);
  return renderChosen(summaries.map((summary) => ({ summary, xml: formatSummaryXml(summary, facts) })), ceilingTokens);
}

/** The fit's truncate: re-select under the grant, then the newest note as its kept-row pointer, then a text cut. */
export function truncateSummariesLane(render: LaneRender<SummariesPayload>, grant: number): LaneRender<SummariesPayload> {
  if (!render.payload) return truncateTextLane(render, grant);
  const shrunk = renderChosen(render.payload.pieces, grant);
  if (shrunk.tokens <= grant) return shrunk;
  const pointered = newestAsPointer(render.payload, grant);
  return pointered && pointered.tokens <= grant ? pointered : truncateTextLane(shrunk, grant);
}

function newestAsPointer(payload: SummariesPayload, grant: number): LaneRender<SummariesPayload> | null {
  const newest = payload.pieces[payload.pieces.length - 1];
  if (!newest) return null;
  const omitted = payload.pieces.length - 1;
  const frame = blockText([newest.xml.replace(newest.summary.content, '')], omitted).length;
  const viewChars = Math.max(0, grant) * CHARS_PER_TOKEN - frame;
  if (viewChars <= POINTER_LABEL_ROOM_CHARS) return null;
  const xml = newest.xml.replace(newest.summary.content, () => toolResultView(newest.summary.content, keptNoteHandle(newest.summary.id), viewChars));
  const messages = [{ role: 'user' as const, content: blockText([xml], omitted) }];
  return { messages, tokens: renderTokens(messages), payload: { pieces: payload.pieces, chosen: [newest.summary] } };
}

/** The room a newest note has in a lane of `laneRoomTokens`: the room less this block's frame (head, foot, widest
 *  omission line, a note's wrapper for `label`), in tokens. A note this size is shown whole by `selectSummaries`. */
export function newestNoteRoomTokens(laneRoomTokens: number, label: string): number {
  const wrapper = `<summary id="sum_00000000-0000-0000-0000-000000000000" depth="0" kind="leaf" tokens="9999999" conversation="${label}" earliest="${renderInstant(new Date().toISOString()) ?? ''}" latest="${renderInstant(new Date().toISOString()) ?? ''}">\n\n</summary>`;
  const frame = blockText([wrapper], 0).length + omittedLine(9_999_999).length;
  return Math.max(0, Math.floor((laneRoomTokens * CHARS_PER_TOKEN - frame) / CHARS_PER_TOKEN));
}
