// ════════════════════════════════════════════════════════════════════════════════════════
// THE THREE CALLS THAT REACH GITHUB'S ISSUES (DOJO-REPORT T7).
//
// One unauthenticated READ and two authenticated WRITES. Nothing here decides anything: the
// decision — whether this report may leave at all — was made by the owner on the preview card
// and is held by the one-shot approval in `report/store.ts`. This module is the wire.
//
// ── THE READ IS UNAUTHENTICATED, AND THAT IS THE SPEC ──
// The duplicate check runs against the public search API with no credential attached. It reads
// a public tracker, it needs no permission to do so, and sending the owner's token to an
// endpoint that does not need it is a token spent for nothing. A clause asserts the search
// request carries no `Authorization` header.
//
// ── A FAILED SEARCH THROWS; IT NEVER ANSWERS `null` ──
// `null` from `findIssueBySignature` means ONE thing: GitHub answered, and there is no open
// issue carrying this signature. A search that 500s, times out or is rate-limited must never
// be indistinguishable from that, because the caller's next move on `null` is to FILE AN
// ISSUE. "We could not check, so we filed another copy" is how one defect becomes nine threads
// on a public tracker. The caller catches and reports honestly; it does not post.
//
// ── THE LEDGER (T4/T5's hand-off), AND THE ONE SENTENCE THAT MUST NOT DRIFT ──
// `noteGithubOk`/`noteGithubFailure` are the ONLY writers of the connection's last live
// outcome, and `github/status.ts`'s `looksLikeAuthFailure` READS what is written here to
// decide whether to tell the owner their connection is broken. Two rules follow, and both are
// held by clauses:
//   * only the AUTHENTICATED calls write the ledger. A rate-limited anonymous search says
//     nothing whatsoever about the owner's credential, and recording it as a live failure
//     would put "reconnect" in front of someone whose connection is fine.
//   * NO ISSUE NUMBER EVER ENTERS A FAILURE MESSAGE. Issue numbers are this module's whole
//     domain, and `looksLikeAuthFailure` has to read a bare number as a status code in some
//     shapes. "Could not comment on issue 401" is exactly the false positive T5's fix round
//     was spent on. The column carries the platform's verdict about the CALL, never an
//     identifier from its payload.
//
// ── NO `net-guard` ──
// The same call `google/`, `microsoft/`, `twilio/` and `gateway/routes/update.ts` all make:
// that guard exists for attacker-influenceable URLs. The host here is a fixed product
// constant and the repository is a validated `owner/name` slug from `report/repo.ts` — no
// model, agent or user input reaches either.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getGithubToken, noteGithubFailure, noteGithubOk } from './account.js';
import { assertPostableRepo } from '../report/repo.js';
import { createLogger } from '../logger.js';

const logger = createLogger('github-issues');

export const GITHUB_API = 'https://api.github.com';

/**
 * Bound on ONE HTTP call. NOT a retry budget: a call that trips this ends the attempt and the
 * owner is told, which is NO-DOOMED-DIALS P3 — the next attempt is a human pressing Post
 * again, never a background re-dial. (Census row 40.)
 */
export const ISSUE_HTTP_TIMEOUT_MS = 10_000;

const API_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

const NOT_CONNECTED = 'GitHub is not connected on this box, so nothing was sent.';
const RATE_LIMITED = 'GitHub is rate-limiting the duplicate check right now. Try again in a minute.';

export interface IssueMatch { number: number; url: string; title: string }

/** The search the plan pins: the BARE digest, not a quoted `dojo-sig:` phrase. */
export function issueSearchUrl(repo: string, signature: string): string {
  const q = `repo:${repo} is:issue "${signature}"`;
  return `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&sort=created&order=asc&per_page=5`;
}

/** One search hit, as much of it as this module is willing to believe. */
interface SearchItem { number?: unknown; title?: unknown; html_url?: unknown; state?: unknown; body?: unknown }

/**
 * The OLDEST OPEN issue whose body actually carries this signature, or `null`.
 *
 * Two filters beyond the query, both fail-closed:
 *   * `state === 'open'` — a closed issue is a defect somebody already fixed, and commenting on
 *     it would bury the report.
 *   * the body must REALLY contain the signature. GitHub's search tokenizer is fuzzy, and the
 *     cost of trusting it is the owner's words appended to a stranger's issue. Missing the
 *     match instead costs a duplicate, which a human can merge.
 *
 * THROWS on any failure. See the header: `null` means "checked, nothing there", and nothing else.
 */
export async function findIssueBySignature(repo: string, signature: string): Promise<IssueMatch | null> {
  const res = await fetch(issueSearchUrl(repo, signature), {
    headers: API_HEADERS,
    signal: AbortSignal.timeout(ISSUE_HTTP_TIMEOUT_MS),
  });
  if (res.status === 403 || res.status === 429) throw new Error(RATE_LIMITED);
  if (!res.ok) {
    throw new Error(`GitHub could not check for an existing report (HTTP ${res.status}).`);
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

/** A refusal GitHub stated. Recorded for the card AND for the connection ledger, verbatim. */
function refused(what: string, status: number): { ok: false; error: string } {
  const error = `GitHub refused to ${what} (HTTP ${status}).`;
  noteGithubFailure(error);
  return { ok: false, error };
}

/** A call that never got an answer: a dead socket, a timeout, an HTML page where JSON was due. */
function unreachable(what: string, err: unknown): { ok: false; error: string } {
  const detail = err instanceof Error ? err.message : String(err);
  const error = `Could not reach GitHub to ${what}: ${detail}`;
  logger.warn(`github issue call failed: ${what}`, { error: detail });
  noteGithubFailure(error);
  return { ok: false, error };
}

/** The headers a WRITE carries. The token is read here and nowhere else in this module. */
function writeHeaders(token: string): Record<string, string> {
  return { ...API_HEADERS, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/**
 * File the issue. The repository is checked FIRST, at the wire, so no amount of code or
 * environment manipulation between a caller's decision and this call can put a development
 * box's fixture report on the Dojo's public tracker.
 */
export async function createIssue(
  repo: string, title: string, body: string, labels: string[],
): Promise<IssueWriteResult<{ number: number; url: string }>> {
  const postable = assertPostableRepo(repo);
  if (!postable.ok) return postable;
  const token = getGithubToken();
  if (!token) return { ok: false, error: NOT_CONNECTED };
  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/issues`, {
      method: 'POST',
      headers: writeHeaders(token),
      body: JSON.stringify({ title, body, labels }),
      signal: AbortSignal.timeout(ISSUE_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return refused('file the issue', res.status);
    const answer = await res.json() as { number?: unknown; html_url?: unknown };
    if (typeof answer.number !== 'number' || typeof answer.html_url !== 'string') {
      return refused('file the issue', res.status);
    }
    noteGithubOk();
    return { ok: true, number: answer.number, url: answer.html_url };
  } catch (err) {
    return unreachable('file the issue', err);
  }
}

/** Add this report to an issue that already exists. Same gate, same ledger, same silence about numbers. */
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
    if (!res.ok) return refused('add the comment', res.status);
    const answer = await res.json() as { html_url?: unknown };
    noteGithubOk();
    return { ok: true, url: typeof answer.html_url === 'string' ? answer.html_url : '' };
  } catch (err) {
    return unreachable('add the comment', err);
  }
}
