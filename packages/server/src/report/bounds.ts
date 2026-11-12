// Character budgets for the bundle the agent reads, and the notes that say what was dropped.
// Pure functions over a collected document (no import, clock or database), so any caller can share them.

/** Per-section budgets in rendered characters (`renderedCost`): `dojo_report`'s 12,000-token cap is about
 *  48,000 chars and truncates from the END. The sections sum to 26,100; head, notes and window bring it
 *  to a maximal result near 29,500. `scrub()` runs after the bound, so a redaction marker can add more. */
export const BUNDLE_SECTION_CHARS = {
  logs: 6_000, turns: 5_600, auditLog: 5_000, toolCalls: 4_000, calls: 3_500,
  work: 1_000, toolFailures: 1_000,
} as const;

/** The same bound for `draft`'s echo of the attachment (its keys are `tools`, not `toolCalls`).
 *  The brief is deliberately unbounded and the stored attachment is never trimmed: only this copy is. */
export const ATTACHMENT_ECHO_CHARS = {
  turns: 5_600, tools: 4_000, calls: 3_500, work: 1_000,
} as const;

export const REPORT_RESULT_TARGET_TOKENS = 9_000;

/** What each section's surviving prefix is. `work` orders by `updated_at DESC` and `toolFailures` by
 *  `hit_count DESC` (`collect.ts`), so a note must not call them "newest". */
const SECTION_ORDER: Record<string, string> = {
  logs: 'newest', turns: 'newest', auditLog: 'newest', toolCalls: 'newest', calls: 'newest',
  tools: 'newest', work: 'most recently updated', toolFailures: 'most-hit',
};

/** Cost of one item in the pretty-printed bundle: its form, 4 spaces per line (depth two), and a comma. */
export function renderedCost(item: unknown): number {
  const s = JSON.stringify(item, null, 2) ?? 'null';
  return s.length + 4 * s.split('\n').length + 2;
}

/** One section after bounding: what survived, and the note that says what did not. */
export interface BoundedSections {
  sections: Record<string, unknown[]>;
  /** One honest line per section that dropped anything. Empty when nothing was dropped. */
  notes: string[];
}

export const FIELD_TOO_LARGE = '<omitted: too large for this section, ';


// A row too big for its section is shrunk, never dropped. Identity fields (timestamp, level, component,
// message) are sacrificed last so the row still says which line it was.
const IDENTITY_FIELDS = new Set(['timestamp', 'level', 'component', 'message']);

const MESSAGE_HEAD_CHARS = 200;

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

  // Second pass, outside the fitting loop: restoring a head must never push the row past the budget.
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
 * Each section arrives in its reader's order and keeps a contiguous PREFIX, so the note's count is true. A
 * row too fat on its own is shrunk by `shrinkToFit`. `budgets` is a parameter so the echo reuses this. */
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
      // "Of N" is the collector's own (row-capped) count, not the window's population.
      const head = `${name}: showing the ${kept.length} ${order} of ${items.length} `
        + 'rows this collector returned for the window (collectors are row-capped, so there may '
        + 'be more in the window than were read)';
      if (shrunk === null) {
        notes.push(`${head} — the rest are not included here, to stay inside this section's size budget.`);
      } else {
        const what = shrunk === 'fields'
          ? 'so its largest fields were replaced with a marker naming their size'
          : shrunk === 'scalar'
            ? 'and is a single value larger than this whole section, so only its size is recorded'
            : 'and its field names alone exceed this section\'s budget, so only its size is recorded';
        const behind = items.length > kept.length ? ' Everything behind it is not included here.' : '';
        notes.push(`${head} — and that one entry was itself over this section's size budget, ${what}.${behind}`);
      }
    }
  }
  return { sections, notes };
}

/** The same bound over a document whose arrays grow (`draft`'s echo); other members pass through. */
export function boundDocumentArrays(
  doc: Record<string, unknown>, budgets: Record<string, number | undefined>,
): { doc: Record<string, unknown>; notes: string[] } {
  const arrays: Record<string, readonly unknown[]> = {};
  for (const [k, v] of Object.entries(doc)) if (Array.isArray(v)) arrays[k] = v;
  const bounded = boundBundleSections(arrays, budgets);
  return { doc: { ...doc, ...bounded.sections }, notes: bounded.notes };
}
