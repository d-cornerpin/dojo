// NO PARALLEL MEMORY OF OBLIGATIONS: the spine (`work`, kind='commitment') is the only truth about what is
// OWED; the vault is a memory of what was SAID. A vault line joins the spine only by a literal token the
// model wrote (`promise-<runid>`, `cmt:<12 hex>`), never fuzzily; a line with no resolvable token is
// unverifiable, not dead. Terminal is `closed_at IS NOT NULL` (the schema's CHECK), so no state names are
// copied here. A tag set is closed only when EVERY row it resolves to is. The id-less matcher
// (`idlessObligationVerdict`) reads summary lines only (`memory/summary-obligations.ts`), never vault lines:
// an obligation-shaped line, one agent's spine, annotating wholly terminal matches; never retiring a memory.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { markObsolete } from '../vault/store.js';
import { taskScope, projectScope } from './tracker-view.js';
import { heldExpr } from './done/hold.js';
import type { Question } from '../agent/decide.js';
import { judgment } from '../agent/decision-hooks.js';

const logger = createLogger('obligation-memory');

// SHAPE: what makes a sentence an OBLIGATION. Deliberately narrow, because the writer guard REFUSES on
// this: only a label, a first-person commissive or promise report, or a join token, which a note about the
// world never says.

/** An obligation LABEL heading the content, after the engine's optional `[date]` stamp (`vault/tools.ts`). */
const OBLIGATION_LABEL =
  /^\s*(?:\[\d{4}-\d{2}-\d{2}\]\s*)?(commitment|promise|todo|to-do|action item|follow[- ]?up|owed|deliverable)\s*[:\-—]/i;

const COMMISSIVE = /\b(?:i|we)\s*(?:'ll|’ll|\s+(?:will|shall|must|am going to|'m going to|’m going to|are going to|'re going to|’re going to|need to|have to|ought to))\s+\S/i;

const PROMISE_REPORT = /\b(?:i|we)\s+(?:promised?|committed?|undertook|undertake|agreed)\s+to\b/i;

/** The two literal join tokens; only a commitment record writes them, so either alone is obligation shape. */
const CMT_TAG = /\bcmt:[0-9a-f]{6,}\b/gi;
const PROMISE_TAG = /\bpromise-[a-z0-9]{6,}\b/gi;

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

/** Does this note record a promise or to-do still owed? The decision model answers outside its unsure band; inside
 *  it, or with no answer, the word list above decides. */
const OBLIGATION: Question = { type: 'noul', instructions: 'Does `note` record a promise or to-do that the writer still owes (to be kept or dropped later), rather than a fact, preference or standing rule?',
  criteria: { true: "I'll text the babysitter the new pickup time once it is set / Need to return the ladder to the neighbour this weekend / Promised to look up the swim club fees", false: 'States a fact, a code, a preference or a standing rule, or something already done: the bike lock code is 3019 / Always book window seats for the kids / Paid the water bill on Oct 3' } };
export const isObligationNote = async (agentId: string, note: string): Promise<boolean> =>
  (await judgment('memory_shape/obligation', { agentId, state: { note }, questions: { asked: OBLIGATION } }))?.asked ?? obligationShape(note) !== null;

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


interface CommitmentRow { id: string; state: string; closed: number }

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
  | { kind: 'not-an-obligation' }
  | { kind: 'live'; workIds: string[] }
  | { kind: 'closed'; workIds: string[]; states: string[] }
  /** Obligation-shaped, and nothing it says resolves to a record: UNKNOWN, not dead. */
  | { kind: 'unresolvable'; marker: string };

/** What the recall lane needs about one vault hit: at most six lookups a minute (60s block cache,
 *  `memory/recall-lane.ts`). */
export function obligationVerdict(content: string): ObligationVerdict {
  const marker = obligationShape(content);
  if (!marker) return { kind: 'not-an-obligation' };
  const rows = rowsForTags(obligationTags(content));
  if (rows.length === 0) return { kind: 'unresolvable', marker };
  const open = rows.filter((r) => !r.closed);
  if (open.length > 0) return { kind: 'live', workIds: open.map((r) => r.id) };
  return { kind: 'closed', workIds: rows.map((r) => r.id), states: [...new Set(rows.map((r) => r.state))] };
}


/** A commitment just went terminal: retire the agent's vault memory of it (a flag; the agent's words are
 *  never rewritten). Called after the ONE writer of `work.state` commits. Token-less lines are handled
 *  at READ time by the validity marker. */
export function retireObligationMemory(p: {
  workId: string; agentId: string; title: string | null; state: string;
}): number {
  try {
    const db = getDb();
    const selfTag = p.workId.toLowerCase();
    const tags = [selfTag, ...obligationTags(p.title ?? '')].filter((t, i, a) => a.indexOf(t) === i);
    // A shared `promise-` token may name siblings still owed: if the token set is not wholly closed,
    // nothing retires.
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
    // Best effort: throwing would take down a state transition that has already committed.
    logger.warn('obligation memory retirement failed', {
      workId: p.workId, error: err instanceof Error ? err.message : String(err),
    }, p.agentId);
    return 0;
  }
}


const IDLESS_OBLIGATION_PROSE =
  /\b(?:waiting (?:on|for)|awaiting|parked|still owed?|outstanding|pending)\b/i;

const NOT_A_COUNTERPARTY = new Set([
  'email', 'send', 'sends', 'sent', 'reply', 'record', 'note', 'waiting', 'wait',
  'commitment', 'promise', 'deliver', 'the', 'once', 'after', 'before', 'later',
  'today', 'tomorrow', 'his', 'her', 'their', 'and', 'then', 'from', 'with', 'for',
  'reminder', 'task', 'project', 'ask',
]);

const NOT_A_DELIVERABLE = new Set([
  'address', 'send', 'sends', 'sending', 'sent', 'once', 'later', 'today', 'tomorrow',
  'before', 'after', 'proceeding', 'waiting', 'provides', 'need', 'needs', 'email',
  'emails', 'emailed', 'when', 'then', 'from', 'with', 'that', 'this', 'them', 'they',
  'his', 'her', 'their', 'have', 'will', 'until', 'about', 'over',
]);

function fold(word: string): string {
  return word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

interface NamedCommitmentRow { id: string; state: string; closed: number; title: string }

/** A run/fixture id in the prose (`promise-bms6yg5klro`: a prefix, then a long segment with a digit).
 *  When a line and a title both name an id and the ids differ they are different records, whatever
 *  phrasing they share. */
const RUN_ID_TOKEN = /\b[a-z]{4,}-(?=[a-z0-9]*\d)[a-z0-9]{8,}(?:-[a-z0-9]+)?\b/gi;

function runIds(text: string): string[] {
  RUN_ID_TOKEN.lastIndex = 0;
  return [...new Set((text.match(RUN_ID_TOKEN) ?? []).map((t) => t.toLowerCase()))];
}

function normalizedWords(text: string): string[] {
  return (text.replace(/['’]s\b/gi, '').match(/\b[A-Za-z][A-Za-z-]*\b/g) ?? [])
    .map((w) => w.toLowerCase());
}

/** The three-word phrases of a text: two-word agreement on "waiting on" is the cue itself. */
function trigrams(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

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

function commitmentVocabulary(agentId: string): RowVocabulary[] {
  const rows = getDb().prepare(
    `SELECT id, state, (closed_at IS NOT NULL) AS closed, COALESCE(title, '') AS title
       FROM work WHERE kind = 'commitment' AND agent_id = ?
      ORDER BY closed_at, opened_at`,
  ).all(agentId) as NamedCommitmentRow[];
  return rows.map(vocabularyOf).filter((v) => v.counterparties.length > 0 && v.deliverables.length > 0);
}

export type IdlessObligationVerdict =
  | { kind: 'not-an-obligation' }
  | { kind: 'live'; workIds: string[] }
  | { kind: 'closed'; workIds: string[]; states: string[]; newest: string; matchedTitle: string }
  | { kind: 'unmatched'; counterparty: string };

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
    if (lineIds.length > 0 && v.ids.length > 0 && !v.ids.some((i) => lineIds.includes(i))) continue;
    // The phrase test: three consecutive shared words, one of them the counterparty (a name plus a noun
    // joins strangers).
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
  // One still-owed row anywhere in the set makes the line live.
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

export function commitmentVocabularyFor(agentId: string): RowVocabulary[] {
  return commitmentVocabulary(agentId);
}

// THE SET, NOT THE LINE: annotating a stored line in place was measured not to change what the model says,
// so state is RE-PUBLISHED as a whole superseding snapshot (an explicit sentence when EMPTY). It lives here
// so "what does the spine say is owed" keeps one owner: `closed_at IS NULL`, so a snapshot never disagrees
// with a per-line verdict.

export interface LiveCommitment {
  id: string;
  title: string;
  state: string;
  openedAt: number;
}

/** Every commitment this agent still owes, newest first, with no age cutoff or scope: a snapshot that
 *  omitted a row makes "anything not listed is not owed" false. Not `openObligations()`
 *  (`work/store.ts`): it drops aged rows and `claimed`. */
export function liveCommitments(agentId: string): LiveCommitment[] {
  return getDb().prepare(
    `SELECT id, COALESCE(title, '') AS title, state, opened_at AS openedAt
       FROM work
      WHERE kind = 'commitment' AND agent_id = ? AND closed_at IS NULL
      ORDER BY opened_at DESC`,
  ).all(agentId) as LiveCommitment[];
}

/** Has this agent ever recorded a commitment? The snapshot's gate: the spine, not retrieval, since the
 *  recall lane drops a closed obligation hit before anything could gate on it. With no history there is
 *  nothing to supersede. */
export function hasCommitmentHistory(agentId: string): boolean {
  const row = getDb().prepare(
    `SELECT 1 FROM work WHERE kind = 'commitment' AND agent_id = ? LIMIT 1`,
  ).get(agentId);
  return row !== undefined;
}

// THE SAME ANSWER AT THE DOOR: the board read (`work_update(action="list")`) never lists commitments, so
// the answer goes there in the snapshot's words from the same reader. It is a tool RESULT, so it costs zero
// cached prefix bytes.

export const COMMITMENT_POSITION_NONE =
  'Commitments: none open. Every commitment on your board is closed, so nothing is owed — '
  + 'whatever an older summary or note still says in the present tense.';

export function commitmentPositionLine(agentId: string): string | null {
  if (!hasCommitmentHistory(agentId)) return null;
  const live = liveCommitments(agentId);
  if (live.length === 0) return COMMITMENT_POSITION_NONE;
  return `Commitments: ${live.length} open commitment${live.length === 1 ? '' : 's'} — `
    + 'the complete list is in the OPEN COMMITMENTS snapshot in your context; this tool lists '
    + 'tasks and projects only.';
}

// THE REST OF THE BOARD, COUNTED: counts, never lists (O(1) bytes, so no cap or ageing horizon), beside
// `engine.open-work`, which shows SOME rows. Which rows are the tracker's is asked of `tracker-view.ts`:
// fan-out countdown children (`kind='task'`, `root_kind='a2a_thread'`) are pieces of an ask that the list
// door does not show.

export interface BoardCounts {
  asks: number;
  asksBlocked: number;
  tracker: number;
  trackerBlocked: number;
}

const TRACKER_ROWS = `((${taskScope('w')}) OR (${projectScope('w')}))`;

/** The whole board in four numbers, one statement and one predicate. Commitments are absent: that set is
 *  rendered completely by the snapshot, and two answers to one question is the parallel memory this
 *  module prevents. */

export function openBoardCounts(agentId: string): BoardCounts {
  const row = getDb().prepare(
    `SELECT
       COALESCE(sum(CASE WHEN w.kind = 'ask' THEN 1 ELSE 0 END), 0) AS asks,
       COALESCE(sum(CASE WHEN w.kind = 'ask' AND w.state = 'blocked' THEN 1 ELSE 0 END), 0)
         AS asksBlocked,
       COALESCE(sum(CASE WHEN ${TRACKER_ROWS} THEN 1 ELSE 0 END), 0) AS tracker,
       COALESCE(sum(CASE WHEN ${TRACKER_ROWS} AND ${heldExpr('w', 'blocked')} THEN 1 ELSE 0 END), 0)
         AS trackerBlocked
       FROM work w
      WHERE w.agent_id = ? AND w.closed_at IS NULL`,
  ).get(agentId) as BoardCounts;
  return row;
}
