// The ONLY mint for a brokered resource: brokers get branded values, never the typed string, so
// "check one spelling, open another" cannot return. Absent argument: the gate does not apply (the
// handler's own friendlier error runs); a present non-string is REFUSED. Brands are private symbols.

import path from 'node:path';
import { canonicalizeAgentPath, resolveRealPathHardened } from '../path-resolve.js';
import { execInnerCommands } from '../exec-grammar.js';

declare const PATH_BRAND: unique symbol;
declare const COMMAND_BRAND: unique symbol;
declare const ARGV_BRAND: unique symbol;
declare const URL_BRAND: unique symbol;

/** BOTH spellings are kept on purpose: a deny matching only `lexical` is walked around with a
 *  symlink, a deny matching only `real` refuses a legit path whose parent is a link. Ask both. */
export interface ResolvedPath {
  readonly raw: string;
  /** `path.resolve(expandTilde(raw))`: absolute, `..` collapsed, NO symlinks. */
  readonly lexical: string;
  /** The deepest-existing-ancestor realpath, broken links followed. */
  readonly real: string;
  /** False when symlink resolution failed; callers under ~/.dojo fail closed. */
  readonly realResolved: boolean;
  readonly [PATH_BRAND]: true;
}

/** The INNER commands a shell construct actually runs: authority runs per inner command and the
 *  refusal names it; `inner` is empty for a plain line, which is then checked whole. */
export interface ResolvedCommand {
  readonly raw: string;
  readonly trimmed: string;
  readonly inner: readonly string[];
  readonly [COMMAND_BRAND]: true;
}

/** A program plus bytes handed to `execFile` untouched: no shell parses them, so there is no
 *  substitution to look inside, no redirect to follow, no construct to unpack. */
export interface ResolvedArgv {
  readonly argv: readonly string[];
  readonly program: string;
  /** `path.basename(program)`, what an allowlist entry like `git` matches. */
  readonly base: string;
  /** The vector joined with single spaces, FOR MATCHING AND MESSAGES ONLY. */
  readonly display: string;
  readonly [ARGV_BRAND]: true;
}

/** An absolute http(s) URL with its hostname pulled out once. */
export interface ResolvedUrl {
  readonly raw: string;
  readonly href: string;
  readonly hostname: string;
  readonly protocol: string;
  readonly [URL_BRAND]: true;
}

export type ResolveFailureCode = 'not_present' | 'not_a_string' | 'invalid_url';

export type Resolution<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ResolveFailureCode; readonly reason: string };

function absent(what: string): Resolution<never> {
  return { ok: false, code: 'not_present', reason: `no ${what} was supplied` };
}

function notAString(what: string, raw: unknown): Resolution<never> {
  return {
    ok: false,
    code: 'not_a_string',
    reason: `${what} must be a string, got ${Array.isArray(raw) ? 'an array' : typeof raw}`,
  };
}

function asPresentString(raw: unknown, what: string): Resolution<string> {
  if (raw === undefined || raw === null) return absent(what);
  if (typeof raw !== 'string') return notAString(what, raw);
  if (raw.trim().length === 0) return absent(what);
  return { ok: true, value: raw };
}

/** Mint a `ResolvedPath`. The ONLY place one comes from. */
export function resolvePathArg(raw: unknown): Resolution<ResolvedPath> {
  const str = asPresentString(raw, 'path');
  if (!str.ok) return str;
  const lexical = canonicalizeAgentPath(str.value);
  const { path: real, resolved } = resolveRealPathHardened(str.value);
  return {
    ok: true,
    value: { raw: str.value, lexical, real, realResolved: resolved } as unknown as ResolvedPath,
  };
}

export function resolveCommandArg(raw: unknown): Resolution<ResolvedCommand> {
  const str = asPresentString(raw, 'command');
  if (!str.ok) return str;
  const trimmed = str.value.trim();
  const inner = execInnerCommands(str.value);
  return {
    ok: true,
    value: { raw: str.value, trimmed, inner: inner ?? [] } as unknown as ResolvedCommand,
  };
}

/** Mint a `ResolvedArgv`, the only place one comes from. A STRING is `not_a_string` on purpose:
 *  re-parsing one into a vector is how the shell would come back. */
export function resolveArgvArg(raw: unknown): Resolution<ResolvedArgv> {
  if (raw === undefined || raw === null) return absent('argv');
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: 'not_a_string',
      reason: `argv must be an array of strings, got ${typeof raw === 'string' ? 'a string (exec no longer takes a shell command line — pass argv, or use the shell tool)' : typeof raw}`,
    };
  }
  if (raw.length === 0) return absent('argv');
  for (const element of raw) {
    if (typeof element !== 'string') {
      return {
        ok: false,
        code: 'not_a_string',
        reason: `every argv element must be a string, got ${Array.isArray(element) ? 'an array' : element === null ? 'null' : typeof element}`,
      };
    }
  }
  const argv = raw as string[];
  const program = argv[0];
  if (program.trim().length === 0) return absent('argv');
  return {
    ok: true,
    value: {
      argv,
      program,
      base: path.basename(program),
      display: argv.join(' '),
    } as unknown as ResolvedArgv,
  };
}

/** Mint a `ResolvedUrl`. A non-http(s) scheme is `invalid_url` at the mint. */
export function resolveUrlArg(raw: unknown): Resolution<ResolvedUrl> {
  const str = asPresentString(raw, 'url');
  if (!str.ok) return str;
  let u: URL;
  try {
    u = new URL(str.value);
  } catch {
    return { ok: false, code: 'invalid_url', reason: `"${str.value}" is not a valid URL` };
  }
  // WHATWG keeps the brackets on an IPv6 host; strip them once here so consumers see one spelling.
  const hostname = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
  return {
    ok: true,
    value: { raw: str.value, href: u.href, hostname, protocol: u.protocol } as unknown as ResolvedUrl,
  };
}

/** A fixed hostname the platform reaches unconditionally; `from: 'fixed:<host>'` resolves here. */
export function resolveFixedHost(host: string): ResolvedUrl {
  return { raw: host, href: `https://${host}/`, hostname: host, protocol: 'https:' } as unknown as ResolvedUrl;
}
