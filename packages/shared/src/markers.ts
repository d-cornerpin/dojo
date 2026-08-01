// ════════════════════════════════════════════════════════════════════════════════════════
// THE MARKER TAXONOMY — one owner for every engine-emitted marker SHAPE.
// PHASE-3 T5. Research 06 requirement E17 ("one shared module with anchored + unanchored
// exports for inbound-A2A, platform-noise, engine-scaffolding, new-session and fresh-read
// sentinels; zero local re-declarations") and E18 (the named live drifts).
//
// ── WHAT THIS MODULE OWNS, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────────
// It owns SHAPES: the literal a marker is written as, and the anchored and unanchored
// matchers derived FROM that literal. It does NOT own MEMBERSHIP — "which of these shapes
// may enter a summary", "which are hidden in regular display mode", "which count as
// inter-agent traffic" are three different policy questions with three different answers,
// and PHASE-1 T8 proved they genuinely disagree: a `── New Session ──` divider is
// USER-VISIBLE to the display taxonomy and EXCLUDED by the summary filter. Collapsing the
// policy lists would make a summariser change a display change. So the consumers keep
// their lists — they just stop re-spelling the shapes.
//
// ── WHY ANCHORED **AND** UNANCHORED ARE BOTH EXPORTED ───────────────────────────────────
// Research 06 §5 found the same marker set written seven ways across the tree, and the two
// worst were an anchored/unanchored pair: `summary-rebuild.ts` scanned message bodies for
// `PM AGENT POKE` (unanchored, no ` FROM`) while `platform-noise.ts` required
// `^\s*\[SOURCE: PM AGENT POKE`. One list was a superset of the other by accident, not by
// decision. Here both forms are BUILT FROM THE SAME PREFIX ARRAY by `anchored()` and
// `anywhere()`, so a marker added to a family reaches both matchers or neither — the
// superset relationship is now a property of the code rather than a coincidence.
//
// ── THE FOUR LIVE DRIFTS THIS MODULE CLOSES (each measured at PHASE-3 T5's HEAD) ────────
//   1. `[a2a:` vs `[A2A:` — the assembler's copy had no `/i` and compaction's did, so a
//      lowercase envelope was stripped from summaries and kept in the live tail. Measured
//      on the live body before unifying: 12,604 rows, 211 match either way, **0 rows
//      differ**. One flag now, and it is `/i` (see A2A_INBOUND_RE).
//   2. `GROUP BROADCAST` was in the assembler's and compaction's copies and in NEITHER
//      shared module, so `visibility.ts` did not hide it and `origin.ts` classified it
//      `kind:'user' relation:'owner'` — an inter-agent broadcast wearing the owner's face,
//      which is the exact thing ruling OR4 forbids.
//   3. `'[System note:'` matched neither `'[System:'` (colon required) nor `'[SYSTEM'`
//      (case-sensitive), so it classified as owner chat too. The anchored matchers here
//      are case-insensitive and the prefix list carries the note form explicitly.
//   4. `thread:([0-9a-f]{8})` never matched a NAMED thread id. Measured on the live body:
//      of 250 parseable `thread:` tokens, **70 (28%) are not hex**, so the already-replied
//      dedupe silently failed on more than a quarter of them.
// ════════════════════════════════════════════════════════════════════════════════════════

/** Escape a literal so it can be embedded in a RegExp. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `^\s*(a|b|c)`, case-insensitive. The form for "this ROW is a marker row". */
function anchored(prefixes: readonly string[]): RegExp {
  return new RegExp(`^\\s*(${prefixes.map(esc).join('|')})`, 'i');
}

/** `(a|b|c)` anywhere, case-insensitive. The form for "this BODY contains a marker". */
function anywhere(prefixes: readonly string[]): RegExp {
  return new RegExp(`(${prefixes.map(esc).join('|')})`, 'i');
}

// ════════════════════════════════════════════════════════════════════════════════════════
// FAMILY 1 — INBOUND A2A
// ════════════════════════════════════════════════════════════════════════════════════════

/** The modern envelope `a2a-transport.ts` writes. */
export const A2A_ENVELOPE_PREFIX = '[A2A:';

/** The legacy `[SOURCE: …]` forms that are ALSO inbound peer traffic. */
export const A2A_LEGACY_SOURCE_PREFIXES: readonly string[] = [
  '[SOURCE: AGENT MESSAGE FROM',
  '[SOURCE: GROUP BROADCAST FROM',
  '[SOURCE: PM AGENT POKE FROM',
];

export const A2A_INBOUND_PREFIXES: readonly string[] = [
  A2A_ENVELOPE_PREFIX,
  ...A2A_LEGACY_SOURCE_PREFIXES,
];

/**
 * THE one inbound-A2A row matcher. Case-insensitive, by decision and by measurement.
 *
 * The two pre-existing copies (`memory/assembler.ts` without `/i`, `memory/compaction.ts`
 * with it) were byte-identical apart from the flag. `/i` won for three reasons, in order:
 * it is what the LIVE compaction path has always used, so nothing regresses; it is the
 * convention every other matcher in this layer already follows (`platform-noise.ts`,
 * `summary-rebuild.ts`, `origin.ts` are all `/i`); and it is the superset, so the failure
 * mode of a future writer emitting a different case is a marker still recognised rather
 * than peer traffic leaking into the owner's chat.
 *
 * The residual risk is stated rather than hidden: a HUMAN message that literally opens
 * with `[a2a:` would now be read as peer traffic. That is bounded by the anchor and, in
 * `origin.ts`, subordinated to structured `inbound_meta` — a real channel message carrying
 * A2A-looking text is still classified by its channel.
 */
export const A2A_INBOUND_RE = anchored(A2A_INBOUND_PREFIXES);
export const A2A_INBOUND_ANYWHERE_RE = anywhere(A2A_INBOUND_PREFIXES);

/**
 * The full modern envelope, with its three captures: intent, thread short-id, sender.
 * Case-SENSITIVE on the intent (`[A-Z]+`) because that is what the writer emits and the
 * capture is used as a value, not as a test.
 */
export const A2A_ENVELOPE_RE = /^\[A2A:([A-Z]+)\s+thread:([^\s\]]+)\s+from:([^\]]+)\]/;

/**
 * The legacy `[SOURCE: … FROM <sender>]` envelope, capturing the sender. ALL THREE forms,
 * which is drift 2: `origin.ts` recognised only `AGENT MESSAGE`, so a group broadcast and a
 * PM poke fell through to the engine branch and, before that, could reach the owner-chat
 * fallthrough. Measured on the live body at T5: 0 rows carry any of the three (all 211 A2A
 * rows use the modern envelope), so this closes a LATENT leak for legacy and upgrading
 * bodies rather than a live one — stated that way rather than claimed as a live fix.
 */
export const A2A_LEGACY_SOURCE_RE =
  /^\[SOURCE: (?:AGENT MESSAGE|GROUP BROADCAST|PM AGENT POKE) FROM ([^\]]+)\]/i;

/**
 * The thread id INSIDE a marker. `[^\s\]]+`, never `[0-9a-f]{8}` — thread ids are often
 * named (`pm-review-2026-06-25`, `thread-jlpvqj-poke-14a`) and the marker carries a
 * `slice(0, 8)` of whatever they are. `origin.ts` was fixed to this shape long ago; the
 * three A2A readers and the assembler's dedupe were not, which is drift 4 above.
 */
export const A2A_THREAD_RE = /thread:([^\s\]]+)/;

/** How many characters of a thread id the marker carries. `a2a_replies.thread_id` holds
 *  the FULL id, which is why its readers compare `substr(thread_id, 1, 8)`. */
export const A2A_THREAD_SHORT_LENGTH = 8;

/** The thread short-id in a marker, or null. Never hex-only. */
export function parseA2AThreadShort(content: string | null | undefined): string | null {
  if (!content) return null;
  const m = A2A_THREAD_RE.exec(content);
  return m ? m[1].slice(0, A2A_THREAD_SHORT_LENGTH) : null;
}

/** True if this row is inbound peer traffic by its PROSE marker alone. Structured origin
 *  (`origin.kind === 'agent'`) is always the primary signal; this is the legacy fallback. */
export function isInboundA2AMarker(content: string | null | undefined): boolean {
  return !!content && A2A_INBOUND_RE.test(content);
}

// ════════════════════════════════════════════════════════════════════════════════════════
// FAMILY 2 — `[SOURCE: …]` PLATFORM ENVELOPES
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * The `[SOURCE: …]` envelopes that are PLATFORM plumbing and NOT peer traffic.
 *
 * THE SPLIT IS LOAD-BEARING and it is a preserved decision, not a tidy-up:
 * `memory/platform-noise.ts` decides what may enter a summary AND what the vault
 * archiver keeps as MEMORY, and its own header records the ruling — "inbound A2A is
 * intentionally NOT in this base list; an A2A deliverable ('Maddy delivered the Verve
 * deck') can be genuine memory, so the vault keeps it." Folding the three A2A forms into
 * that list would delete real memories. Compaction layers its own A2A check on top,
 * because for the PRIMARY's context summary a peer message IS plumbing — two questions,
 * two answers, and this split is what lets one vocabulary serve both.
 */
export const PLATFORM_SOURCE_ENVELOPE_PREFIXES: readonly string[] = [
  '[SOURCE: TRACKER TASK',
  '[SOURCE: SCHEDULER',
  '[SOURCE: HEALER',
  '[SOURCE: ENGINE',
  '[SOURCE: SUB-AGENT COMPLETION',
  '[SOURCE: SYSTEM',
  '[SOURCE: AGENT HEALTH ALERT',
  '[SOURCE: AGENT NOTICE',
];

/**
 * EVERY `[SOURCE: …]` envelope the platform writes — peer traffic included. The vocabulary;
 * membership in any particular policy list is the consumer's business.
 */
export const SOURCE_ENVELOPE_PREFIXES: readonly string[] = [
  ...A2A_LEGACY_SOURCE_PREFIXES,
  ...PLATFORM_SOURCE_ENVELOPE_PREFIXES,
];

export const SOURCE_ENVELOPE_RE = anchored(SOURCE_ENVELOPE_PREFIXES);
export const SOURCE_ENVELOPE_ANYWHERE_RE = anywhere(SOURCE_ENVELOPE_PREFIXES);

/** The generic opener, for readers that only need "is this ANY source envelope". */
export const SOURCE_ENVELOPE_OPENER = '[SOURCE:';

// ════════════════════════════════════════════════════════════════════════════════════════
// FAMILY 3 — ENGINE SCAFFOLDING
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * Engine-authored framing that wears `role:'user'`. `'[System note:'` is listed EXPLICITLY
 * rather than left to `'[System:'` — that is drift 3, and it classified engine scaffolding
 * as the owner's own words for as long as the colon requirement stood.
 */
export const ENGINE_SCAFFOLD_PREFIXES: readonly string[] = [
  '[System:',
  '[System note',
  '[SYSTEM',
  '[Engine',
  '[ENGINE',
  '[CONTINUITY BRIEF',
  '[Context note',
  '[DOJO',
];

export const ENGINE_SCAFFOLD_RE = anchored(ENGINE_SCAFFOLD_PREFIXES);
export const ENGINE_SCAFFOLD_ANYWHERE_RE = anywhere(ENGINE_SCAFFOLD_PREFIXES);

/** The two engine notes injected AHEAD of a user turn. Both open `[Context note:`; only
 *  the stop one was ever filtered out of summaries, which is research 06 §5's
 *  "'[Context note:' gap". They share a prefix so they share a fate. */
export const CONTEXT_NOTE_PREFIX = '[Context note:';

/** Engine injections the display layer hides but that are not `[SOURCE: …]` envelopes. */
export const ENGINE_INJECTION_PREFIXES: readonly string[] = [
  '[Engine hint:',
  '[Engine note:',
  '[System note:',
];

// ════════════════════════════════════════════════════════════════════════════════════════
// FAMILY 4 — NEW SESSION
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * The bracket form. TWO spellings are live and both must match: `[New Session]` (written
 * by the assembler's archive notice) and `[New Session: <date> — …]` (the dated form).
 * `platform-noise.ts` required `\[New Session\]` and therefore missed the dated form
 * entirely, while `receipt.ts` tested `'[New Session'` with no closer at all and would
 * have tagged `[New Sessions are great]`. One matcher, both spellings, nothing else.
 *
 * The DIVIDER form (`── New Session ──`) is a different shape with a different owner:
 * `visibility.ts`'s `formatDivider` / `NEW_SESSION_DIVIDER`. It is display furniture, not
 * an engine marker, and PHASE-1 T8's non-fold list is the record of why.
 */
export const NEW_SESSION_BRACKET_PREFIX = '[New Session';
export const NEW_SESSION_BRACKET_RE = /^\s*\[New Session[\]:]/i;
export const NEW_SESSION_BRACKET_ANYWHERE_RE = /\[New Session[\]:]/i;

// ════════════════════════════════════════════════════════════════════════════════════════
// FAMILY 5 — FRESH-READ SENTINELS
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * The header `techniques/tools.ts` writes on a freshly re-read technique so the assembler
 * and compaction can tell a fresh read from a stale one. It was EXPORTED and imported by
 * nobody: two modules re-declared it and two more inlined the literal, and the extractor
 * regex existed twice. Five spellings of one sentinel.
 */
export const TECHNIQUE_FRESH_SENTINEL = '══ TECHNIQUE FRESH READ ══';

/** The sentinel's header line, capturing the technique name:
 *  `══ TECHNIQUE FRESH READ ══ <name> (<iso timestamp>)`. */
export const TECHNIQUE_FRESH_HEADER_RE = /^══ TECHNIQUE FRESH READ ══ (.+?) \(/;

/** The technique name from a fresh-read block, or null. The ONE extractor. */
export function parseTechniqueFreshRead(content: string | null | undefined): string | null {
  if (!content) return null;
  const m = TECHNIQUE_FRESH_HEADER_RE.exec(content);
  return m ? m[1] : null;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// THE SQL DIALECT — the same taxonomy, for the two readers that cannot import a RegExp
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * `prompt/assembler.ts` filters marker rows in SQL and carried the same three-marker
 * `NOT LIKE` triplet TWICE, byte-identical (`isIMessageTurn` and `resolveInboundContext`).
 *
 * THIS LIST IS THE OWNER AND THE SQL IS ASSERTED AGAINST IT — the statements are NOT
 * generated from it, and that is a decision with a cost either way. Generating them would
 * make both `db.prepare()` calls take a `${}` template, and `check-sql-prepares.mjs`
 * COUNTS a runtime-assembled statement as not-preparable rather than preparing it: two
 * statements that are schema-verified on every gate run today would stop being verified.
 * Trading a real verification for a cosmetic single-source is the wrong trade, so the
 * duplication is killed by a conformance test instead — exactly the remedy
 * `marker-ownership.test.ts` already uses for `DISPLAY_KINDS` vs migration 132's CHECK,
 * for exactly the same reason (SQL has no import).
 */
export const PROMPT_HISTORY_EXCLUDED_PREFIXES: readonly string[] = [
  '[SOURCE: SYSTEM',
  '[A2A:',
  '[SOURCE: AGENT MESSAGE FROM',
];

/** The `NOT LIKE` clause the two statements must each contain, in this order. The
 *  conformance test builds this and asserts it appears verbatim in both. */
export function promptHistoryMarkerSqlClauses(column = 'content'): string[] {
  return PROMPT_HISTORY_EXCLUDED_PREFIXES.map((p) => `${column} NOT LIKE '${p}%'`);
}
