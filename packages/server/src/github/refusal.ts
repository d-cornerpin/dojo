// ════════════════════════════════════════════════════════════════════════════════════════
// WHAT GITHUB SAID WHEN IT REFUSED (DOJO-REPORT T8 fix round).
//
// ── THE INCIDENT THIS MODULE EXISTS BECAUSE OF ──
// A live run, the owner at his browser, Post pressed on one report. The card said *"GitHub
// refused to file the issue (HTTP 403)"* and that sentence was the ONLY thing this box kept.
// GitHub had explained itself in the response body — it always does, in a `message` field:
// a missing scope, a resource not accessible by the token, a rate limit — and the poster read
// the status line, dropped the body on the floor, and logged nothing whatsoever.
//
// Debugging was therefore blind, and the cost was paid in elimination: the repository had to be
// proven public with issues open and not archived, the account had to be proven able to file an
// issue there by hand, and both sides had to be proven not to be organisations. Every one of
// those checks was answering a question the discarded witness had already answered.
//
// ── THE RULE THIS MODULE HOLDS ──
// GitHub's words are EVIDENCE, and evidence is reported verbatim. This module never diagnoses.
// It does not map a status code to a cause, it does not guess at a missing scope, and when the
// body cannot be read it SAYS the body could not be read rather than filling the hole with a
// plausible story. A fabricated reason is strictly worse than no reason: no reason sends the
// next reader to the evidence, and a wrong one sends them somewhere the evidence never pointed.
//
// ── THE TWO AUDIENCES, AND WHY THE SPLIT LIVES HERE RATHER THAN AT EACH CALL SITE ──
//   `githubsWords`  — OWNER-FACING. Plain English: GitHub's own `message` sentence, its help
//                     link when it sent one, and nothing else. NEVER the raw body — an HTML
//                     error page pasted onto a dashboard card is not plain English, and the
//                     house rule about owner-facing text is not suspended by a bad day.
//   `refusalDetail` — LOG-FACING. Everything that arrived, including a bounded verbatim slice
//                     of a body that would not parse, because that slice is the whole value of
//                     a log line for a failure nobody can reproduce on demand.
//
// ── THE TOKEN ──
// Nothing here reads the credential and nothing here can: the only inputs are a `Response` and a
// status code. That is worth stating rather than assuming, because the log lines this module
// emits are composed one frame below code that HAS the token in scope, and T4's positive-proof
// rule says a containment claim is proven by a sweep and not by a paragraph. The sweep that
// proves it is `__tests__/a-refusal-carries-githubs-own-explanation.test.ts`, run over every
// emitted line of every door.
// ════════════════════════════════════════════════════════════════════════════════════════

import { noteGithubFailure } from './account.js';
import { createLogger } from '../logger.js';

const logger = createLogger('github-refusal');

/**
 * How much of an unreadable body a LOG line carries. Bounded because the bodies that fail to
 * parse are the long ones — a proxy's HTML error page, a gateway's stack trace.
 */
export const REFUSAL_RAW_MAX = 300;

/**
 * The honest phrase for "GitHub answered, and we could not read why". It names an ABSENCE of
 * evidence and never a cause; every caller that has no `message` says exactly this and stops.
 */
export const NO_EXPLANATION = 'GitHub sent no readable explanation';

/** What GitHub said about a refusal. Every field is GitHub's own, or null. Nothing is derived. */
export interface GithubRefusal {
  /** The HTTP status GitHub answered with. */
  status: number;
  /** GitHub's own `message`, trimmed, or null when the body carried none this box could read. */
  message: string | null;
  /** GitHub's own `documentation_url`, or null. */
  documentationUrl: string | null;
  /**
   * The body as it arrived, bounded to `REFUSAL_RAW_MAX`. Empty when nothing arrived.
   * LOG ONLY — `githubsWords` never touches it, and the reason is in the header.
   */
  raw: string;
}

/** JSON or nothing. A body that will not parse is a FACT to report, not an error to raise. */
function parsedBody(raw: string): unknown {
  if (raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** A string GitHub actually put there, or null. Blank is the same as absent. */
function statedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Read a non-OK response for GitHub's explanation of itself.
 *
 * CONSUMES THE BODY, so it is called exactly once per refused response, on a path that has
 * already decided the call failed. Every way of failing to read is absorbed into
 * `message: null`: a refusal we could not parse must still be REPORTED, and throwing from here
 * would replace GitHub's refusal with our own parse error — losing the original evidence for a
 * second time, in the very function written to stop losing it.
 */
export async function readRefusal(res: Response): Promise<GithubRefusal> {
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    raw = '';
  }
  const body = parsedBody(raw);
  const fields = (typeof body === 'object' && body !== null)
    ? body as { message?: unknown; documentation_url?: unknown }
    : {};
  return {
    status: res.status,
    message: statedString(fields.message),
    documentationUrl: statedString(fields.documentation_url),
    raw: raw.slice(0, REFUSAL_RAW_MAX),
  };
}

/**
 * GitHub's own sentence, for the owner. Plain English, or an honest absence. Never a guess and
 * never the raw body.
 */
export function githubsWords(refusal: GithubRefusal): string {
  if (refusal.message === null) return `${NO_EXPLANATION}.`;
  const doc = refusal.documentationUrl === null ? '' : ` (${refusal.documentationUrl})`;
  return `GitHub said: ${refusal.message}${doc}`;
}

/**
 * Everything GitHub said, for the log: the status, the message verbatim, the help link, and —
 * when the body would not parse — a bounded slice of it exactly as it arrived, LABELLED as
 * unparsed so that no reader can mistake the slice for a diagnosis of the failure.
 */
export function refusalDetail(refusal: GithubRefusal): string {
  const head = `HTTP ${refusal.status}`;
  if (refusal.message !== null) {
    const doc = refusal.documentationUrl === null
      ? '' : ` documentation_url=${refusal.documentationUrl}`;
    return `${head}; GitHub said: ${refusal.message}${doc}`;
  }
  const slice = refusal.raw.trim();
  if (slice === '') return `${head}; ${NO_EXPLANATION} (the body was empty).`;
  return `${head}; ${NO_EXPLANATION} (the body would not parse). Body verbatim, first `
    + `${REFUSAL_RAW_MAX} bytes: ${slice}`;
}

/**
 * Report a refusal an AUTHENTICATED call received: log it in full, record it on the connection
 * ledger, and hand the caller the sentence its card will show.
 *
 * ── TWO DESTINATIONS, AND THE LEDGER NOW CARRIES WHAT THE PREDICATE READS ──
 *   LOG            — EVERYTHING GitHub said, verbatim, including a body that would not parse.
 *                    This is the half that was missing, and the whole reason this module exists.
 *   CARD + LEDGER  — ONE sentence: the plain statement PLUS GitHub's own `message`, via
 *                    `githubsWords` and no second reader. The owner is the only person who can
 *                    re-grant a scope, and they cannot fix what nobody tells them. GitHub's
 *                    `message` is provider text, not user content, so the scrub boundary is not
 *                    crossed by putting it in front of them; an unreadable body degrades to the
 *                    honest absence phrase, never to a raw HTML slice, which is log-only.
 *
 * ── WHY THE LEDGER LINE CHANGED (C1) ──
 * The first cut of this module kept the ledger line at T7's status-code sentence on purpose,
 * because `github/status.ts`'s `looksLikeAuthFailure` reads that column and feeding provider
 * prose into a predicate looked like an auth-behaviour change to defer. Deferring it left a
 * WORSE state than either end: SIX of that predicate's nine patterns — `bad credentials`,
 * `unauthorized`, `requires authentication`, `required scopes`, `insufficient scope`,
 * `not accessible by personal access token` — are strings GITHUB writes, in bodies that had no
 * route to the column. They were unreachable code. T5 built a reader for input the ledger was
 * never fed, and the consequence is not cosmetic: GitHub refuses a missing scope with a 403 and
 * the sentence `Resource not accessible by personal access token`, the old ledger line said only
 * `(HTTP 403)`, no pattern matched, and the Settings card told an owner whose token could no
 * longer file anything that the connection was fine.
 *
 * The 401 case masked it. `(HTTP 401)` matches the status-word anchor, so the one shape anybody
 * tested worked and the six prose patterns were never missed.
 *
 * THE ERROR DIRECTION IS UNCHANGED AND WAS RE-MEASURED AGAINST THIS NEW INPUT CLASS. A false YES
 * — telling an owner a working connection is broken — is still what the predicate is narrow
 * against, so every real transient body GitHub sends (both rate-limit spellings, 429, 500, 502,
 * 404, 410, 422, archived, SAML, IP allow list) is a row in the fixture table asserting NO, and
 * the unreachable-socket path in `issues.ts` never comes through here at all.
 *
 * `issues.ts`'s no-issue-number rule is unaffected: the addition is GITHUB's sentence about the
 * call, not an identifier from this box's payload.
 */
export async function reportRefusal(
  what: string, res: Response,
): Promise<{ ok: false; error: string }> {
  const refusal = await readRefusal(res);
  const recorded = `GitHub refused to ${what} (HTTP ${refusal.status}). ${githubsWords(refusal)}`;
  logger.warn(`github refused to ${what}`, { detail: refusalDetail(refusal) });
  noteGithubFailure(recorded);
  return { ok: false, error: recorded };
}

/**
 * GitHub ACCEPTED the call and answered a shape the caller cannot read. That is NOT a refusal
 * and must not be reported as one: the sentence here used to be `GitHub refused to file the
 * issue (HTTP 201)` — a cause invented from a status code that said the opposite, the same
 * family of fabrication this module exists to end. The honest statement is that the outcome is
 * UNKNOWN, because the issue may well exist and what this box cannot do is say where.
 */
export function reportUnreadableAnswer(
  what: string, status: number,
): { ok: false; error: string } {
  const recorded = `GitHub's answer could not be read (HTTP ${status}).`;
  logger.warn(`github answered with a shape this box cannot read: ${what}`, { status });
  noteGithubFailure(recorded);
  return {
    ok: false,
    error: `${recorded} The report may or may not have reached the tracker — check it before `
      + 'sending again.',
  };
}
