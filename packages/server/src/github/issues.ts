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
// ── A REFUSAL CARRIES GITHUB'S OWN EXPLANATION (T8 fix round) ──
// GitHub explains every refusal in its body, and the first cut of this module read the status
// line and threw the body away — so a live 403 left one sentence behind and debugging it was
// blind. Every non-OK answer from all three calls now goes through `refusal.ts` — which is also
// where the two authenticated doors' ledger write now happens: the log gets GitHub's words
// verbatim (including an unparseable body, labelled as such), the owner AND THE LEDGER get the
// plain sentence plus GitHub's `message` — C1, because six of `looksLikeAuthFailure`'s nine
// patterns match text only GITHUB writes and the old ledger line could not carry it, so a
// revoked scope read as a working connection — and nothing invents a cause.
//
// ── THE LABELS ARE BEST-EFFORT (T8 fix round) ──
// GitHub needs WRITE access to set `labels` on a new issue and none to OPEN one, so the
// always-labelled request `createIssue` used to send 403'd for every reporter who is not a
// collaborator on the destination repository. It now asks once more without them, and says so.
// The whole argument is on `createIssue`.
//
// ── NO `net-guard` ──
// The same call `google/`, `microsoft/`, `twilio/` and `gateway/routes/update.ts` all make:
// that guard exists for attacker-influenceable URLs. The host here is a fixed product
// constant and the repository is a validated `owner/name` slug from `report/repo.ts` — no
// model, agent or user input reaches either.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getGithubToken, noteGithubFailure, noteGithubOk } from './account.js';
import {
  githubsWords, readRefusal, refusalDetail, reportRefusal, reportUnreadableAnswer,
  type GithubRefusal,
} from './refusal.js';
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
  if (!res.ok) {
    // T8 fix round: the search used to throw a sentence built from the status code alone, and a
    // 403 was relabelled a rate limit WITHOUT LOOKING. The relabelling stays — on an
    // unauthenticated read a 403 is GitHub's rate limiter in practice, and the owner-facing
    // sentence should say something they can act on — but GitHub's own words now ride along in
    // the thrown error and land in the log, so a 403 that was something else is legible instead
    // of being silently reclassified. No ledger write: this call carries no credential, and a
    // rate-limited anonymous read says nothing about the owner's token (see the header).
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
 * The two statuses GitHub answers when it will not accept a FIELD of the payload from this
 * account: 403 for a permission it does not hold, 422 for a value it will not validate. Neither
 * creates an issue, so a second smaller request is a fresh attempt and never a duplicate.
 */
const LABEL_RETRY_STATUSES: ReadonlySet<number> = new Set([403, 422]);

/**
 * The one POST. `labels` is OMITTED ENTIRELY when empty rather than sent as `[]`: an empty array
 * is still an instruction to set this issue's labels, and the whole point of the second attempt is
 * to ask for nothing this account may not have.
 */
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

/**
 * What the owner is told when the labels did not survive: the EXPERIMENT, not a theory. The same
 * title, body and token were refused with labels and accepted without them — a controlled result,
 * with GitHub's own words riding along. Nothing here invents a cause.
 */
function labelsDroppedNote(labels: string[], refusal: GithubRefusal): string {
  return `The issue was filed WITHOUT its labels (${labels.join(', ')}). GitHub refused the `
    + `labelled version (HTTP ${refusal.status}) and accepted the same issue with the labels `
    + `removed, so this account can file here but cannot set labels here. ${githubsWords(refusal)} `
    + 'Nothing else changed: the `dojo-sig:` trailer in the body carries what triage needs.';
}

/**
 * File the issue. The repository is checked FIRST, at the wire, so no amount of code or
 * environment manipulation between a caller's decision and this call can put a development
 * box's fixture report on the Dojo's public tracker.
 *
 * ── THE LABELS ARE BEST-EFFORT, AND THAT IS A RELEASE BLOCKER'S FIX (T8) ──
 * GitHub requires WRITE access to set `labels` on a new issue and requires nothing at all to OPEN
 * one on a public repository. `post.ts` always passes labels and the list is never empty — it
 * always contains `dojo-report` — so the old request was one only a collaborator on the
 * destination repository could make. The owner met it live at 00:24Z on 2026-09-26: connected as
 * `dcliff9`, filing against a repository owned by `d-cornerpin`, 403, nothing posted. Every
 * ordinary user of a shipped Dojo stands in that same relation to `d-cornerpin/dojo`, and a
 * reporting feature only its own maintainers can use is not a reporting feature. So: ask with the
 * labels; if that is refused on a status GitHub uses for a field it will not take, ask ONCE more
 * without them. The labels are triage convenience and the `dojo-sig:` trailer in the BODY already
 * carries the identity triage actually keys on.
 *
 * ── A MEASUREMENT, NOT A PREDICTION — WHICH IS WHY IT IS A RETRY AND NOT A PRE-CHECK ──
 * A permission pre-check costs a call on the HAPPY path and asks a different question than the one
 * that matters (`permissions.push` on a repository is not "may I label an issue"). The retry
 * ANSWERS the question instead: either the smaller request succeeds, and the labels provably were
 * the obstacle, or it fails, and the owner gets GitHub's own words about a refusal that had
 * nothing to do with labels. Nothing is ever inferred from a status code alone.
 *
 * ── AND WHY THE TRIGGER IS THE STATUS, NOT A BODY THAT MENTIONS LABELS ──
 * The one place this diverges from the brief's literal wording, deliberately. The live 403's body
 * has never been seen — capturing it is what the sibling fix round exists for — so a retry gated
 * on GitHub's prose containing "label" might simply not fire against the defect it was written
 * for. Status + "labels were actually sent" cannot miss, and cannot misreport either: a 403 about
 * something else fails honestly one refused POST later, carrying GitHub's sentence for the
 * label-less attempt, the request that asked for the least. Being wrong here costs one refused
 * POST; the narrow version being wrong costs the release blocker. The control is that a call
 * carrying NO labels retries nothing at all.
 */
export async function createIssue(
  repo: string, title: string, body: string, labels: string[],
): Promise<IssueWriteResult<{ number: number; url: string; labelsDropped: string | null }>> {
  const postable = assertPostableRepo(repo);
  if (!postable.ok) return postable;
  const token = getGithubToken();
  if (!token) return { ok: false, error: NOT_CONNECTED };
  try {
    const res = await postIssue(repo, token, title, body, labels);
    if (!res.ok) {
      // NOTHING TO DROP, OR NOT A REFUSAL A SMALLER REQUEST COULD SURVIVE: fail honestly, here,
      // with GitHub's own explanation. This is the control branch and it performs ONE call.
      if (labels.length === 0 || !LABEL_RETRY_STATUSES.has(res.status)) {
        return await reportRefusal('file the issue', res);
      }
      // The body is read for the LOG and for the owner's note. No ledger write yet: the attempt
      // is not over, and recording a failure the next line may disprove is how a working
      // connection ends up flagged broken.
      const refusal = await readRefusal(res);
      logger.warn('github refused the labelled issue; asking again with no labels', {
        labels: labels.join(', '), detail: refusalDetail(refusal),
      });
      const bare = await postIssue(repo, token, title, body, []);
      // The second refusal is the one reported: it is the answer to the SMALLEST request this
      // module can make, so its sentence is the honest account of "this could not be filed".
      if (!bare.ok) return await reportRefusal('file the issue', bare);
      return await readCreated(bare, labelsDroppedNote(labels, refusal));
    }
    return await readCreated(res, null);
  } catch (err) {
    return unreachable('file the issue', err);
  }
}

/** GitHub accepted it. One reader for both attempts, so neither can drift from the other. */
async function readCreated(
  res: Response, labelsDropped: string | null,
): Promise<IssueWriteResult<{ number: number; url: string; labelsDropped: string | null }>> {
  const answer = await res.json() as { number?: unknown; html_url?: unknown };
  if (typeof answer.number !== 'number' || typeof answer.html_url !== 'string') {
    return reportUnreadableAnswer('file the issue', res.status);
  }
  noteGithubOk();
  return { ok: true, number: answer.number, url: answer.html_url, labelsDropped };
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
    if (!res.ok) return await reportRefusal('add the comment', res);
    const answer = await res.json() as { html_url?: unknown };
    noteGithubOk();
    return { ok: true, url: typeof answer.html_url === 'string' ? answer.html_url : '' };
  } catch (err) {
    return unreachable('add the comment', err);
  }
}
