// What GitHub said when it refused, reported verbatim and never diagnosed: no status-to-cause mapping, and an
// unreadable body is said to be unreadable. `githubsWords` is owner-facing (GitHub's `message` plus help link, never
// the raw body); `refusalDetail` is log-facing. Nothing here reads the credential (inputs: a `Response`, a status).

import { noteGithubFailure } from './account.js';
import { createLogger } from '../logger.js';

const logger = createLogger('github-refusal');

/** Characters of an unreadable body a log line carries (bounded: failing bodies are long error pages). */
export const REFUSAL_RAW_MAX = 300;

/** The honest phrase for 'answered, but no readable reason': an absence of evidence, never a cause. */
export const NO_EXPLANATION = 'GitHub sent no readable explanation';

export interface GithubRefusal {
  status: number;
  message: string | null;
  documentationUrl: string | null;
  /** The body as it arrived, bounded to `REFUSAL_RAW_MAX`. Log only. */
  raw: string;
}

function parsedBody(raw: string): unknown {
  if (raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function statedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Reads a non-OK response. Consumes the body, so call it once per refused response; any read or parse
 *  failure becomes `message: null` so the refusal is still reported. */
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

/** GitHub's own sentence for the owner, or an honest absence; never a guess or the raw body. */
export function githubsWords(refusal: GithubRefusal): string {
  if (refusal.message === null) return `${NO_EXPLANATION}.`;
  const doc = refusal.documentationUrl === null ? '' : ` (${refusal.documentationUrl})`;
  return `GitHub said: ${refusal.message}${doc}`;
}

/** Everything GitHub said, for the log; an unparsed body slice is labelled as such. */
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

/** Logs a refusal from an authenticated call in full, records the plain sentence plus GitHub's `message` on the
 *  connection ledger (the text `looksLikeAuthFailure` reads), and returns it for the card. */
export async function reportRefusal(
  what: string, res: Response,
): Promise<{ ok: false; error: string }> {
  const refusal = await readRefusal(res);
  const recorded = `GitHub refused to ${what} (HTTP ${refusal.status}). ${githubsWords(refusal)}`;
  logger.warn(`github refused to ${what}`, { detail: refusalDetail(refusal) });
  noteGithubFailure(recorded);
  return { ok: false, error: recorded };
}

/** GitHub accepted the call but answered a shape the caller cannot read. Not a refusal: the outcome is unknown
 *  (the issue may exist), so it is reported as unreadable. */
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
