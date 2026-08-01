// ════════════════════════════════════════════════════════════════════════════════════════
// THE DELIVERIES LANE. PHASE-3 T7 Step 1 (research 18 §open-1, the inherited echo-strip
// rider). The recipient's next turn sees the question it was asked — read from the
// `deliveries` rows themselves, not from a duplicated message row.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// ── WHAT IT REPLACES ────────────────────────────────────────────────────────────────────
// When the agent sends to someone who is NOT this turn's counterparty (asking the owner for
// a datum while replying to a contact), the sent text lives only in the SENDING
// conversation's tool rows and `scopeToHumanConversation` filters it out of the recipient's
// conversation. The recipient then answers a question the model cannot see it asked (the
// "easily confused" bug, F-1/F-3/K-1).
//
// RC-1 solved that by DUPLICATING THE ROW: `persistCrossConvSendEcho` (`agent/v2/loop.ts`)
// writes an extra `assistant` message — `[Sent via X to Y]: <verbatim text>` — into the
// RECIPIENT's conversation, `origin_intent='cross_conv_send_echo'`. The scar-tissue ledger
// deferred stripping it "until the assembler reads deliveries rows natively", which is this
// lane. The duplicated rows are NOT stripped here: they die in T7 Step 2, after the
// detector's 7-day quiet window.
//
// The other half it replaces is RC-1's pending-question HEADER (`engine.pending-question`,
// registry-exempt since 2026-07-16): one message, LIMIT 1, quoted at 300 chars, suppressed
// whenever the echo row was still in the tail. It was the lane in embryo — a read of
// `deliveries` with no declaration, no budget, no truncate and no receipt entry. The echo
// row was its primary and it was the fallback; this inverts that, which is what makes the
// strip possible.
//
// ── WHERE IT SITS, AND WHY THAT IS FORCED ───────────────────────────────────────────────
// It carries RELATIVE TIMES ("sent 5 minutes ago") and it is scoped to the conversation
// being served this turn, so it is volatile by shape and by content. The cache-prefix law
// (roadmap #10, OR7) puts volatile content past `MessageSlot.TurnContext`, and the kit's
// assembled-context gate enforces exactly that: a "relative time" shape ahead of the
// volatile boundary is a violation, and every message from the boundary on must declare a
// slot >= 1850. `MessageSlot.Deliveries = 1860` sits between turn-context (1850) and
// peer-status (1875) — the physical position the header already occupied — so the preserved
// near-tail ordering 1850 -> 1875 -> 1900 is untouched and nothing is renumbered.
//
// That is also why this lane is a POST-BUDGET lane rather than a `fitLanes` candidate: the
// two-pass fit runs inside `assembleContext`, whose entire output is the CACHEABLE region
// (everything before `volatileFrom`). A volatile lane fitted there would churn the prefix on
// every turn — the K10 defect T3 just finished killing.
//
// ── THE BUDGET IS REAL, NOT NOMINAL ─────────────────────────────────────────────────────
// The other seven post-budget lanes reserve a fixed string's cost, so "budget" is a
// measurement of something that cannot vary. This one renders a VARIABLE number of rows of
// VARIABLE length, so it is the first post-budget lane whose declared reserve has to be
// enforced rather than merely recorded — hence a real `truncate()`, and hence
// `DELIVERIES_LANE_RESERVE_TOKENS` is DERIVED FROM THE GENERATOR (the worst case the
// renderer can produce under its own declared caps) instead of guessed beside it.
// `deliveries-lane.test.ts` re-derives it and pins the POST_BUDGET_LANES literal to it, so
// the declaration and the code cannot drift.
// ════════════════════════════════════════════════════════════════════════════════════════

import { recentDeliveriesToConversation, mostRecentDeliveryTo, relativeTimeAgo, type OutboundDelivery } from '../agent/v2/outbound-ledger.js';
import { MessageSlot } from '../prompt/registry/types.js';
import {
  LANE_TRUNCATION_MARKER, laneLimit, renderTokens,
  type Lane, type LaneRender,
} from './lanes.js';

export const DELIVERIES_LANE_ID = 'lane.deliveries';

/** What the lane needs to render. Everything is passed IN: the lane owns the read of the
 *  `deliveries` rows, the loop owns the array facts (which conversation, what is visible). */
export interface DeliveriesLaneContext {
  agentId: string;
  /** The conversation this turn is serving. Null = no identity, nothing to scope to. */
  conversationId: string | null;
  /** Display name of the counterparty, for the message the model reads. */
  counterpartyName: string;
  /** Legacy prong: alias hints for pre-121 history with no `deliveries` row. */
  recipientHints: string[];
  /**
   * Is this text ALREADY in the assembled array? During T7's window the echo rows still
   * exist, and a row whose verbatim text is in the tail must not be quoted a second time.
   * When the echo writer dies (Step 2) this predicate stops matching anything and the lane
   * simply carries the whole job — which is the point of inverting the two.
   */
  alreadyVisible: (probe: string) => boolean;
}

export interface DeliveriesLanePayload {
  /** The rows behind this render, newest first — what `truncate` shrinks. */
  rows: Array<{ ago: string; text: string }>;
  counterpartyName: string;
  /** True when at least one row was dropped or shortened relative to the read. */
  cut: boolean;
}

// ── The fixed frames. Both are the RC-1 wording, preserved. ─────────────────────────────
const ONE_HEAD = (name: string, ago: string) => `[Your most recent message to ${name}, sent ${ago}: "`;
const ONE_TAIL = '"]';
const MANY_HEAD = (name: string) => `[Your recent messages to ${name}, most recent first (engine record, read from the delivery rows — these are messages YOU sent that are not in the conversation above):`;
const MANY_ROW = (ago: string, text: string) => `\n- sent ${ago}: "${text}"`;
const MANY_TAIL = '\n]';

function renderRows(rows: Array<{ ago: string; text: string }>, name: string, cut: boolean): string | null {
  if (rows.length === 0) return null;
  // ONE row renders the RC-1 header byte-for-byte, so the common case the header already
  // served is unchanged in the model's eyes. `deliveries-lane.test.ts` pins that literally.
  // The one-row frame is used whenever ONE row survives, truncation included: carrying the
  // list frame for a single row spends ~110 chars of a budget that just proved to be tight.
  if (rows.length === 1) {
    return `${ONE_HEAD(name, rows[0].ago)}${rows[0].text}${ONE_TAIL}${cut ? LANE_TRUNCATION_MARKER : ''}`;
  }
  const body = rows.map((r) => MANY_ROW(r.ago, r.text)).join('');
  return `${MANY_HEAD(name)}${body}${cut ? LANE_TRUNCATION_MARKER : ''}${MANY_TAIL}`;
}

function toLaneRender(
  rows: Array<{ ago: string; text: string }>,
  counterpartyName: string,
  cut: boolean,
): LaneRender<DeliveriesLanePayload> | null {
  const content = renderRows(rows, counterpartyName, cut);
  if (content === null) return null;
  const messages = [{ role: 'user' as const, content }];
  return { messages, tokens: renderTokens(messages), payload: { rows, counterpartyName, cut } };
}

/** The declared caps, read from the lane table. A number this lane uses and does not
 *  declare is the thing `laneLimit` throws about. */
const rowCap = () => laneLimit(DELIVERIES_LANE_ID, 'rows', 'deliveries');
const quotedChars = () => laneLimit(DELIVERIES_LANE_ID, 'chars', 'quoted');
const probeChars = () => laneLimit(DELIVERIES_LANE_ID, 'chars', 'echoProbe');
const quotedFloor = () => laneLimit(DELIVERIES_LANE_ID, 'chars', 'quotedFloor');
const windowHours = () => laneLimit(DELIVERIES_LANE_ID, 'retrieval', 'windowHours');

/**
 * Read the lane's rows: the deliveries INTO this conversation, newest first, skipping any
 * whose text the assembled array already carries. The legacy alias prong runs only when the
 * ID-keyed read returns nothing, exactly as the header did while pre-121 history ages out.
 */
export function readDeliveriesLaneRows(ctx: DeliveriesLaneContext): OutboundDelivery[] {
  let rows: OutboundDelivery[] = ctx.conversationId
    ? recentDeliveriesToConversation(ctx.agentId, ctx.conversationId, windowHours(), rowCap())
    : [];
  if (rows.length === 0) {
    for (const h of ctx.recipientHints) {
      const legacy = mostRecentDeliveryTo(ctx.agentId, h, windowHours());
      if (legacy) { rows = [legacy]; break; }
    }
  }
  return rows;
}

/** Render the lane. Null when there is nothing to say — never an empty frame. */
export function renderDeliveriesLane(ctx: DeliveriesLaneContext): LaneRender<DeliveriesLanePayload> | null {
  const quoted = quotedChars();
  const probe = probeChars();
  const rows: Array<{ ago: string; text: string }> = [];
  for (const d of readDeliveriesLaneRows(ctx)) {
    const text = (d.sentText ?? '').trim();
    if (!text) continue;
    if (ctx.alreadyVisible(text.slice(0, probe))) continue;
    rows.push({ ago: relativeTimeAgo(d.createdAt), text: text.slice(0, quoted) });
  }
  return toLaneRender(rows, ctx.counterpartyName, false);
}

/**
 * Shrink to fit. OLDEST FIRST: the newest question is the one a bare answer is binding to,
 * so it is the last thing to go — the same reasoning the priority ladder encodes for the
 * directive. Below one whole row the quote itself is shortened; the lane is never dropped
 * to nothing while it has a row, because a lane that can only be taken whole is a lane that
 * gets dropped whole (`lanes.ts`, the truncate contract).
 */
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
  // One row left and still over: shorten the QUOTE, never the row count to zero, and never
  // below the declared floor. A frame wrapped around an empty quote is worse than a render
  // slightly over budget — it tells the model a message exists and then does not show it,
  // which is the "dropped section looks like an absent section" defect this phase deletes.
  // In production this branch cannot fire: the reserve IS the worst case (see
  // `deliveriesLaneWorstCaseTokens`), so `maxTokens` always covers a whole row.
  const only = rows[0];
  const frame = (renderRows([{ ago: only.ago, text: '' }], payload.counterpartyName, true) ?? '').length;
  const room = Math.max(quotedFloor(), maxTokens * 4 - frame);
  const shortened = toLaneRender(
    [{ ago: only.ago, text: only.text.slice(0, room) }],
    payload.counterpartyName,
    true,
  );
  return shortened ?? render;
};

/**
 * THE WORST CASE THE RENDERER CAN PRODUCE under its own declared caps — the derivation
 * behind the declared reserve. Not a guess beside the code: this calls the code.
 */
export function deliveriesLaneWorstCaseTokens(): number {
  const rows = Array.from({ length: rowCap() }, () => ({
    // The longest label `relativeTimeAgo` can return, and a quote at the declared cap.
    ago: '59 minutes ago',
    text: 'x'.repeat(quotedChars()),
  }));
  // `cut: true` so the truncation marker is inside the worst case rather than able to push
  // a truncated render back OVER the reserve that authorised the truncation.
  return toLaneRender(rows, 'x'.repeat(64), true)?.tokens ?? 0;
}

/** The lane, in the shape `lanes.ts` declares for every lane. */
export const DELIVERIES_LANE: Lane<DeliveriesLaneContext, DeliveriesLanePayload> = {
  id: DELIVERIES_LANE_ID,
  slot: MessageSlot.Deliveries,
  // The post-budget sentinel the assembler already records for a lane that is RESERVED off
  // the top rather than ranked by the fit (`assembler.ts`, the POST_BUDGET_LANES grants).
  priority: Number.MAX_SAFE_INTEGER,
  minTokens: 0,
  maxTokens: deliveriesLaneWorstCaseTokens(),
  render: renderDeliveriesLane,
  truncate: truncateDeliveriesLane,
};

/**
 * Render + fit in one call: what the loop injects. Returns the message text or null.
 * The reserve is enforced HERE, so the declared budget is a bound the array actually
 * obeys rather than a number in a table.
 */
export function renderDeliveriesLaneMessage(ctx: DeliveriesLaneContext): string | null {
  const render = DELIVERIES_LANE.render(ctx) as LaneRender<DeliveriesLanePayload> | null;
  if (!render) return null;
  const fitted = render.tokens > DELIVERIES_LANE.maxTokens
    ? DELIVERIES_LANE.truncate(render, DELIVERIES_LANE.maxTokens)
    : render;
  const first = fitted.messages[0];
  return typeof first?.content === 'string' ? first.content : null;
}
