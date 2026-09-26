// ════════════════════════════════════════════════════════════════════════════
// THE GATHER WINDOW — THE AGENT NAMES IT, THE TOOL BOUNDS IT (DOJO-REPORT T3)
//
// Two hours and twenty turns is the measured shape of "the thing that just went
// wrong": long enough to cover a multi-turn failure the user noticed after the
// fact, short enough that the bundle stays reviewable by a human and each
// collector stays ONE indexed query. An agent asking for "since last Tuesday"
// gets two hours — and is TOLD so, in the tool result, in plain words.
//
//  1. THE CAP IS NOT A SUGGESTION AND NOT A SILENT TRIM. `truncated` is carried
//     out of here, into `window.truncated` in the attachment and into a sentence
//     the agent reads. A bound that quietly shortens what it was asked for
//     teaches the asker its request was honoured; this one says what it did.
//
//  2. `askedFor` IS THE ASK, NOT THE ANSWER. It records what the agent said so
//     the truncation sentence can quote it back. It is prose FOR THE AGENT and
//     never enters the telemetry attachment — the whitelist has no field for it,
//     which is the structural half of that promise (T1, `emit`).
//
//  3. A NON-POSITIVE OR NON-FINITE ASK IS NOT AN ASK. `-3 turns` and `NaN
//     minutes` fall back to the standing window rather than producing a window
//     that ends before it starts. They are also NOT `truncated`: nothing was
//     shortened, the ask was never a window in the first place. Distinguishing
//     those two is why the `asked*` locals are computed once and read twice.
//
//  4. THE PER-COLLECTOR CAPS LIVE HERE, BESIDE THE WINDOW, because they bound
//     the same thing from the other end: the window bounds HOW FAR BACK, these
//     bound HOW MANY, and one runaway table must not make a bundle useless.
//
//  5. A ROW CAP IS NOT A SIZE BOUND, and ritual v3.2.0 round 1 is the proof: the
//     `logs` section grew 9,333 → 35,994 characters inside the SAME twenty-turn
//     window (20 → 66 entries), the gather result crossed the tool's 12,000-token
//     cap, and the engine — which truncates from the END — destroyed the hand-off
//     instruction that drives the rest of the feature. Rows say HOW MANY;
//     `BUNDLE_SECTION_CHARS` says HOW BIG, which is the unit the token cap is in.
//
// `REPORT_BUNDLE_MAX_BYTES` is deliberately NOT here — it is the byte cap on
// what reaches disk and it belongs with the writer that enforces it
// (`bundle.ts`, T2). One constant, one owner.
// ════════════════════════════════════════════════════════════════════════════

/** At most twenty turns of history, however many the agent asks for. */
export const REPORT_WINDOW_MAX_TURNS = 20;
/** At most two hours back, however far the agent asks. */
export const REPORT_WINDOW_MAX_MINUTES = 120;

/**
 * Per-collector row caps. Each is the `LIMIT` of exactly one prepared statement in
 * `gather.ts`; a table that ran away inside the window is truncated to its own cap
 * rather than being allowed to crowd out every other collector's evidence.
 */
export const COLLECTOR_CAPS = {
  turns: 20, calls: 60, toolCalls: 200, work: 25, toolFailures: 25,
} as const;

/**
 * PER-SECTION SIZE BUDGETS FOR THE BUNDLE THE AGENT READS, IN RENDERED CHARACTERS.
 * Same discipline as `COLLECTOR_CAPS`, one unit over: rows above, characters here,
 * because the thing that broke is a TOKEN cap and a row is not a number of tokens.
 *
 * ── THE ARITHMETIC, AND IT IS THE WHOLE POINT OF THE NUMBERS ──
 * `dojo_report` declares `maxResultTokens: 12000` (`agent/tools/definitions.ts`), i.e. a
 * 48,000-character budget, and the engine truncates from the END. A MAXIMAL gather result
 * must therefore fit with room to spare, and it does:
 *
 *     sections   6,000 + 5,600 + 5,000 + 4,000 + 3,500 + 1,000 + 1,000  =  26,100 chars
 *     `window` object + the outer braces and key names                  ≈     400 chars
 *     the `bounds` notes, worst case (one per section, ~120 chars each)  ≈   1,000 chars
 *     the head — id, the not-yet-filed truth, the draft instruction      ≈   1,800 chars
 *     ------------------------------------------------------------------------------
 *     worst case                                    ≈ 29,300 chars ≈ 7,325 tokens
 *
 * That is 61% of the 12,000-token cap and inside the 9,000-token target this fix was given,
 * so the engine's truncation is never reached by the shape of the evidence alone. Measured
 * rather than left as arithmetic: a body seeded past EVERY row cap with deliberately fat rows
 * (282,660 characters of raw material, 5.9× the engine's whole char budget) renders a result
 * of 27,495 characters — 6,874 tokens — and `the-handoff-cannot-be-truncated-away.test.ts`
 * fails if that ever crosses the target.
 *
 * The budgets are in RENDERED characters — what the item costs inside
 * `JSON.stringify(bundle, null, 2)`, measured by `renderedCost` below, not the compact form —
 * because the pretty printer inflates a row by 1.24×–2.11× (measured over the seven real row
 * shapes) and a bound that ignores that is a bound that does not hold. `logs` gets the largest
 * share because it is the section that ran away, and it is still ~14 real entries deep;
 * `turns` gets enough for all twenty of them, because twenty turns is the window this tool
 * tells the agent it is looking at and the spine of any story it can write.
 */
export const BUNDLE_SECTION_CHARS = {
  logs: 6_000, turns: 5_600, auditLog: 5_000, toolCalls: 4_000, calls: 3_500,
  work: 1_000, toolFailures: 1_000,
} as const;

/** The ceiling the arithmetic above is derived against — the ritual's target, not the cap. */
export const REPORT_RESULT_TARGET_TOKENS = 9_000;

/**
 * WHAT ONE ITEM COSTS IN THE RENDERED BUNDLE. Its own pretty form, plus the four spaces
 * every one of its lines gains at depth two (`{ logs: [ <item> ] }`), plus its comma and
 * newline. Exact rather than a fudge factor: a single item with hundreds of short fields
 * inflates by lines, not by bytes, and a ratio-based estimate is wrong exactly there.
 */
function renderedCost(item: unknown): number {
  const s = JSON.stringify(item, null, 2) ?? 'null';
  return s.length + 4 * s.split('\n').length + 2;
}

/** One section after bounding: what survived, and the note that says what did not. */
export interface BoundedSections {
  sections: Record<string, unknown[]>;
  /** One honest line per section that dropped anything. Empty when nothing was dropped. */
  notes: string[];
}

/**
 * NEWEST-FIRST, BUDGET-BOUNDED, AND THE DROP IS SAID OUT LOUD.
 *
 * Every section arrives newest-first (each reader's `ORDER BY … DESC`, and `gather.ts`
 * reverses the one list that does not), so what survives is a PREFIX and "showing newest
 * K of N" is literally true. A section stops at the first item that does not fit rather
 * than skipping it and taking a smaller one behind it — a hole in the middle of a
 * newest-first list would make the note a lie, and an honest note is the whole reason a
 * bound is allowed to drop evidence at all.
 *
 * A section with no budget of its own is NOT silently unbounded: it would be a new
 * collector nobody sized, so it is passed through and `gather.ts`'s own test census is
 * what refuses one. (There is no such section today.)
 */
export function boundBundleSections(raw: Record<string, readonly unknown[]>): BoundedSections {
  const sections: Record<string, unknown[]> = {};
  const notes: string[] = [];
  for (const [name, items] of Object.entries(raw)) {
    const budget = (BUNDLE_SECTION_CHARS as Record<string, number | undefined>)[name];
    if (budget === undefined) { sections[name] = [...items]; continue; }
    const kept: unknown[] = [];
    let used = 0;
    for (const item of items) {
      const cost = renderedCost(item);
      if (used + cost > budget) break;
      kept.push(item);
      used += cost;
    }
    sections[name] = kept;
    if (kept.length < items.length) {
      notes.push(`${name}: showing newest ${kept.length} of ${items.length} in this window — `
        + 'older entries were dropped to keep this evidence under its size budget.');
    }
  }
  return { sections, notes };
}

/** What the agent asked for. Both absent means "the standing window", which is the cap. */
export interface WindowRequest { turns?: number | null; minutes?: number | null }

export interface GatherWindow {
  /** The turn cap actually applied. */
  turns: number;
  /** The minute span actually applied. */
  minutes: number;
  /** The start of the effective window, ISO. `minutes` before `now`. */
  sinceIso: string;
  /** True when a cap BIT — i.e. the agent asked for more than it got. */
  truncated: boolean;
  /** The ask, in the agent's own terms, for the sentence that reports the trim. */
  askedFor: string;
}

/**
 * THE EFFECTIVE WINDOW IS THE TIGHTER OF THE ASK AND THE CAP.
 *
 * `now` is injectable because a window is the one thing in this feature that is a
 * function of the clock, and a test that cannot pin the clock can only assert the
 * bound approximately — which is how a cap gets a tolerance and then loses it.
 */
export function resolveWindow(req: WindowRequest, now: Date = new Date()): GatherWindow {
  const askedTurns = typeof req.turns === 'number' && Number.isFinite(req.turns) && req.turns > 0
    ? Math.floor(req.turns) : null;
  const askedMinutes = typeof req.minutes === 'number' && Number.isFinite(req.minutes) && req.minutes > 0
    ? Math.floor(req.minutes) : null;
  const turns = Math.min(askedTurns ?? REPORT_WINDOW_MAX_TURNS, REPORT_WINDOW_MAX_TURNS);
  const minutes = Math.min(askedMinutes ?? REPORT_WINDOW_MAX_MINUTES, REPORT_WINDOW_MAX_MINUTES);
  const truncated =
    (askedTurns !== null && askedTurns > REPORT_WINDOW_MAX_TURNS) ||
    (askedMinutes !== null && askedMinutes > REPORT_WINDOW_MAX_MINUTES);
  return {
    turns, minutes,
    sinceIso: new Date(now.getTime() - minutes * 60_000).toISOString(),
    truncated,
    askedFor: `${askedTurns ?? 'default'} turns / ${askedMinutes ?? 'default'} minutes`,
  };
}
