// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 3 T17 — NO PARALLEL MEMORY OF OBLIGATIONS
//
// SWEEP CORE-2 item 4 gave the recall lane one rule: a hit is resolved against the
// authoritative record before the model is shown it — NO PARALLEL MEMORY OF ANSWERS.
// This module is that rule pointed the other way. The spine (`work`, kind='commitment')
// is the only truth about what is OWED; the vault is a memory of what was SAID, and a
// sentence in it is never a ledger entry.
//
// THE DEFECT IT CLOSES (round-3 F3, measured on the live body). Three vault entries
// described promises whose spine rows were ALL `abandoned` — `retrieval_count`
// 1560 / 714 / 346, `confidence 1.0`, `is_obsolete 0`. Every arm of the vault's own
// hygiene (`vault/maintenance.ts:152-215`) is keyed on `retrieval_count = 0`, so being
// recalled is precisely what kept a dead promise alive: the feedback loop is closed by
// `vault/store.ts`'s retrieval bump. The recall lane then rendered the line under
// "From your long-term vault (retrieved by meaning):" in the present tense — "Waiting
// on Bob's address before proceeding." — with no state, no age and no validity signal,
// while the OPEN WORK block in the SAME assembled prompt correctly carried none of
// them. Two blocks disagreed and nothing reconciled them.
//
// WHAT COUNTS AS TERMINAL IS ASKED OF THE SCHEMA, NOT RESTATED HERE.
// `db/migrations/135_work_spine.sql:64` carries
//     CHECK ((state IN ('done','failed','abandoned')) = (closed_at IS NOT NULL))
// so `closed_at IS NOT NULL` IS the terminal predicate, enforced by the database on
// every write. Copying the three state names into this file would be a second
// declaration of a fact that already has exactly one owner, and it is also what lets
// this module stay out of `work/store.ts`'s import graph entirely.
//
// THE TAG IS THE ONLY JOIN, AND IT IS NEVER GUESSED. The link between a vault line and
// its commitment does not exist as a column: `openCommitment` writes no vault row and
// the vault subsystem has no concept of a commitment (verified: zero `vault` imports
// under `work/`, zero `work/` imports under `vault/` before this file). What DOES exist
// is a token the model itself wrote into both the vault content and the commitment
// title — `promise-<runid>` — plus the spine's own printable id, `cmt:<12 hex>`, which
// the OPEN WORK block shows whole. Those two literal tokens are the entire join. There
// is no fuzzy matching, no similarity, no title comparison: a line with no resolvable
// token resolves to NOTHING and is handled as unverifiable, never as dead.
//
// AMBIGUITY RESOLVES TOWARD THE OBLIGATION. A `promise-` token is a fixture RUN id and
// can match several commitments at once (measured: one entry, three `cmt:` rows). So a
// tag set is "closed" only when EVERY row it resolves to is closed; one still-owed row
// anywhere in the set makes the memory live and it is rendered exactly as today. The
// same rule governs retirement — a shared token never retires a memory while one of its
// siblings is still owed.
//
// ── UX-REPAIR ROUND 7 T28 — THE ONE SHAPE THE TOKEN RULE COULD NOT REACH ────────
// The paragraph above says "no title comparison", and for the VAULT leg (§1–§3) that is
// still exactly true: nothing below is reachable from `obligationVerdict`,
// `obligationShape` or `retireObligationMemory`, and the vault's write guard and read
// marker behave byte-identically to the day they shipped.
//
// §4 exists because the token rule left a measured hole. T20 counted 17 obligation lines
// in stored summaries that cite no id at all and left them, deliberately, as an id-only
// pass. Round 7 measured the cost: on 2026-08-11 five stored summaries for one agent
// still carried "the fence and roof quotes are still parked, waiting on Bob's address"
// while ALL 131 of that agent's commitment rows were terminal (87 of them naming Bob,
// every one `abandoned`, newest closed 2026-08-06) — and the model served those lines to
// the owner as live work. Fourth recurrence of the same class across rounds 3, 4 and 7.
//
// So the ban is narrowed, not lifted, and the narrowing is the whole design:
//   · it runs ONLY on a line that is already obligation-shaped IN PROSE (§4's cue list),
//   · it matches ONLY within one agent's own spine,
//   · the vocabulary comes FROM the spine rows — never invented from the prose — and a
//     row matches only when the line names BOTH its counterparty (a proper noun the
//     title carries) AND one of its deliverable nouns,
//   · AND the line and the title must share a three-word PHRASE containing that
//     counterparty. Bag-of-words agreement alone was measured on the worn-in body first
//     and it was not good enough: it joined "David is still owed the final reply" to a
//     commitment about a codeword on the strength of "David" plus "final", and it hung a
//     validity marker on a bare heading. The phrase requirement is what makes a match
//     something a reader can check in one glance ("waiting on Bob's address" is in both),
//     and it is the difference between a join and a resemblance,
//   · and it can only ever say the thing that is safe to be wrong about: a match whose
//     rows are wholly terminal is annotated as history; ONE still-open row anywhere in
//     the match set leaves the line exactly as written (same rule as §2, same reason).
// It never retires a memory, never rewrites a word, and never runs on the vault.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { markObsolete } from '../vault/store.js';
// §7's board counts ask `tracker-view.ts` which rows are the tracker's, rather than re-typing
// its three root kinds here. See the §7 header.
import { taskScope, projectScope } from './tracker-view.js';

const logger = createLogger('obligation-memory');

// ── 1. SHAPE ────────────────────────────────────────────────────────────────────
//
// What makes a sentence an OBLIGATION rather than a fact. Deliberately narrow, and
// the narrowness is the whole design: the writer guard below REFUSES on this, so a
// false positive costs the agent a legitimate memory. Every marker here is either an
// explicit obligation LABEL, a first-person commissive ("I will", "I need to"), a
// first-person promise report ("I promised to"), or one of the two join tokens — all
// four are things a note about the world does not say about itself. Measured against
// every live vault entry on the worn-in dev box before the guard was enabled; the
// false-positive report is in `task-W7-report.md`.

/** An obligation LABEL heading the content, after the engine's optional `[date]` stamp
 *  (`vault/tools.ts` adds that prefix; it is not the model's). */
const OBLIGATION_LABEL =
  /^\s*(?:\[\d{4}-\d{2}-\d{2}\]\s*)?(commitment|promise|todo|to-do|action item|follow[- ]?up|owed|deliverable)\s*[:\-—]/i;

/** First person, future, undertaken by the speaker. `I'll`, `I will`, `we need to`… */
const COMMISSIVE = /\b(?:i|we)\s*(?:'ll|’ll|\s+(?:will|shall|must|am going to|'m going to|’m going to|are going to|'re going to|’re going to|need to|have to|ought to))\s+\S/i;

/** First person, reporting the undertaking itself. */
const PROMISE_REPORT = /\b(?:i|we)\s+(?:promised?|committed?|undertook|undertake|agreed)\s+to\b/i;

/** The two literal join tokens. Their presence alone is obligation shape: nothing but a
 *  commitment record writes them. */
const CMT_TAG = /\bcmt:[0-9a-f]{6,}\b/gi;
const PROMISE_TAG = /\bpromise-[a-z0-9]{6,}\b/gi;

/**
 * The marker that fires, or null. Returning the MARKER rather than a boolean is what
 * lets the refusal name its reason and the report name its false positives.
 */
export function obligationShape(content: string): string | null {
  const text = (content ?? '').trim();
  if (!text) return null;
  const label = OBLIGATION_LABEL.exec(text);
  if (label) return `obligation label "${label[1].toLowerCase()}"`;
  if (PROMISE_REPORT.test(text)) return 'first-person promise report ("I promised to …")';
  if (COMMISSIVE.test(text)) return 'first-person commissive ("I will …" / "I need to …")';
  CMT_TAG.lastIndex = 0;
  if (CMT_TAG.test(text)) return 'a commitment id (cmt:…)';
  PROMISE_TAG.lastIndex = 0;
  if (PROMISE_TAG.test(text)) return 'a promise tag (promise-…)';
  return null;
}

/** Every join token in the content, deduplicated, lower-cased. Order preserved. */
export function obligationTags(content: string): string[] {
  const out: string[] = [];
  for (const re of [CMT_TAG, PROMISE_TAG]) {
    re.lastIndex = 0;
    for (const m of (content ?? '').matchAll(re)) {
      const t = m[0].toLowerCase();
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

// ── 2. RESOLUTION AGAINST THE SPINE ─────────────────────────────────────────────

interface CommitmentRow { id: string; state: string; closed: number }

/** The commitments a token set resolves to. `cmt:` tokens are ids; `promise-` tokens are
 *  matched as a literal substring of the title the model wrote them into. */
function rowsForTags(tags: string[]): CommitmentRow[] {
  if (tags.length === 0) return [];
  const db = getDb();
  const ids = tags.filter((t) => t.startsWith('cmt:'));
  const promises = tags.filter((t) => t.startsWith('promise-'));
  const clauses: string[] = [];
  const params: string[] = [];
  if (ids.length > 0) {
    clauses.push(`id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  for (const p of promises) {
    clauses.push('lower(title) LIKE ?');
    params.push(`%${p}%`);
  }
  return db.prepare(
    `SELECT id, state, (closed_at IS NOT NULL) AS closed FROM work
      WHERE kind = 'commitment' AND (${clauses.join(' OR ')})`,
  ).all(...params) as CommitmentRow[];
}

export type ObligationVerdict =
  /** Not obligation-shaped. The caller must leave it exactly as it found it. */
  | { kind: 'not-an-obligation' }
  /** Obligation-shaped, and at least one commitment it names is still owed. */
  | { kind: 'live'; workIds: string[] }
  /** Obligation-shaped, and EVERY commitment it names is closed on the spine. */
  | { kind: 'closed'; workIds: string[]; states: string[] }
  /** Obligation-shaped, and nothing it says resolves to a record. Not dead — UNKNOWN. */
  | { kind: 'unresolvable'; marker: string };

/**
 * What the recall lane needs to know about one vault hit, in one call.
 *
 * The read is bounded by construction: the lane retrieves at most `vaultLimit` (6) hits
 * per turn and caches the whole block for 60s (`memory/recall-lane.ts`), so this is at
 * most six indexed lookups per minute per agent, and none at all on a turn whose hits
 * carry no obligation shape.
 */
export function obligationVerdict(content: string): ObligationVerdict {
  const marker = obligationShape(content);
  if (!marker) return { kind: 'not-an-obligation' };
  const rows = rowsForTags(obligationTags(content));
  if (rows.length === 0) return { kind: 'unresolvable', marker };
  const open = rows.filter((r) => !r.closed);
  if (open.length > 0) return { kind: 'live', workIds: open.map((r) => r.id) };
  return { kind: 'closed', workIds: rows.map((r) => r.id), states: [...new Set(rows.map((r) => r.state))] };
}

// ── 3. RETIREMENT AT THE TERMINAL EXIT ──────────────────────────────────────────

/**
 * A commitment just went terminal: retire the agent's vault memory of it.
 *
 * Called from the ONE writer of `work.state` once the transaction has committed, so a
 * rolled-back state change can never obsolete a memory. `markObsolete` is the vault's
 * own primitive and it sets a FLAG — it never rewrites the agent's words, which is the
 * append-only-in-substance property the vault's recorded intent protects (the engine
 * writes no free text into the agent's memory).
 *
 * Fires only where a join token exists. A commitment whose vault line carries no
 * `cmt:`/`promise-` token is invisible here and is handled at READ time instead, by the
 * validity marker — that split is deliberate, because the alternative is matching by
 * prose, which is the mechanism `839eedc` deleted 623 lines to be rid of.
 *
 * Returns the number of entries retired (0 is the normal case).
 */
export function retireObligationMemory(p: {
  workId: string; agentId: string; title: string | null; state: string;
}): number {
  try {
    const db = getDb();
    const selfTag = p.workId.toLowerCase();
    // The tokens THIS row can be recognised by: its own printable id, plus any
    // `promise-` token the agent wrote into its title.
    const tags = [selfTag, ...obligationTags(p.title ?? '')].filter((t, i, a) => a.indexOf(t) === i);
    // A shared `promise-` token may name siblings that are still owed. Ask the spine
    // before touching anything: if the token set is not wholly closed, nothing retires.
    const safeTags = tags.filter((t) => {
      if (t.startsWith('cmt:')) return true;
      const rows = rowsForTags([t]);
      return rows.length > 0 && rows.every((r) => r.closed);
    });
    if (safeTags.length === 0) return 0;
    const where = safeTags.map(() => 'instr(lower(content), ?) > 0').join(' OR ');
    const hits = db.prepare(
      `SELECT id FROM vault_entries
        WHERE agent_id = ? AND is_obsolete = 0 AND (${where})`,
    ).all(p.agentId, ...safeTags) as Array<{ id: string }>;
    for (const h of hits) {
      markObsolete(h.id, `the commitment it records is ${p.state} on the work spine (${p.workId})`);
    }
    if (hits.length > 0) {
      logger.info('vault memory of a closed commitment retired', {
        workId: p.workId, state: p.state, entries: hits.length, tags: safeTags,
      }, p.agentId);
    }
    return hits.length;
  } catch (err) {
    // Best effort in exactly the way the recall lane is: losing the retirement costs a
    // stale memory that the READ side then marks; letting it throw would take down a
    // state transition that has already committed.
    logger.warn('obligation memory retirement failed', {
      workId: p.workId, error: err instanceof Error ? err.message : String(err),
    }, p.agentId);
    return 0;
  }
}

// ── 4. THE ID-LESS OBLIGATION LINE (UX-REPAIR ROUND 7 T28) ──────────────────────
//
// Everything below is additive and is called from exactly one place — the summary
// annotator. §1–§3 do not reach it.

/**
 * The prose an obligation line uses when the model wrote no id.
 *
 * Every cue here was read off the ten stored lines the round-7 incident produced
 * ("still parked", "waiting on Bob's address", "pending Bob's address", "two
 * outstanding quotes", "remain parked"). It is a GATE, not the decision: a line that
 * fires this and matches no commitment of its own agent is still left alone.
 */
const IDLESS_OBLIGATION_PROSE =
  /\b(?:waiting (?:on|for)|awaiting|parked|still owed?|outstanding|pending)\b/i;

/** Words a title capitalises that are not counterparties. Sentence-initial words are
 *  dropped positionally; this list covers the rest ("… address. Waiting on Bob's …"). */
const NOT_A_COUNTERPARTY = new Set([
  'email', 'send', 'sends', 'sent', 'reply', 'record', 'note', 'waiting', 'wait',
  'commitment', 'promise', 'deliver', 'the', 'once', 'after', 'before', 'later',
  'today', 'tomorrow', 'his', 'her', 'their', 'and', 'then', 'from', 'with', 'for',
  'reminder', 'task', 'project', 'ask',
]);

/** Title words that describe the PROCEDURE rather than the thing owed. Excluding them is
 *  what makes "names the deliverable" mean something: a line that shares only "address"
 *  with a title has not named what is owed. */
const NOT_A_DELIVERABLE = new Set([
  'address', 'send', 'sends', 'sending', 'sent', 'once', 'later', 'today', 'tomorrow',
  'before', 'after', 'proceeding', 'waiting', 'provides', 'need', 'needs', 'email',
  'emails', 'emailed', 'when', 'then', 'from', 'with', 'that', 'this', 'them', 'they',
  'his', 'her', 'their', 'have', 'will', 'until', 'about', 'over',
]);

/** Singular form for the crude plural the summariser writes ("quotes" ↔ "quote"). */
function fold(word: string): string {
  return word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

interface NamedCommitmentRow { id: string; state: string; closed: number; title: string }

/**
 * A run/fixture identifier the model wrote into the prose — `promise-bms6yg5klro`,
 * `failproj-bmsgoeiyu25-a1`. Alphabetic prefix, then a segment that is long AND carries a
 * digit, which is what separates an id from an ordinary hyphenated word
 * ("technique-distillation" is not an id) and from a UUID fragment.
 *
 * It exists for ONE purpose: when a line and a title BOTH name an id and the ids differ,
 * the model has told us they are different records and no amount of shared phrasing
 * outranks that. On a body full of fixture runs whose titles differ only in that id, this
 * is the difference between joining the right row and joining its twin.
 */
const RUN_ID_TOKEN = /\b[a-z]{4,}-(?=[a-z0-9]*\d)[a-z0-9]{8,}(?:-[a-z0-9]+)?\b/gi;

function runIds(text: string): string[] {
  RUN_ID_TOKEN.lastIndex = 0;
  return [...new Set((text.match(RUN_ID_TOKEN) ?? []).map((t) => t.toLowerCase()))];
}

/** Possessives collapse so "Bob's address" and "Bob" are the same name, then words only.
 *  Both sides of every comparison go through this one function. */
function normalizedWords(text: string): string[] {
  return (text.replace(/['’]s\b/gi, '').match(/\b[A-Za-z][A-Za-z-]*\b/g) ?? [])
    .map((w) => w.toLowerCase());
}

/** The three-word phrases of a text. Three, not two: two-word agreement on "waiting on"
 *  is the cue itself and joins nothing. */
function trigrams(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/** One spine row reduced to what a line has to share with it to match. */
export interface RowVocabulary {
  row: NamedCommitmentRow;
  counterparties: string[];
  deliverables: string[];
  phrases: Set<string>;
  ids: string[];
}

function vocabularyOf(row: NamedCommitmentRow): RowVocabulary {
  const title = (row.title ?? '').replace(PROMISE_TAG, ' ').replace(CMT_TAG, ' ');
  CMT_TAG.lastIndex = 0; PROMISE_TAG.lastIndex = 0;
  const words = title.match(/\b[A-Za-z][A-Za-z'’-]{1,}\b/g) ?? [];
  const counterparties: string[] = [];
  const deliverables: string[] = [];
  words.forEach((w, i) => {
    const lower = w.replace(/['’]s$/i, '').toLowerCase();
    // A counterparty is a proper noun the title carries — capitalised, and never the
    // word the title happens to open with.
    if (i > 0 && /^[A-Z][a-z]{2,}(?:['’]s)?$/.test(w) && !NOT_A_COUNTERPARTY.has(lower)
        && !counterparties.includes(lower)) counterparties.push(lower);
    const f = fold(lower);
    if (f.length >= 4 && !NOT_A_DELIVERABLE.has(f) && !NOT_A_DELIVERABLE.has(lower)
        && !deliverables.includes(f)) deliverables.push(f);
  });
  return {
    row,
    counterparties,
    deliverables: deliverables.filter((d) => !counterparties.includes(d)),
    phrases: trigrams(normalizedWords(title)),
    ids: runIds(row.title ?? ''),
  };
}

/** Agent-scoped, read once per sweep/annotation rather than per line. */
function commitmentVocabulary(agentId: string): RowVocabulary[] {
  const rows = getDb().prepare(
    `SELECT id, state, (closed_at IS NOT NULL) AS closed, COALESCE(title, '') AS title
       FROM work WHERE kind = 'commitment' AND agent_id = ?
      ORDER BY closed_at, opened_at`,
  ).all(agentId) as NamedCommitmentRow[];
  return rows.map(vocabularyOf).filter((v) => v.counterparties.length > 0 && v.deliverables.length > 0);
}

export type IdlessObligationVerdict =
  /** Not obligation-shaped in prose, or it names nobody this agent ever owed anything to. */
  | { kind: 'not-an-obligation' }
  /** It names a commitment of this agent's that is STILL OWED. Leave it exactly as written. */
  | { kind: 'live'; workIds: string[] }
  /** Every commitment it names is closed on the spine. */
  | { kind: 'closed'; workIds: string[]; states: string[]; newest: string; matchedTitle: string }
  /** It names a counterparty this agent has commitments with, but no deliverable of theirs. */
  | { kind: 'unmatched'; counterparty: string };

/**
 * Resolve ONE id-less summary line against ONE agent's commitment spine.
 *
 * `vocab` is passed in so a sweep over a whole body reads the spine once per agent.
 */
export function idlessObligationVerdict(
  line: string, agentId: string, vocab?: RowVocabulary[],
): IdlessObligationVerdict {
  const text = (line ?? '').trim();
  if (!text || !IDLESS_OBLIGATION_PROSE.test(text)) return { kind: 'not-an-obligation' };
  const rows = vocab ?? commitmentVocabulary(agentId);
  if (rows.length === 0) return { kind: 'not-an-obligation' };

  const words = normalizedWords(text);
  const lineWords = new Set(words.map(fold));
  const linePhrases = trigrams(words);
  // The counterparty must be named as a PROPER NOUN in the line too — "bob" inside a URL
  // or a lowercase word is not somebody being owed something.
  const properInLine = new Set(
    (text.match(/\b[A-Z][a-z]{2,}(?:['’]s)?\b/g) ?? [])
      .map((w) => w.replace(/['’]s$/i, '').toLowerCase()),
  );

  const lineIds = runIds(text);

  const matched: RowVocabulary[] = [];
  let counterpartySeen: string | null = null;
  for (const v of rows) {
    const person = v.counterparties.find((c) => properInLine.has(c));
    if (!person) continue;
    // Both sides named an id and they disagree: the model already told us these are two
    // different records.
    if (lineIds.length > 0 && v.ids.length > 0 && !v.ids.some((i) => lineIds.includes(i))) continue;
    // The phrase test: line and title must share three consecutive words, one of them the
    // counterparty. Without it, agreement on a name plus one common noun is enough to
    // join two unrelated records — measured, and it was.
    const shared = [...linePhrases].some((p) => v.phrases.has(p) && p.split(' ').includes(person));
    if (!shared) continue;
    counterpartySeen ??= person;
    if (v.deliverables.some((d) => lineWords.has(d))) matched.push(v);
  }
  if (matched.length === 0) {
    return counterpartySeen === null
      ? { kind: 'not-an-obligation' }
      : { kind: 'unmatched', counterparty: counterpartySeen };
  }
  // Same law as §2: one still-owed row anywhere in the set makes the line live.
  const open = matched.filter((m) => !m.row.closed);
  if (open.length > 0) return { kind: 'live', workIds: open.map((m) => m.row.id) };
  return {
    kind: 'closed',
    workIds: matched.map((m) => m.row.id),
    states: [...new Set(matched.map((m) => m.row.state))],
    newest: matched[matched.length - 1].row.id,
    matchedTitle: matched[matched.length - 1].row.title,
  };
}

/** Exposed so a caller sweeping many lines of one agent reads the spine once. */
export function commitmentVocabularyFor(agentId: string): RowVocabulary[] {
  return commitmentVocabulary(agentId);
}

// ── 5. THE SET, NOT THE LINE (HARNESS-LEARNINGS HL5) ────────────────────────────
//
// §1–§4 all answer the same question: "is THIS line still owed?" — and they answer it
// by marking the line where it sits. That is annotation, and the record says annotation
// loses. T28 appended a terminal-state marker to twenty stored lines and the floor model
// parroted "still parked, waiting on Bob's address" 2/2 (W11); T28b moved the same marker
// to the front of the line and it parroted 2/2 again (W12) — both times while its own
// OPEN WORK block was empty and its own `work_update(list)` had just answered "No active
// tasks". Four driven runs across two sittings, zero behaviour change.
//
// dsh's rule is not a better marker (`deepseek-harness-findings.md` P2.2/P2.3, quoting
// their own strings): state is RE-PUBLISHED as a whole superseding snapshot, with an
// explicit sentence when the set is EMPTY, and it is never amended in place. So this
// section answers the other question — "what is owed, all of it, right now?" — and the
// recall lane publishes THAT instead of serving lines one at a time.
//
// IT LIVES HERE, beside the resolver, for the reason the resolver's own header gives:
// "what does the spine say is owed" must keep having exactly one owner. The predicate is
// §2's predicate, unchanged — `closed_at IS NULL`, which the schema's own CHECK makes the
// definition of "still owed" — so a snapshot can never disagree with a per-line verdict.

export interface LiveCommitment {
  id: string;
  title: string;
  state: string;
  openedAt: number;
}

/**
 * Every commitment this agent still owes, newest first. The whole set — no age cutoff, no
 * conversation scope, no state allowlist beyond the schema's own terminal predicate. A
 * snapshot that quietly omitted a row would make "anything not listed is not owed" a lie,
 * which is the one sentence this whole task turns on.
 *
 * Deliberately NOT `openObligations()` (`work/store.ts`): that reader serves the OPEN WORK
 * block, and it is narrower in two ways that are correct there and wrong here — it drops
 * rows past the ageing horizon (ageing demotes to the daily brief, requirement 4b) and it
 * excludes `claimed`. Reusing it would make the snapshot's completeness claim false for an
 * aged or in-flight commitment. One question, one predicate: the resolver's.
 */
export function liveCommitments(agentId: string): LiveCommitment[] {
  return getDb().prepare(
    `SELECT id, COALESCE(title, '') AS title, state, opened_at AS openedAt
       FROM work
      WHERE kind = 'commitment' AND agent_id = ? AND closed_at IS NULL
      ORDER BY opened_at DESC`,
  ).all(agentId) as LiveCommitment[];
}

/**
 * Has this agent ever recorded a commitment? The snapshot's gate.
 *
 * MEASURED, not assumed: gating on RETRIEVAL would never fire on the case this exists for.
 * §2 already tells the recall lane to DROP a closed obligation hit, so on the body this
 * class was measured on — 136 commitment rows, every one terminal — an obligation-shaped
 * hit reaches the render and is discarded before anything could gate on it. The spine is
 * the gate instead: one indexed lookup, deterministic, and it is what makes the empty-set
 * statement reachable at all.
 *
 * An agent that has never made a commitment publishes nothing, which is also correct: there
 * is no earlier mention for a snapshot to supersede, and a lane that says "you owe nothing"
 * to an agent with no history is noise.
 */
export function hasCommitmentHistory(agentId: string): boolean {
  const row = getDb().prepare(
    `SELECT 1 FROM work WHERE kind = 'commitment' AND agent_id = ? LIMIT 1`,
  ).get(agentId);
  return row !== undefined;
}

// ── 6. THE SAME ANSWER, AT THE DOOR (HARNESS-LEARNINGS HL6) ─────────────────────
//
// The sharpest datum in this whole class is W8's driven replay, because in it the model did
// the RIGHT thing: asked before speaking. `work_update(action="list")` answered "No active
// tasks." and, four seconds later, the reply asserted the dead Bob quotes as still parked.
// That is not a model ignoring its instruments. That tool lists TASKS and PROJECTS and has
// never listed commitments at all, so a model that checks its board is told the truth about
// two thirds of it and left to infer the third — and inferring from an older summary is the
// rational move when nothing contradicts it.
//
// dsh's F4 in one sentence: "a static instruction does not reliably reach the retry decision,
// while the error message is present exactly when the model must act." The decision moment
// here is the board read. So the answer goes there, in the same words the snapshot uses,
// FROM THE SAME READER — one owner of "what does the spine say is owed", now rendered at two
// surfaces instead of answered by two mechanisms.
//
// It is a tool RESULT, so it costs zero cached prefix bytes — the [FILED] precedent (W17),
// verified the same way at W18's release check.

/** The whole-board statement when nothing is open. One literal, so the tool result, the test
 *  and any future reader all read the same bytes and cannot drift. */
export const COMMITMENT_POSITION_NONE =
  'Commitments: none open. Every commitment on your board is closed, so nothing is owed — '
  + 'whatever an older summary or note still says in the present tense.';

/**
 * One line for a board-read result, or null when this agent has no commitment history at all
 * (the same gate the snapshot uses, for the same reason: nothing to correct, so no noise).
 */
export function commitmentPositionLine(agentId: string): string | null {
  if (!hasCommitmentHistory(agentId)) return null;
  const live = liveCommitments(agentId);
  if (live.length === 0) return COMMITMENT_POSITION_NONE;
  return `Commitments: ${live.length} open commitment${live.length === 1 ? '' : 's'} — `
    + 'the complete list is in the OPEN COMMITMENTS snapshot in your context; this tool lists '
    + 'tasks and projects only.';
}

// ── 7. THE REST OF THE BOARD, COUNTED (UX-REPAIR ROUND 11 T44) ──────────────────
//
// §5 answers "what commitments are owed, all of them, right now?" and the recall lane
// publishes that set. Round-11 S4 is the same defect one noun over: the reply said "One
// thing's still on my plate" while the live board held TEN non-terminal rows — six owner
// `ask` rows in state `blocked` and four tracker `task` rows — and the turn had made no
// board-wide read at all. Nothing in the model's context could source a count of any kind:
// the snapshot is commitments-only by charter, and `engine.open-work` is
// conversation-scoped, 600-char capped, ageing-filtered and excludes `claimed`.
//
// So this reader answers "how much else is on the board?" — COUNTS, never lists. That
// distinction is the whole collision argument with `engine.open-work`: that block shows SOME
// rows, this states ALL the numbers, and the line the lane renders says which it is and
// points at the list door. A count is also O(1) bytes, so completeness here needs no cap and
// no ageing horizon — the two things that make the other surface incomplete.
//
// IT LIVES HERE for §5's reason, restated: "what does the spine say is outstanding" keeps
// exactly one owner. The predicate is §2's predicate unchanged — `closed_at IS NULL`, which
// the schema's own CHECK makes the definition of terminal — and the scope is the agent's.
//
// WHICH ROWS ARE THE TRACKER'S is asked of `tracker-view.ts`, which owns that question
// (`taskScope`/`projectScope`). Re-typing the three root kinds here would be a second
// declaration of a fact that already has an owner, and it would also make this count
// disagree with the door it sends the model to: T4's fan-out opens its countdown children as
// `kind='task'` with `root_kind='a2a_thread'`, and those are pieces of an ask that
// `work_update(action="list")` does not show.

export interface BoardCounts {
  /** Non-terminal `kind='ask'` rows: someone's unanswered request to this agent. */
  asks: number;
  asksBlocked: number;
  /** Non-terminal tracker rows — the board's own two nouns, join pieces excluded. */
  tracker: number;
  trackerBlocked: number;
}

const TRACKER_ROWS = `((${taskScope('w')}) OR (${projectScope('w')}))`;

/**
 * The whole board, in four numbers. One statement, one pass, one predicate.
 *
 * Commitments are deliberately absent: §5 already renders that set completely and the line
 * this feeds sits directly beneath it. Two answers to one question is the parallel memory
 * this module exists to prevent.
 */
/**
 * T67b tail-hygiene rider — WHEN THIS AGENT'S BOARD LAST CHANGED, in epoch ms.
 *
 * The HL5 snapshot stamped itself `as of <new Date()>` and dated its rows `opened <N> ago`
 * off the same clock, so an IDENTICAL board rendered different bytes once a minute — a tail
 * lane diverging for no content reason, which pushes the provider's cache break earlier in
 * the tail than it needs to be. The header now states this instant and the row ages are
 * measured from it, so the whole block is a pure function of board state and moves only when
 * the board does.
 *
 * `updated_at` is maintained on every write to a row and `opened_at` covers a row that has
 * never been updated; a CLOSE bumps `updated_at` too, so a row leaving the set advances this
 * exactly like a row joining it. Falls back to the clock for an agent with no work rows at
 * all — that agent has no snapshot to stamp (`hasCommitmentHistory` and the board counts are
 * both empty), so the fallback is unreachable from the render and is here for total honesty
 * about the function's domain rather than as a live path.
 */
export function boardLastChangedAt(agentId: string): number {
  const row = getDb().prepare(
    `SELECT MAX(COALESCE(w.updated_at, w.opened_at)) AS at FROM work w WHERE w.agent_id = ?`,
  ).get(agentId) as { at: number | null } | undefined;
  return typeof row?.at === 'number' ? row.at : Date.now();
}

export function openBoardCounts(agentId: string): BoardCounts {
  const row = getDb().prepare(
    `SELECT
       COALESCE(sum(CASE WHEN w.kind = 'ask' THEN 1 ELSE 0 END), 0) AS asks,
       COALESCE(sum(CASE WHEN w.kind = 'ask' AND w.state = 'blocked' THEN 1 ELSE 0 END), 0)
         AS asksBlocked,
       COALESCE(sum(CASE WHEN ${TRACKER_ROWS} THEN 1 ELSE 0 END), 0) AS tracker,
       COALESCE(sum(CASE WHEN ${TRACKER_ROWS} AND w.state = 'blocked' THEN 1 ELSE 0 END), 0)
         AS trackerBlocked
       FROM work w
      WHERE w.agent_id = ? AND w.closed_at IS NULL`,
  ).get(agentId) as BoardCounts;
  return row;
}
