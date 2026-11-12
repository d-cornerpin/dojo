// The four calls that reach GitHub's issues: two reads and two authenticated writes. This is only the wire;
// whether a report may leave was decided on the preview card and is held by the approval in `report/store.ts`.
// A failed duplicate search throws: `findIssueBySignature` returns null only when GitHub answered and found nothing.
// Only the authenticated calls write the ledger, and no issue number enters a failure message, because
// `looksLikeAuthFailure` in `github/status.ts` can read a number as a status code. Every non-OK answer goes
// through `refusal.ts`. Labels are best-effort (GitHub drops them silently for a non-writer); triage keys on the
// `dojo-sig:` trailer. No `net-guard`: the host is a fixed constant and the repo a validated slug.

import { getGithubToken, noteGithubFailure, noteGithubOk } from './account.js';
import {
  githubsWords, readRefusal, refusalDetail, reportRefusal, reportUnreadableAnswer,
  type GithubRefusal,
} from './refusal.js';
import { assertPostableRepo } from '../report/repo.js';
import { createLogger } from '../logger.js';

const logger = createLogger('github-issues');

export const GITHUB_API = 'https://api.github.com';

/** Bound on ONE HTTP call; a call that trips it ends the attempt (no background re-dial). */
export const ISSUE_HTTP_TIMEOUT_MS = 10_000;

const API_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

const NOT_CONNECTED = 'GitHub is not connected on this box, so nothing was sent.';
const RATE_LIMITED = 'GitHub is rate-limiting the duplicate check right now. Try again in a minute.';

export interface IssueMatch { number: number; url: string; title: string }

/** The search query uses the BARE digest, not a quoted `dojo-sig:` phrase. */
export function issueSearchUrl(repo: string, signature: string): string {
  const q = `repo:${repo} is:issue "${signature}"`;
  return `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&sort=created&order=asc&per_page=5`;
}

interface SearchItem { number?: unknown; title?: unknown; html_url?: unknown; state?: unknown; body?: unknown }

/** The oldest open issue whose body really contains the signature (closed ones are skipped; the body check guards
 *  against GitHub's fuzzy tokenizer), or null. Throws on any failure. */
export async function findIssueBySignature(repo: string, signature: string): Promise<IssueMatch | null> {
  const res = await fetch(issueSearchUrl(repo, signature), {
    headers: API_HEADERS,
    signal: AbortSignal.timeout(ISSUE_HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    // A 403 on this unauthenticated read is relabelled a rate limit. No ledger write: no credential was sent.
    const refusal = await readRefusal(res);
    logger.warn('github refused the duplicate check', { detail: refusalDetail(refusal) });
    const base = res.status === 403 || res.status === 429
      ? RATE_LIMITED
      : `GitHub could not check for an existing report (HTTP ${res.status}).`;
    throw new Error(`${base} ${githubsWords(refusal)}`);
  }
  const body = await res.json() as { items?: unknown };
  const items: SearchItem[] = Array.isArray(body.items) ? body.items as SearchItem[] : [];
  for (const item of items) {
    if (item.state !== 'open') continue;
    if (typeof item.body !== 'string' || !item.body.includes(signature)) continue;
    if (typeof item.number !== 'number' || typeof item.html_url !== 'string') continue;
    return { number: item.number, url: item.html_url, title: String(item.title ?? '') };
  }
  return null;
}

export type IssueWriteResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** A created issue. `measureLabels` is the label read-back, handed to the caller so it cannot delay recording the
 *  live issue or turn a delivered report into `ok: false`; null when there is nothing to measure. */
export interface CreatedIssue {
  number: number;
  url: string;
  labelsDropped: string | null;
  measureLabels: (() => Promise<string | null>) | null;
}

/** A call that never got an answer: a dead socket, a timeout, an HTML page where JSON was due. */
function unreachable(what: string, err: unknown): { ok: false; error: string } {
  const detail = err instanceof Error ? err.message : String(err);
  const error = `Could not reach GitHub to ${what}: ${detail}`;
  logger.warn(`github issue call failed: ${what}`, { error: detail });
  noteGithubFailure(error);
  return { ok: false, error };
}

function authHeaders(token: string): Record<string, string> {
  return { ...API_HEADERS, Authorization: `Bearer ${token}` };
}

function writeHeaders(token: string): Record<string, string> {
  return { ...authHeaders(token), 'Content-Type': 'application/json' };
}

/** Statuses GitHub uses for a field it will not take; per its contract neither creates an issue. */
const LABEL_RETRY_STATUSES: ReadonlySet<number> = new Set([403, 422]);

/** The one POST. `labels` is omitted when empty: even `[]` is an instruction to set labels. */
function postIssue(
  repo: string, token: string, title: string, body: string, labels: string[],
): Promise<Response> {
  return fetch(`${GITHUB_API}/repos/${repo}/issues`, {
    method: 'POST',
    headers: writeHeaders(token),
    body: JSON.stringify(labels.length === 0 ? { title, body } : { title, body, labels }),
    signal: AbortSignal.timeout(ISSUE_HTTP_TIMEOUT_MS),
  });
}

/** The note when the labels did not survive: refused with labels, accepted without, no guessed cause. */
function labelsDroppedNote(labels: string[], refusal: GithubRefusal): string {
  return `The issue was filed WITHOUT its labels (${labels.join(', ')}). GitHub refused the `
    + `labelled version (HTTP ${refusal.status}) and accepted the same issue with the labels `
    + `removed, so this account can file here but cannot set labels here. ${githubsWords(refusal)} `
    + 'Nothing else changed: the `dojo-sig:` trailer in the body carries what triage needs.';
}

/** The labels the created issue has, or null for NOT MEASURED (never "none"). No ledger write: the post just
 *  succeeded, so a failed read-back says nothing about the credential. Reads both label spellings. */
async function labelsOnIssue(repo: string, token: string, issueNumber: number): Promise<string[] | null> {
  const cannotTell = (why: string): null => {
    logger.warn('could not read the labels back off the issue that was just filed', { issueNumber, why });
    return null;
  };
  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}`, {
      headers: authHeaders(token), signal: AbortSignal.timeout(ISSUE_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return cannotTell(`GitHub answered HTTP ${res.status}`);
    const answer = await res.json() as { labels?: unknown };
    if (!Array.isArray(answer.labels)) return cannotTell('the answer carried no `labels` array');
    const names = answer.labels.map(l => typeof l === 'string' ? l : (l as { name?: unknown } | null)?.name);
    const isReadableName = (n: unknown): n is string => typeof n === 'string' && n !== '';
    if (names.every(isReadableName)) return names;
    return cannotTell('a label in the answer carried no readable name');
  } catch (err) {
    return cannotTell(err instanceof Error ? err.message : String(err));
  }
}

/** The note when GitHub kept fewer labels than sent: names only the measured difference; the no-write-access cause
 *  is cited only when every label was lost. */
function silentlyDroppedNote(sent: string[], kept: string[], dropped: string[]): string {
  const why = kept.length === 0
    ? 'GitHub does that when the account filing has no write access to the repository; its own reference '
      + 'for creating an issue says labels "are silently dropped otherwise". Only someone with write '
      + 'access can add them now, and '
    : 'What removed the rest is not something this box can see, and it will not guess. Someone with '
      + 'write access can add them, and ';
  return `Your report posted. It asked for the label${sent.length === 1 ? '' : 's'} ${sent.join(', ')}, and `
    + `GitHub saved the issue ${kept.length === 0 ? 'with no labels at all' : `with only ${kept.join(', ')}`} — `
    + `${dropped.join(', ')} ${dropped.length === 1 ? 'was' : 'were'} dropped. ${why}nothing triage needs is `
    + 'missing: the `dojo-sig:` trailer is in the issue body, which is what a search finds this report by.';
}

/** Reads the labels back and compares them with what was sent; null when nothing is missing or unmeasured. */
async function labelsThatDidNotSurvive(
  repo: string, token: string, issueNumber: number, sent: string[],
): Promise<string | null> {
  const kept = await labelsOnIssue(repo, token, issueNumber);
  if (kept === null) return null;
  const present = new Set(kept);
  const dropped = sent.filter(l => !present.has(l));
  if (dropped.length === 0) return null;
  logger.warn('github silently dropped labels off an issue it accepted', {
    issueNumber, sent, kept, dropped,
  });
  return silentlyDroppedNote(sent, kept, dropped);
}

/** File the issue. The repo is checked first, at the wire, so a development box's fixture report cannot reach the
 *  public tracker. A labelled create refused with 403/422 is retried ONCE without labels; the retry is gated on
 *  status since the refusal body may not mention labels. Cost: if the refused call did create, the retry files
 *  a duplicate. A call with no labels retries nothing. */
export async function createIssue(
  repo: string, title: string, body: string, labels: string[],
): Promise<IssueWriteResult<CreatedIssue>> {
  const postable = assertPostableRepo(repo);
  if (!postable.ok) return postable;
  const token = getGithubToken();
  if (!token) return { ok: false, error: NOT_CONNECTED };
  try {
    const res = await postIssue(repo, token, title, body, labels);
    if (!res.ok) {
      if (labels.length === 0 || !LABEL_RETRY_STATUSES.has(res.status)) {
        return await reportRefusal('file the issue', res);
      }
      // No ledger write yet: a failure the retry may disprove would flag a working connection as broken.
      const refusal = await readRefusal(res);
      logger.warn('github refused the labelled issue; asking again with no labels', {
        labels: labels.join(', '), detail: refusalDetail(refusal),
      });
      const bare = await postIssue(repo, token, title, body, []);
      if (!bare.ok) return await reportRefusal('file the issue', bare);
      return await readCreated(bare, labelsDroppedNote(labels, refusal));
    }
    // Accepted does not mean the labels were kept (a non-writer's create is saved unlabelled): read back.
    const accepted = await readCreated(res, null);
    if (!accepted.ok || labels.length === 0) return accepted;
    // The read-back is handed to the caller, not awaited: it must not sit between a public issue and the row that
    // records it, nor inside this `try` where an escape would turn a delivered report into `ok: false`.
    const issueNumber = accepted.number;
    return {
      ...accepted,
      measureLabels: () => labelsThatDidNotSurvive(repo, token, issueNumber, labels),
    };
  } catch (err) {
    return unreachable('file the issue', err);
  }
}

/** GitHub accepted it. One reader for both attempts, so neither can drift from the other. */
async function readCreated(
  res: Response, labelsDropped: string | null,
): Promise<IssueWriteResult<CreatedIssue>> {
  const answer = await res.json() as { number?: unknown; html_url?: unknown };
  if (typeof answer.number !== 'number' || typeof answer.html_url !== 'string') {
    return reportUnreadableAnswer('file the issue', res.status);
  }
  noteGithubOk();
  return { ok: true, number: answer.number, url: answer.html_url, labelsDropped, measureLabels: null };
}

export async function commentOnIssue(
  repo: string, issueNumber: number, body: string,
): Promise<IssueWriteResult<{ url: string }>> {
  const postable = assertPostableRepo(repo);
  if (!postable.ok) return postable;
  const token = getGithubToken();
  if (!token) return { ok: false, error: NOT_CONNECTED };
  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: writeHeaders(token),
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(ISSUE_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return await reportRefusal('add the comment', res);
    const answer = await res.json() as { html_url?: unknown };
    noteGithubOk();
    return { ok: true, url: typeof answer.html_url === 'string' ? answer.html_url : '' };
  } catch (err) {
    return unreachable('add the comment', err);
  }
}
