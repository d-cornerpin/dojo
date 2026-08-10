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
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { markObsolete } from '../vault/store.js';

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
