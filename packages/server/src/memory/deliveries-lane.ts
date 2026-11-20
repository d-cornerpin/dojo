// THE DELIVERIES LANE: the recipient's next turn sees the question it was asked, read from the `deliveries` rows.
//
// A send to someone who is NOT this turn's counterparty sits in the SENDING conversation's rows; this lane quotes
// it beside the recipient's own conversation, read from the delivery ledger.
//
// It sits at `MessageSlot.Deliveries` (1860): scoped to the served conversation it is volatile by content, so it is
// a POST-BUDGET lane (fitting it inside `assembleContext`'s cacheable region would churn the prefix every turn).
// Its reserve is DERIVED FROM THE GENERATOR (the worst case under its own caps); `deliveries-lane.test.ts` pins
// the POST_BUDGET_LANES literal to it.

import { recentDeliveriesToConversation, findRecentDeliveriesKeyed, type OutboundDelivery } from '../agent/v2/outbound-ledger.js';
import { recordedInstant } from './message-stamp.js';
import { MessageSlot } from '../prompt/registry/types.js';
import {
  LANE_TRUNCATION_MARKER, laneLimit, renderTokens,
  type Lane, type LaneRender,
} from './lanes.js';

export const DELIVERIES_LANE_ID = 'lane.deliveries';

export interface DeliveriesLaneContext {
  agentId: string;
  conversationId: string | null;
  counterpartyName: string;
  /** The counterparty's address and name: when the served conversation has no delivery, the newest delivery to them. */
  recipientHints: string[];
  /** Is this text ALREADY in the assembled array? Then it is not quoted twice. It matches nothing on a fresh
   *  body but stays for old echo rows still in older histories. */
  alreadyVisible: (probe: string) => boolean;
}

export interface DeliveriesLanePayload {
  /** The rows behind this render, newest first (what `truncate` shrinks); `at` is the RECORDED INSTANT, not an age. */
  rows: Array<{ at: string; text: string }>;
  counterpartyName: string;
  cut: boolean;
}

// Each frame's one substitution is the RECORDED INSTANT, so the lane does not move on the clock.
const ONE_HEAD = (name: string, at: string) => `[Your most recent message to ${name}, sent ${at}: "`;
const ONE_TAIL = '"]';
const MANY_HEAD = (name: string) => `[Your recent messages to ${name}, most recent first (engine record, read from the delivery rows — these are messages YOU sent that are not in the conversation above):`;
const MANY_ROW = (at: string, text: string) => `\n- sent ${at}: "${text}"`;
const MANY_TAIL = '\n]';

function renderRows(rows: Array<{ at: string; text: string }>, name: string, cut: boolean): string | null {
  if (rows.length === 0) return null;
  // The single-row frame is used whenever ONE row survives, truncation included (pinned by the test).
  if (rows.length === 1) {
    return `${ONE_HEAD(name, rows[0].at)}${rows[0].text}${ONE_TAIL}${cut ? LANE_TRUNCATION_MARKER : ''}`;
  }
  const body = rows.map((r) => MANY_ROW(r.at, r.text)).join('');
  return `${MANY_HEAD(name)}${body}${cut ? LANE_TRUNCATION_MARKER : ''}${MANY_TAIL}`;
}

function toLaneRender(
  rows: Array<{ at: string; text: string }>,
  counterpartyName: string,
  cut: boolean,
): LaneRender<DeliveriesLanePayload> | null {
  const content = renderRows(rows, counterpartyName, cut);
  if (content === null) return null;
  const messages = [{ role: 'user' as const, content }];
  return { messages, tokens: renderTokens(messages), payload: { rows, counterpartyName, cut } };
}

const rowCap = () => laneLimit(DELIVERIES_LANE_ID, 'rows', 'deliveries');
const quotedChars = () => laneLimit(DELIVERIES_LANE_ID, 'chars', 'quoted');
const probeChars = () => laneLimit(DELIVERIES_LANE_ID, 'chars', 'echoProbe');
const quotedFloor = () => laneLimit(DELIVERIES_LANE_ID, 'chars', 'quotedFloor');
const windowHours = () => laneLimit(DELIVERIES_LANE_ID, 'retrieval', 'windowHours');

export function readDeliveriesLaneRows(ctx: DeliveriesLaneContext): OutboundDelivery[] {
  let rows: OutboundDelivery[] = ctx.conversationId
    ? recentDeliveriesToConversation(ctx.agentId, ctx.conversationId, windowHours(), rowCap())
    : [];
  if (rows.length === 0) {
    for (const h of ctx.recipientHints) {
      const newest = findRecentDeliveriesKeyed(ctx.agentId, h, windowHours())[0];
      if (newest) { rows = [newest]; break; }
    }
  }
  return rows;
}

export function renderDeliveriesLane(ctx: DeliveriesLaneContext): LaneRender<DeliveriesLanePayload> | null {
  const quoted = quotedChars();
  const probe = probeChars();
  const rows: Array<{ at: string; text: string }> = [];
  for (const d of readDeliveriesLaneRows(ctx)) {
    const text = (d.sentText ?? '').trim();
    if (!text) continue;
    if (ctx.alreadyVisible(text.slice(0, probe))) continue;
    rows.push({ at: recordedInstant(d.createdAt), text: text.slice(0, quoted) });
  }
  return toLaneRender(rows, ctx.counterpartyName, false);
}

/** Shrink to fit, OLDEST FIRST: the newest question is the one a bare answer binds to. */
export const truncateDeliveriesLane: Lane<DeliveriesLaneContext, DeliveriesLanePayload>['truncate'] = (
  render,
  maxTokens,
) => {
  const payload = render.payload;
  if (!payload || payload.rows.length === 0 || render.tokens <= maxTokens) return render;
  let rows = [...payload.rows];
  let cut = payload.cut;
  while (rows.length > 1) {
    rows = rows.slice(0, rows.length - 1);
    cut = true;
    const shrunk = toLaneRender(rows, payload.counterpartyName, cut);
    if (shrunk && shrunk.tokens <= maxTokens) return shrunk;
  }
  // One row left and still over: shorten the QUOTE, never to nothing and never below the declared floor. In
  // production this cannot fire: the reserve is the worst case (`deliveriesLaneWorstCaseTokens`).
  const only = rows[0];
  const frame = (renderRows([{ at: only.at, text: '' }], payload.counterpartyName, true) ?? '').length;
  const room = Math.max(quotedFloor(), maxTokens * 4 - frame);
  const shortened = toLaneRender(
    [{ at: only.at, text: only.text.slice(0, room) }],
    payload.counterpartyName,
    true,
  );
  return shortened ?? render;
};

export function deliveriesLaneWorstCaseTokens(): number {
  const rows = Array.from({ length: rowCap() }, () => ({
    // The widest stamp `recordedInstant` can return (fixed width apart from the month name) and a quote at the cap.
    at: recordedInstant('2026-09-30T23:41:59Z'),
    text: 'x'.repeat(quotedChars()),
  }));
  // `cut: true` keeps the truncation marker inside the worst case.
  return toLaneRender(rows, 'x'.repeat(64), true)?.tokens ?? 0;
}

export const DELIVERIES_LANE: Lane<DeliveriesLaneContext, DeliveriesLanePayload> = {
  id: DELIVERIES_LANE_ID,
  slot: MessageSlot.Deliveries,
  // Post-budget sentinel: reserved off the top, not ranked by the fit (as assembler.ts's POST_BUDGET_LANES).
  priority: Number.MAX_SAFE_INTEGER,
  minTokens: 0,
  maxTokens: deliveriesLaneWorstCaseTokens(),
  render: renderDeliveriesLane,
  truncate: truncateDeliveriesLane,
};

export function renderDeliveriesLaneMessage(ctx: DeliveriesLaneContext): string | null {
  const render = DELIVERIES_LANE.render(ctx) as LaneRender<DeliveriesLanePayload> | null;
  if (!render) return null;
  const fitted = render.tokens > DELIVERIES_LANE.maxTokens
    ? DELIVERIES_LANE.truncate(render, DELIVERIES_LANE.maxTokens)
    : render;
  const first = fitted.messages[0];
  return typeof first?.content === 'string' ? first.content : null;
}
