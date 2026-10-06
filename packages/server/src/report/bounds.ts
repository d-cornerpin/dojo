// ════════════════════════════════════════════════════════════════════════════
// HOW BIG THE DOCUMENT THE AGENT READS MAY BE (ritual v3.2.0 round-1 fix, F1/F2)
//
// `window.ts` next door answers HOW FAR BACK and HOW MANY ROWS. This file answers
// HOW MANY CHARACTERS, which is the unit a token cap is counted in, and WHAT THE
// READER IS TOLD when something does not fit. It was split out of `window.ts` when
// the round-1 review's F1 and F2 grew it past the size that file may be; the seam
// is the question each answers, not the line count.
//
//  · A BOUND THAT DROPS EVIDENCE MUST SAY SO, AND SAY IT TRUTHFULLY. Every note
//    here names the count, the ORDER its surviving prefix is in, and why the rest
//    is absent. The measured reasons each number and each sentence exists are AT
//    the constant and AT the function, not repeated here.
//
//  · NOTHING HERE READS ANYTHING. No import, no clock, no database: budgets and two
//    pure functions over an already-collected document. That is why the local bundle
//    and `draft`'s echo of the published attachment can share it without either one
//    learning about the other.
// ════════════════════════════════════════════════════════════════════════════

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
 *     the `bounds` notes — one per dropping section, plus `gather.ts`'s
 *     saturated-log-read note; measured at 1,128 chars on a maximal body,
 *     longest single note 260                                            ≈   1,200 chars
 *     the head — id, the not-yet-filed truth, the draft instruction      ≈   1,800 chars
 *     ------------------------------------------------------------------------------
 *     worst case                                    ≈ 29,500 chars ≈ 7,375 tokens
 *
 * That is 61% of the 12,000-token cap and inside the 9,000-token target this fix was given,
 * so the engine's truncation is never reached by the shape of the evidence alone. Measured
 * rather than left as arithmetic: a body seeded past EVERY row cap with deliberately fat rows
 * (282,660 characters of raw material, 5.9× the engine's whole char budget) renders a result
 * of 27,495 characters — 6,874 tokens — and `the-handoff-cannot-be-truncated-away.test.ts`
 * fails if that ever crosses the target. ⚠ TWO THINGS THIS SUM DOES NOT COUNT, both ledgered
 * and both covered by the ~4,600 tokens of slack it leaves: `scrub()` runs AFTER the bound and
 * a redaction marker can be longer than the value it replaces (review F7), and these are UTF-16
 * code units, which is what the engine's own cap counts but not what a tokenizer counts, so a
 * CJK- or emoji-heavy window costs more real tokens than the arithmetic says (F6).
 *
 * The budgets are in RENDERED characters — what the item costs inside
 * `JSON.stringify(bundle, null, 2)`, measured by `renderedCost` below, not the compact form —
 * because the pretty printer inflates a row by 1.09×–2.00× (measured by the round-1 review over
 * the seven real row shapes) and a bound that ignores that is a bound that does not hold. `logs` gets the largest
 * share because it is the section that ran away, and it is still ~14 real entries deep;
 * `turns` gets enough for all twenty of them, because twenty turns is the window this tool
 * tells the agent it is looking at and the spine of any story it can write.
 */
export const BUNDLE_SECTION_CHARS = {
  logs: 6_000, turns: 5_600, auditLog: 5_000, toolCalls: 4_000, calls: 3_500,
  work: 1_000, toolFailures: 1_000,
} as const;

/**
 * THE SAME DISCIPLINE FOR THE `draft` RESULT'S ECHO OF THE ATTACHMENT (round-1 review F2).
 *
 * `draft` re-gathers and renders the machine-built attachment back to the agent so it can see
 * what it did not write. On a maximal window that echo measured 88,098 characters ≈ 22,025
 * tokens — 1.8× over the cap — so the engine severed it and stamped "narrow your query", with
 * nothing in the result saying the notice was harmless. The keys are the ATTACHMENT's
 * (`tools`, not `toolCalls`), and the numbers match their bundle counterparts because the rows
 * are the same facts in another shape:
 *
 *     turns 5,600 + tools 4,000 + calls 3,500 + work 1,000            =  14,100 chars
 *     `report`/`platform`/`window`/`settings` + keys and braces       ≈   1,600 chars
 *     the echo's own drop notes, worst case                          ≈     600 chars
 *     the head — state, the submit instruction, the two warnings      ≈   1,500 chars
 *     ----------------------------------------------------------------------------
 *     ≈ 17,800 chars ≈ 4,450 tokens, leaving ~7,500 tokens of the cap for the BRIEF
 *
 * ⚠ THE BRIEF IS DELIBERATELY NOT BOUNDED. It is the text the user is about to be shown and the
 * agent is being told to re-read it; trimming the thing under review would be the defect this
 * round is fixing, one document over. It is also the agent's own words, just written, so it
 * cannot be a surprise — and head-first ordering means a brief long enough to reach the cap
 * costs the tail of the echo, never the instruction.
 *
 * ⚠ AND THE ECHO IS ONLY A COPY. The attachment stored on the row and published on the issue is
 * never bounded — `buildTelemetry`'s output goes to `attachDraft` whole. The trimming is a
 * reading aid, and the result says so in words rather than leaving the agent to assume.
 */
export const ATTACHMENT_ECHO_CHARS = {
  turns: 5_600, tools: 4_000, calls: 3_500, work: 1_000,
} as const;

/** The ceiling the arithmetic above is derived against — the ritual's target, not the cap. */
export const REPORT_RESULT_TARGET_TOKENS = 9_000;

/**
 * WHAT EACH SECTION'S SURVIVING PREFIX ACTUALLY IS (round-1 review F3).
 *
 * Five of the readers order by time, so their prefix is the newest rows. `work` orders by
 * `updated_at DESC` and `toolFailures` by `hit_count DESC, tool_name ASC` (`collect.ts`), so
 * calling either one "newest" in a note would be false. The note serves the ordering, not the
 * reverse: the product ordering is NOT changed to make a sentence true — `toolFailures` is
 * ranked by hits because that is what a failure streak is, and `signature.ts` hashes the head
 * of that ranking.
 */
const SECTION_ORDER: Record<string, string> = {
  logs: 'newest', turns: 'newest', auditLog: 'newest', toolCalls: 'newest', calls: 'newest',
  tools: 'newest', work: 'most recently updated', toolFailures: 'most-hit',
};

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

/** The in-row mark a shrunken field leaves. Named once; the clause matches on it. */
export const FIELD_TOO_LARGE = '<omitted: too large for this section, ';

/**
 * ONE FAT ROW MUST NEVER EMPTY A SECTION (round-1 review F1).
 *
 * The bound keeps a newest-first PREFIX, so it stops at the first row that does not fit. When
 * that row is the NEWEST one, the prefix is empty and the note used to read "showing newest 0
 * of 12 — older entries were dropped", which is false twice: nothing older was the problem, and
 * there is no evidence left. It is reachable, not theoretical: nothing truncates log meta and
 * `Executing tool` records arguments verbatim, so ONE call with ~5.5 KB of arguments is a single
 * row over the `logs` budget — the very section the round-1 red was about.
 *
 * So a row that cannot fit on its own is SHRUNK rather than dropped: each top-level field too
 * big to carry is replaced by a marker naming its size, until the row fits. A row whose own KEYS
 * overflow the budget cannot be shrunk this way, so the last resort is a stand-in that says what
 * was there; the section is never empty and the budget always holds.
 *
 * ── WHICH FIELD IS SACRIFICED, AND WHY IT IS NOT SIMPLY THE FATTEST (round-2 review L3) ──
 * The first cut sorted biggest-first, which is right for "sacrifice the fewest fields" and wrong
 * for "keep the row readable": when the fattest field IS the `message`, the message is what went
 * and `meta` rode through whole, so the reader kept the metadata and lost the account of what
 * happened. Measured with an 8,002-character message beside a two-key `meta`. It is reachable —
 * five production sites interpolate an UNTRUNCATED `error.message` into the log message, e.g.
 * `agent/v2/recovery.ts`'s `v2 agent loop failed: ${message}`, where every other consumer in
 * that file slices to 200–500 characters and the log line does not.
 *
 * So the IDENTITY FIELDS ARE RANKED LAST: within each rank the fattest still goes first (fewest
 * fields sacrificed), but nothing in `IDENTITY_FIELDS` is touched while a non-identity field is
 * still carrying weight. That makes the documented promise — a log line's timestamp, level,
 * component and message are what survives — TRUE rather than true-while-`meta`-happens-to-be-fat.
 *
 * ── AND THE CALLER IS TOLD WHICH OF THE THREE OUTCOMES IT GOT (round-2 review L2) ──
 * Two of the three throw the row away, so "its largest fields were replaced with a marker" is
 * false for both. `how` is returned so `boundBundleSections` can word the note from what actually
 * happened instead of from the common case.
 */

/**
 * The fields that say WHICH row this is. Sacrificed only after everything else, because a row
 * stripped of these is a size with no story — the L2 stand-in, one field at a time.
 */
const IDENTITY_FIELDS = new Set(['timestamp', 'level', 'component', 'message']);

/** How much of a sacrificed identity string is put back in front of its marker when the budget
 *  has room. 200 characters is the review's own suggestion and enough to carry the opening of a
 *  provider error, which is the shape that motivated it. */
const MESSAGE_HEAD_CHARS = 200;

/** Which of `shrinkToFit`'s three outcomes was taken — the note is worded from this. */
type ShrinkKind = 'fields' | 'scalar' | 'keys';

function shrinkToFit(item: unknown, budget: number): { item: unknown; how: ShrinkKind } {
  const bytes = JSON.stringify(item)?.length ?? 0;
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return {
      how: 'scalar',
      item: { oversized: true, bytes, note: `a single ${typeof item} value of ${bytes} chars, too large to include` },
    };
  }
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  // Identity fields last; inside each rank, biggest first so the fewest fields are sacrificed.
  const byCost = Object.entries(out)
    .map(([k, v]) => ({ k, cost: JSON.stringify(v)?.length ?? 0, identity: IDENTITY_FIELDS.has(k) }))
    .sort((a, b) =>
      Number(a.identity) - Number(b.identity) || b.cost - a.cost || a.k.localeCompare(b.k));
  const sacrificed: { k: string; was: unknown }[] = [];
  for (const { k, cost } of byCost) {
    if (renderedCost(out) <= budget) break;
    sacrificed.push({ k, was: out[k] });
    out[k] = `${FIELD_TOO_LARGE}${cost} chars>`;
  }

  // ── THE ACCOUNT COMES BACK IF THERE IS ROOM FOR IT (round-2 review L3, second half) ──
  // Ranking identity last is not enough on its own: a message far larger than the whole section
  // must still go, and a bare size marker leaves the reader a row that says WHICH line it was
  // and nothing about what it said. So once the row FITS, any leftover headroom is spent putting
  // the HEAD of a sacrificed identity string back in front of its marker. Done as a second pass,
  // never inside the loop above, because the loop is what guarantees the budget holds — growing a
  // value while still trying to fit could push the row to the `keys` stand-in and lose the
  // identity altogether, which is the very outcome this is here to avoid.
  if (renderedCost(out) <= budget) {
    for (const { k, was } of sacrificed) {
      if (!IDENTITY_FIELDS.has(k) || typeof was !== 'string') continue;
      const headroom = budget - renderedCost(out);
      const room = Math.min(MESSAGE_HEAD_CHARS, headroom - 8);
      if (room <= 0) break;
      out[k] = `${was.slice(0, room)}… ${out[k] as string}`;
      if (renderedCost(out) > budget) { out[k] = `${FIELD_TOO_LARGE}${JSON.stringify(was).length} chars>`; break; }
    }
  }

  return renderedCost(out) <= budget
    ? { item: out, how: 'fields' }
    : {
      how: 'keys',
      item: { oversized: true, bytes, note: `one entry of ${bytes} chars whose field names alone exceed this section's budget` },
    };
}

/**
 * IN THE READER'S OWN ORDER, BUDGET-BOUNDED, AND THE DROP IS SAID OUT LOUD.
 *
 * Each section arrives in its reader's `ORDER BY` (five by time, `work` by update, and
 * `toolFailures` by hit count — `SECTION_ORDER` names which, because a note that said "newest"
 * for all seven would be false for two of them). What survives is a PREFIX of that order, so
 * the count in the note describes a contiguous run rather than a sample: a section stops at the
 * first row that does not fit rather than skipping it and taking a smaller one behind it, since
 * a hole in the middle would make the note a lie. The one exception is the row that does not fit
 * ON ITS OWN — `shrinkToFit` handles it, because "the section is empty" is not an honest answer
 * to "one row was fat".
 *
 * `budgets` is a parameter so the `draft` result's ECHO of the attachment can reuse this exact
 * machinery under its own numbers (`ATTACHMENT_ECHO_CHARS`) rather than growing a second copy of
 * it. A section with no budget in the map given is NOT silently unbounded: it is passed through
 * and a test census refuses one. (There is no such section today.)
 */
export function boundBundleSections(
  raw: Record<string, readonly unknown[]>,
  budgets: Record<string, number | undefined> = BUNDLE_SECTION_CHARS,
): BoundedSections {
  const sections: Record<string, unknown[]> = {};
  const notes: string[] = [];
  for (const [name, items] of Object.entries(raw)) {
    const budget = budgets[name];
    if (budget === undefined) { sections[name] = [...items]; continue; }
    const order = SECTION_ORDER[name] ?? 'first';
    const kept: unknown[] = [];
    let used = 0;
    let shrunk: ShrinkKind | null = null;
    for (const item of items) {
      const cost = renderedCost(item);
      if (used + cost > budget) {
        // A budget that is merely FULL stops the prefix. A first row too big to fit at all is
        // the F1 case: shrink it in place, so the section is never emptied by one fat row.
        if (kept.length > 0) break;
        const shrinkResult = shrinkToFit(item, budget);
        kept.push(shrinkResult.item);
        shrunk = shrinkResult.how;
        break;
      }
      kept.push(item);
      used += cost;
    }
    sections[name] = kept;
    if (kept.length < items.length || shrunk !== null) {
      // ── "OF N" IS THE COLLECTOR'S N, NOT THE WINDOW'S (round-1 review F5) ──
      // `items` is already row-capped: every collector reads at most `COLLECTOR_CAPS`, and the
      // log reader takes the newest 200 lines GLOBALLY before the agent/window filter. So the
      // old wording, "of 200 in this window", asserted a window population nobody counted — a
      // box with 210 audit rows inside the window rendered exactly that. The count is true about
      // what this collector RETURNED, so that is what the sentence now says, and the cap is named
      // so the reader knows the number has a ceiling rather than being a census.
      const head = `${name}: showing the ${kept.length} ${order} of ${items.length} `
        + 'rows this collector returned for the window (collectors are row-capped, so there may '
        + 'be more in the window than were read)';
      if (shrunk === null) {
        notes.push(`${head} — the rest are not included here, to stay inside this section's size budget.`);
      } else {
        // ROUND-2 REVIEW L2: the sentence is worded from the outcome that actually happened.
        // Two of the three discard the row, so claiming its fields were replaced would be false.
        const what = shrunk === 'fields'
          ? 'so its largest fields were replaced with a marker naming their size'
          : shrunk === 'scalar'
            ? 'and is a single value larger than this whole section, so only its size is recorded'
            : 'and its field names alone exceed this section\'s budget, so only its size is recorded';
        // ROUND-2 REVIEW L5: only say something is behind it when something IS behind it. On a
        // quiet box a section of exactly one oversized row was told the opposite.
        const behind = items.length > kept.length ? ' Everything behind it is not included here.' : '';
        notes.push(`${head} — and that one entry was itself over this section's size budget, ${what}.${behind}`);
      }
    }
  }
  return { sections, notes };
}

/**
 * THE SAME BOUND OVER A DOCUMENT WHOSE ARRAYS ARE THE PART THAT GROWS — `draft`'s echo of the
 * attachment. Non-array members (`report`, `platform`, `window`, `settings`) are small, fixed
 * and pass through untouched; the four arrays are what scale with the window. The notes come
 * back separately so the caller can say, in its own words, that only the COPY was trimmed.
 */
export function boundDocumentArrays(
  doc: Record<string, unknown>, budgets: Record<string, number | undefined>,
): { doc: Record<string, unknown>; notes: string[] } {
  const arrays: Record<string, readonly unknown[]> = {};
  for (const [k, v] of Object.entries(doc)) if (Array.isArray(v)) arrays[k] = v;
  const bounded = boundBundleSections(arrays, budgets);
  return { doc: { ...doc, ...bounded.sections }, notes: bounded.notes };
}
