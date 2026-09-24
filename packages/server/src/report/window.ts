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
