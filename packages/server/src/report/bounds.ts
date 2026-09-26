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
 *     the `bounds` notes, worst case (one per section, ~140 chars each)  ≈   1,200 chars
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
 * big to carry is replaced by a marker naming its size, newest-first, until the row fits. The
 * row's small fields — a log line's timestamp, level, component and message — are exactly the
 * ones worth keeping, and they are what survives. A row whose own KEYS overflow the budget
 * cannot be shrunk this way, so the last resort is a stand-in that says what was there; the
 * section is never empty and the budget always holds.
 */
function shrinkToFit(item: unknown, budget: number): unknown {
  const bytes = JSON.stringify(item)?.length ?? 0;
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return { oversized: true, bytes, note: `a single ${typeof item} value of ${bytes} chars, too large to include` };
  }
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  // Biggest field first, so the fewest fields are sacrificed.
  const byCost = Object.entries(out)
    .map(([k, v]) => ({ k, cost: JSON.stringify(v)?.length ?? 0 }))
    .sort((a, b) => b.cost - a.cost || a.k.localeCompare(b.k));
  for (const { k, cost } of byCost) {
    if (renderedCost(out) <= budget) break;
    out[k] = `${FIELD_TOO_LARGE}${cost} chars>`;
  }
  return renderedCost(out) <= budget
    ? out
    : { oversized: true, bytes, note: `one entry of ${bytes} chars whose field names alone exceed this section's budget` };
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
    let shrunk = false;
    for (const item of items) {
      const cost = renderedCost(item);
      if (used + cost > budget) {
        // A budget that is merely FULL stops the prefix. A first row too big to fit at all is
        // the F1 case: shrink it in place, so the section is never emptied by one fat row.
        if (kept.length > 0) break;
        kept.push(shrinkToFit(item, budget));
        shrunk = true;
        break;
      }
      kept.push(item);
      used += cost;
    }
    sections[name] = kept;
    if (kept.length < items.length || shrunk) {
      const head = `${name}: showing the ${kept.length} ${order} of ${items.length} collected in this window`;
      notes.push(shrunk
        ? `${head} — and that one entry was itself over this section's size budget, so its largest `
          + 'fields were replaced with a marker naming their size. Everything behind it is not included here.'
        : `${head} — the rest are not included here, to stay inside this section's size budget.`);
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
