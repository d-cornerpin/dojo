// ════════════════════════════════════════════════════════════════════════════
// v3.5 — WHAT THE SUMMARY CHECK HAS RECORDED (split from `summary-check.ts`, fix round 2): the spans that
// failed their check (so no writer is handed them again until something changes), and the running numbers
// the Healer report reads.
// ════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { modeFor } from '../agent/decision-policy.js';
import type { Answer } from '../agent/decide.js';
import { recordTruth, SHADOW_REPORT_WINDOW_MS } from '../agent/decision-shadow.js';

/** The check's purpose and its three questions, as the decision shadow and B3's policy name them. */
export const SUMMARY_CHECK_PURPOSE = 'summary_check';
export const SUMMARY_CHECK_QUESTIONS = ['invented', 'dropped', 'stated_current'] as const;
export type SummaryCheckQuestion = typeof SUMMARY_CHECK_QUESTIONS[number];
/**
 * OR-AUDIT-ANSWERS (c), owner ruling (supersedes t268 ruling 1's shadow for this check): "Redo bad summaries". A
 * summary that fails the accuracy check is rewritten by the agent's own model before it is kept. So every question
 * the model is asked ACTS on its verdict, whatever mode the decision policy reads (the shadow rows are still
 * recorded, so the policy's record keeps growing). A question held to the rule is not asked and so cannot act.
 */
export const actingQuestions = (): SummaryCheckQuestion[] => askedQuestions();
export const summaryCheckActs = (): boolean => actingQuestions().length > 0;
/** Fix round 1 (M-3): the questions the model is asked at all — every one not held to the rule. */
export const askedQuestions = (): SummaryCheckQuestion[] => SUMMARY_CHECK_QUESTIONS.filter((q) => modeFor(SUMMARY_CHECK_PURPOSE, q) !== 'rule');
/**
 * The check's id (fix round 2, I-4) — the join key between its `decision_shadow` rows and the summary row it judged:
 * the agent and the SPAN it summarises (the rows it links: `summary_messages` for a leaf, `summary:<id>` of each
 * child for a condensed one — the `spanIds` every caller passes), plus the version below. Unique per span and text
 * checked, and it survives every rewrite of the stored text (obligation notes, the hygiene pass); read off the row by
 * `summaryCheckIdOfRow`.
 * NO PRODUCTION TRUTH SOURCE, BY RULING (2026-10-31): whether a summary invents, drops or states-current is a reading
 * of two texts that no later engine event records, so nothing in production calls `recordSummaryTruth`, no question
 * here is promoted to `model` by measurement (the ruling: agent/__tests__/every-decision-question-has-a-truth-ruling.test.ts).
 * The check acts anyway, by the owner's ruling (`actingQuestions`, OR-AUDIT-ANSWERS (c)).
 */
export const summaryCheckId = (agentId: string, spanIds: readonly string[]): string =>
  `summary-check:${createHash('sha256').update(`${agentId}|${[...spanIds].sort().join('|')}`).digest('hex').slice(0, 32)}`;
/**
 * Fix round 4 (N-D): each text checked for a span is a VERSION of its summary — the check id is the span's key plus
 * `:v<n>` — so a span summarised twice (the one rewrite in `model` mode, the nightly rebuild, a placeholder replaced
 * over the same rows) has distinct ids, and a truth label for the stored row lands on the verdict of the text it holds.
 * Two `healer_state` rows per span, `at_ms` holding a version number: the last version minted, and the version the
 * span's stored summary keeps. Both go with the decision shadow's own keep (its report window and the one before).
 */
const VERSION_SCOPE = 'summary_check_version';
const KEPT_SCOPE = 'summary_check_kept';
const versionIn = (scope: string, key: string): number =>
  (getDb().prepare('SELECT at_ms FROM healer_state WHERE scope = ? AND key = ?').get(scope, key) as { at_ms: number } | undefined)?.at_ms ?? 0;
const setVersion = (scope: string, key: string, version: number): void => {
  getDb().prepare(`INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)
    ON CONFLICT(scope, key) DO UPDATE SET at_ms = excluded.at_ms, updated_at = datetime('now')`).run(scope, key, version);
};
/** A new version's check id for this span (the span's key alone when nothing can be recorded). */
export function mintSummaryCheckId(agentId: string, spanIds: readonly string[]): string {
  const key = summaryCheckId(agentId, spanIds);
  try {
    getDb().prepare("DELETE FROM healer_state WHERE scope IN (?, ?) AND updated_at < datetime('now', ?)")
      .run(VERSION_SCOPE, KEPT_SCOPE, `-${Math.round((2 * SHADOW_REPORT_WINDOW_MS) / 1000)} seconds`);
    const version = versionIn(VERSION_SCOPE, key) + 1;
    setVersion(VERSION_SCOPE, key, version);
    return `${key}:v${version}`;
  } catch { return key; }
}
/** The summary checked under `checkId` is the one its span's stored row now keeps. */
export function noteSummaryKept(checkId: string | undefined): void {
  const m = /^(.*):v(\d+)$/.exec(checkId ?? '');
  if (m) try { setVersion(KEPT_SCOPE, m[1], Number(m[2])); } catch { /* best-effort: a truth label then finds no verdict */ }
}
/** The check id of a stored summary, from its own links and the version it keeps. */
export function summaryCheckIdOfRow(summaryId: string): string {
  const db = getDb();
  const agentId = (db.prepare('SELECT agent_id FROM summaries WHERE id = ?').get(summaryId) as { agent_id: string } | undefined)?.agent_id ?? '';
  const rows = (db.prepare('SELECT message_id AS id FROM summary_messages WHERE summary_id = ?').all(summaryId) as Array<{ id: string }>).map((r) => r.id);
  const kids = (db.prepare('SELECT parent_id AS id FROM summary_parents WHERE summary_id = ?').all(summaryId) as Array<{ id: string }>).map((r) => `summary:${r.id}`);
  const key = summaryCheckId(agentId, rows.length > 0 ? rows : kids);
  const kept = versionIn(KEPT_SCOPE, key);
  return kept > 0 ? `${key}:v${kept}` : key;
}
/** What a truth source records for a stored summary's check (the join `recordTruth` makes, by the span's key). */
export const recordSummaryTruth = (summaryId: string, question: SummaryCheckQuestion, truth: boolean, src: string): void =>
  recordTruth(summaryCheckIdOfRow(summaryId), question, truth, src);


export type SummaryParams = { content: string; agentId: string; modelId?: string; checkFeedback?: string; spanIds?: readonly string[]; spanOpen?: boolean };

// ── A SPAN THAT FAILED ITS CHECK (orchestrator ruling, fix round 2; re-review 2 S6) ──
// It is handed to no other writer by any path, and not retried by the same one, until a REAL signal: the agent's own
// model changes (the owner's pick, which is what writes its summaries), or the span closes with new rows in it.
// Recorded per row (`healer_state` scope `summary_span_refused`, key agent|own model|row id). S6: a span holding a
// refused row is HANDLED (`spanHeld`) while it is the same rows, or while it is still OPEN (the last chunk of a fold,
// which gains a row on every busy pass); it is tried once more when it closes (a later chunk exists, so its boundary
// is final). No timer and no count: each is a fact about the rows.
const REFUSED_SCOPE = 'summary_span_refused';
const ownModelOf = (agentId: string): string => {
  try { return (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id ?? ''; } catch { return ''; }
};
export const spanKeys = (p: SummaryParams): string[] => {
  const own = ownModelOf(p.agentId);
  const ids = p.spanIds && p.spanIds.length > 0 ? p.spanIds : [`content:${createHash('sha256').update(p.content).digest('hex').slice(0, 32)}`];
  return ids.map((id) => `${p.agentId}|${own}|${id}`);
};
export function spanRefused(keys: string[]): boolean {
  return refusedIn(keys) === keys.length;
}
const refusedIn = (keys: string[]): number => {
  try {
    return (getDb().prepare(`SELECT COUNT(*) AS n FROM healer_state WHERE scope = ? AND key IN (${keys.map(() => '?').join(',')})`).get(REFUSED_SCOPE, ...keys) as { n: number }).n;
  } catch { return 0; }
};
/** S6: is this span handled already? Every row refused by this writer, or an open span holding one that was. */
export function spanHeld(keys: string[], open: boolean): boolean {
  const n = refusedIn(keys);
  return n === keys.length || (open && n > 0);
}
export function recordRefusedSpan(keys: string[]): void {
  try {
    const db = getDb();
    // NB-9: this agent's refusals recorded under an earlier own model are over (the owner changed it): pruned. Per
    // agent, so one agent's refusal never re-arms another's.
    const [agent, own] = keys[0]?.split('|') ?? [];
    if (agent !== undefined && own !== undefined) {
      const rows = db.prepare('SELECT key FROM healer_state WHERE scope = ?').all(REFUSED_SCOPE) as Array<{ key: string }>;
      const del = db.prepare('DELETE FROM healer_state WHERE scope = ? AND key = ?');
      for (const { key } of rows) { const [a, m] = key.split('|'); if (a === agent && m !== own) del.run(REFUSED_SCOPE, key); }
    }
    const ins = db.prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET at_ms = excluded.at_ms');
    for (const k of keys) ins.run(REFUSED_SCOPE, k, Date.now());
  } catch { /* best-effort: the worst case is one more try */ }
}
/** NB-9: the span was summarized after all: its rows' refusals go, whichever writer recorded them. */
export function clearRefusedSpan(keys: string[]): void {
  if (keys.length === 0) return;
  try {
    const del = getDb().prepare("DELETE FROM healer_state WHERE scope = ? AND key LIKE ? ESCAPE '\\'");
    for (const k of keys) {
      const [agent, , ...rest] = k.split('|');
      const esc = (x: string): string => x.replace(/[\\%_]/g, (c) => `\\${c}`);
      del.run(REFUSED_SCOPE, `${esc(agent)}|%|${esc(rest.join('|'))}`);
    }
  } catch { /* best-effort */ }
}

/** The Healer report's running numbers over the kept window, or null when nothing was checked. */
export function summaryCheckLine(): string | null {
  try {
    const r = getDb().prepare(`SELECT COUNT(*) AS n, SUM(outcome = 'ok') AS ok, SUM(outcome = 'rewritten_ok') AS rw,
      SUM(outcome = 'not_kept') AS failed, SUM(outcome = 'unavailable') AS un FROM summary_checks`).get() as
      { n: number; ok: number | null; rw: number | null; failed: number | null; un: number | null };
    if (r.n === 0) return null;
    return `Summary check (kept window): ${r.n} checked, ${r.ok ?? 0} kept as written, ${r.rw ?? 0} kept after one rewrite, `
      + `${r.failed ?? 0} left the rows whole, ${r.un ?? 0} unchecked (decision model unavailable).`;
  } catch { return null; }
}

/**
 * THE PASS MARK (fix round 1, I-B4-3): a summary fails a question when the model's probability is at or
 * above it. With no recorded data it is 0.5, the binary decision boundary: a noul answer is P(yes), so
 * p ≥ 0.5 is exactly "the model holds yes at least as likely as no" — the same line the shadow score
 * reads a verdict at. With recorded summary_check rows whose truth is known, it is the cut that agrees
 * with the most of them: the candidates are the midpoints between neighbouring recorded probabilities,
 * 0.5, and the midpoint above the highest; a cut at or below the lowest recorded probability (one that
 * fails every summary) is never a candidate; a tie goes to the cut nearest 0.5.
 */
export function passMark(question: string): number {
  let rows: Array<{ model_said: string; truth: string }> = [];
  try {
    rows = getDb().prepare(`SELECT model_said, truth FROM decision_shadow WHERE purpose = ? AND question = ?
      AND truth IS NOT NULL AND model_said IS NOT NULL`).all(SUMMARY_CHECK_PURPOSE, question) as typeof rows;
  } catch { return 0.5; }
  const points = rows.flatMap((r) => {
    try { const a = JSON.parse(r.model_said) as Answer; return a.type === 'noul' ? [{ p: a.noul, bad: r.truth === 'true' }] : []; } catch { return []; }
  });
  if (points.length === 0) return 0.5;
  const ps = [...new Set(points.map((x) => x.p))].sort((a, b) => a - b);
  const candidates = [0.5, (ps[ps.length - 1] + 1) / 2, ...ps.slice(1).map((p, i) => (ps[i] + p) / 2)].filter((t) => t > ps[0]);
  const agree = (t: number): number => points.filter((x) => (x.p >= t) === x.bad).length;
  if (candidates.length === 0) return 0.5;   // every recorded probability is 1.0: nothing to cut between (N6)
  return candidates.reduce((best, t) => {
    const d = agree(t) - agree(best);
    return d > 0 || (d === 0 && Math.abs(t - 0.5) < Math.abs(best - 0.5)) ? t : best;
  });
}
