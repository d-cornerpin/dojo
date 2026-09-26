// ════════════════════════════════════════════════════════════════════════════════════════
// THE FOUR CALLS THAT REACH GITHUB'S ISSUES (DOJO-REPORT T7, T8).
//
// Two READS and two authenticated WRITES. Nothing here decides anything: the
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
// GitHub needs WRITE access to set `labels` on a new issue and none to OPEN one. If it refuses
// the labelled request, `createIssue` asks once more without them and says so. The whole
// argument is on `createIssue`.
//
// ── AND GITHUB USUALLY DOES NOT REFUSE. IT ACCEPTS AND DISCARDS (T8 LIVE, D-B) ──
// Measured on the wire, 2026-09-26: the platform sent `labels:["dojo-report","v0.0.0"]`, GitHub
// answered **201**, and the created issue has **no labels**. GitHub's REST reference for
// *Create an issue* says so in its own words — *"Only users with push access can set labels for
// new issues. Labels are silently dropped otherwise."* So the retry above has NEVER FIRED for
// the case it was written for (0 hits over the whole live log and its rotation, including the
// owner's issue #3, whose empty labels an earlier hand-off wrongly attributed to it — THAT
// CLAIM IS WITHDRAWN), the owner was told nothing, and `labelsDropped` was null on the one path
// that actually loses them. Every successful create that ASKED for labels is now READ BACK and
// compared with what was sent; a difference is recorded as a difference and nothing more.
// `labelsThatDidNotSurvive` carries the reasoning, including why a read-back rather than the
// 201 body nobody captured.
//
// ── SO TRIAGE MUST NOT KEY ON THE LABEL, AND DOES NOT HAVE TO ──
// Every report filed by a NON-COLLABORATOR — which is every ordinary user filing against
// `d-cornerpin/dojo` — arrives unlabelled. A `dojo-report` label sweep finds none of them, and
// that is not a bug to fix here: it is GitHub's rule. **THE RELIABLE TRIAGE PATH IS A SEARCH ON
// THE `dojo-sig:` TRAILER**, which `report/issue-body.ts` writes into the body GitHub accepts in
// full — `is:issue "ds1-…"` for one report, `is:issue "dojo-sig:"` for the intake sweep. It is
// the same key `findIssueBySignature` dedupes on, so the habit and the product read one key. The
// label stays because it works for collaborators and costs nothing when it does not.
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

/** The headers an AUTHENTICATED call carries. The token is read here and nowhere else. */
function authHeaders(token: string): Record<string, string> {
  return { ...API_HEADERS, Authorization: `Bearer ${token}` };
}

/** The headers a WRITE carries. */
function writeHeaders(token: string): Record<string, string> {
  return { ...authHeaders(token), 'Content-Type': 'application/json' };
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
 * THE LABELS THE CREATED ISSUE ACTUALLY HAS — or `null`, meaning NOT MEASURED.
 *
 * `null` is never "none". A read-back that 404s, 500s, answers an HTML error page or answers an
 * issue with no `labels` array tells us nothing, and reporting nothing is the only honest move:
 * "your labels were dropped" is a claim, and a claim nobody measured is what this whole fix
 * round exists to remove. One call, bounded by the same timeout as the writes, best-effort —
 * the report has already landed and no failure here may take that back.
 *
 * NO LEDGER WRITE, deliberately. The WRITE succeeded one line earlier, so the credential
 * demonstrably works; `github/status.ts`'s `looksLikeAuthFailure` reads the ledger to decide
 * whether to tell the owner their connection is broken, and a failed read of our own issue
 * after a successful post is exactly the false YES the T5 fix round was spent on.
 *
 * Both spellings of `labels` are read. GitHub's schemas give it as objects (`{id, name, …}`) on
 * the issue representation and as bare strings elsewhere; understanding only one would report a
 * total drop on every collaborator's issue, which is a false alarm on the majority case.
 */
async function labelsOnIssue(repo: string, token: string, issueNumber: number): Promise<string[] | null> {
  const cannotTell = (why: string): null => {
    logger.warn('could not read the labels back off the issue that was just filed', { issueNumber, why });
    return null;
  };
  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(ISSUE_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return cannotTell(`GitHub answered HTTP ${res.status}`);
    const answer = await res.json() as { labels?: unknown };
    if (!Array.isArray(answer.labels)) return cannotTell('the answer carried no `labels` array');
    return answer.labels
      .map(l => (typeof l === 'string' ? l : (l as { name?: unknown } | null)?.name))
      .filter((n): n is string => typeof n === 'string' && n !== '');
  } catch (err) {
    return cannotTell(err instanceof Error ? err.message : String(err));
  }
}

/**
 * What the owner is told when GitHub took the labels and then did not keep them: the MEASURED
 * DIFFERENCE first, then GitHub's own documented rule as the explanation — cited, not inferred.
 * A partial drop names only what is actually missing, because a report that kept `dojo-report`
 * and lost `v3.1.28` is still in a label sweep and out of every version-filtered view.
 */
function silentlyDroppedNote(sent: string[], kept: string[], dropped: string[]): string {
  return `Your report posted. It asked for the label${sent.length === 1 ? '' : 's'} `
    + `${sent.join(', ')}, and GitHub saved the issue `
    + `${kept.length === 0 ? 'with no labels at all' : `with only ${kept.join(', ')}`} — `
    + `${dropped.join(', ')} ${dropped.length === 1 ? 'was' : 'were'} dropped. GitHub does that `
    + 'when the account filing has no write access to the repository; its own reference for '
    + 'creating an issue says labels "are silently dropped otherwise". Only someone with write '
    + 'access can add them now, and nothing triage needs is missing: the `dojo-sig:` trailer is '
    + 'in the issue body, which is what a search finds this report by.';
}

/**
 * The read-back, as one step: measure, compare, and answer the sentence or `null`.
 *
 * The comparison is the property. A version of this that merely asked "does the issue have any
 * labels" would miss a partial drop, and one that trusted the request would never fire at all —
 * which is the state that shipped.
 */
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

/**
 * File the issue. The repository is checked FIRST, at the wire, so no amount of code or
 * environment manipulation between a caller's decision and this call can put a development
 * box's fixture report on the Dojo's public tracker.
 *
 * ── THE LABELS ARE BEST-EFFORT, AND THAT IS A RELEASE BLOCKER'S FIX (T8) ──
 * GitHub requires WRITE access to set `labels` on a new issue and requires nothing at all to OPEN
 * one on a public repository. `post.ts` always passes labels and the list is never empty — it
 * always contains `dojo-report` — so the old request was one only a collaborator on the
 * destination repository could make. The owner met a 403 live at 00:24Z on 2026-09-26: connected
 * as `dcliff9`, filing against a repository owned by `d-cornerpin`, nothing posted. So: ask with
 * the labels; if that is refused on a status GitHub uses for a field it will not take, ask ONCE
 * more without them. The labels are triage convenience and the `dojo-sig:` trailer in the BODY
 * already carries the identity triage actually keys on.
 *
 * ── THE RETRY'S FATE, ADJUDICATED ON THE MEASUREMENT (T8 LIVE, D-B) ──
 * It has never fired. GitHub's answer to a non-collaborator's labelled create is 201-and-discard,
 * not a refusal, so the mechanism this retry was built for does not reach it — and the earlier
 * claim that it explained the owner's unlabelled issue #3 is WITHDRAWN. IT STAYS ANYWAY, and the
 * argument is reachability rather than frequency: the 00:24Z 403 above was REAL, its body was
 * never captured, and Phase B's finding puts its cause at *unknown* — explicitly not "labels".
 * Deleting the one branch that turns an unexplained 403 on a labelled create into a delivered
 * report, on the evidence that it has not fired since, would confuse "has not happened lately"
 * with "cannot happen", and would re-plant a release blocker on a guess. Cost of keeping it: one
 * extra POST on a create GitHub already refused, bounded at one, four branches of it held by
 * clauses with dead mutants. What the measurement DOES buy is a DEMOTION — the retry is no longer
 * the platform's account of a missing label, because it never was; the read-back is.
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
      // NO READ-BACK ON THIS ARM. The request that succeeded sent no labels, so there is nothing
      // to compare and the retry's own controlled sentence is the whole account.
      return await readCreated(bare, labelsDroppedNote(labels, refusal));
    }
    // GITHUB ACCEPTED IT — WHICH DOES NOT MEAN IT KEPT THE LABELS. See the header: a create from
    // an account without write access is answered 201 and saved unlabelled, silently. Ask.
    const accepted = await readCreated(res, null);
    if (!accepted.ok || labels.length === 0) return accepted;
    return {
      ...accepted,
      labelsDropped: await labelsThatDidNotSurvive(repo, token, accepted.number, labels),
    };
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
