// ════════════════════════════════════════════════════════════════════════════
// THE RESOLVER (PHASE-5 T2 Step 2) — the ONLY mint for a brokered resource.
//
// A broker never sees a raw argument. It sees a `ResolvedPath`, a
// `ResolvedCommand` or a `ResolvedUrl`, and the only way to obtain one is to
// call this module. That is the whole point of the brand: the type system
// refuses to let a caller hand `authorize()` the string the model typed, so the
// "check one spelling, open another" class of defect — a `..` traversal, a
// symlink, a case fold — cannot be re-introduced by forgetting a step.
//
// ── THE TRUTHINESS SKIP DIES HERE (plan T2 Step 3) ──
// The ladder read `args.path as string | undefined` and then `if (filePath)`.
// That cast was a lie the compiler could not see: a caller could pass an array
// or an object, the truthiness test passed, and `path.resolve` threw — so the
// class was a CRASH, never a bypass. Resolution now answers with three distinct
// verdicts and the dispatcher treats them differently:
//
//   ok               → a branded resource; the gate applies.
//   `not_present`    → the argument is absent (undefined / null / empty string).
//                      The gate DOES NOT APPLY, which is exact parity with
//                      `if (filePath)`: the handler goes on to produce its own
//                      friendlier "Path must be absolute" error. Preserving this
//                      is the difference between a tidy-up and a narrowing.
//   `not_a_string`   → the argument is present and is not a string. REFUSED.
//                      It replaces a crash; nothing that used to work stops.
//
// ── BRANDS ──
// `PATH_BRAND` and friends are module-private `unique symbol`s. No module
// outside this file can construct a value that satisfies the interface — only
// cast to it, which is visible in review and covered by a conformance clause in
// `broker-contract.test.ts`.
// ════════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import { canonicalizeAgentPath, resolveRealPathHardened } from '../path-resolve.js';
import { execInnerCommands } from '../exec-grammar.js';

declare const PATH_BRAND: unique symbol;
declare const COMMAND_BRAND: unique symbol;
declare const ARGV_BRAND: unique symbol;
declare const URL_BRAND: unique symbol;

/**
 * An absolute, tilde-expanded, `..`-collapsed path, carried together with its
 * symlink-resolved target.
 *
 * BOTH spellings are kept on purpose. A deny that matches only `lexical` is
 * walked around with a symlink; a deny that matches only `real` would refuse a
 * legitimate path whose parent directory happens to be a link. Every fs rule
 * therefore gets asked about both, and the verdict records which one bit — that
 * is what lets T2's staging tell a parity refusal from a hardening refusal.
 */
export interface ResolvedPath {
  /** Exactly what the caller passed, for messages. */
  readonly raw: string;
  /** `path.resolve(expandTilde(raw))` — absolute, `..` collapsed, NO symlinks. */
  readonly lexical: string;
  /** The deepest-existing-ancestor realpath, broken links followed. */
  readonly real: string;
  /** False when symlink resolution failed; callers under ~/.dojo fail closed. */
  readonly realResolved: boolean;
  readonly [PATH_BRAND]: true;
}

/**
 * A command line, together with the INNER commands a shell construct actually
 * runs. `execInnerCommands` is the EXEC-LOOP grammar the owner ruled on
 * (2026-07-28): a `for`/`while`/`if` line is the shell's own syntax, not a
 * program, so the authority check runs per inner command and the refusal names
 * the inner command. `inner` is empty when the line uses no construct, and the
 * broker then checks the whole line — exactly the pre-ruling behaviour.
 */
export interface ResolvedCommand {
  readonly raw: string;
  readonly trimmed: string;
  readonly inner: readonly string[];
  readonly [COMMAND_BRAND]: true;
}

/**
 * AN ARGUMENT VECTOR (PHASE-5 T3) — a program and its literal arguments, with
 * NO shell anywhere near them.
 *
 * The difference from `ResolvedCommand` is the whole point of T3's rebuild. A
 * `ResolvedCommand` is a line the shell will PARSE: its `|`, `$( )`, `>` and
 * `for` are syntax, which is why it carries `inner` at all. A `ResolvedArgv` is
 * a program name plus bytes that are handed to `execFile` untouched — the same
 * characters are inert text, so there is no substitution to look inside, no
 * redirect to follow and no construct to unpack.
 *
 * `display` exists ONLY for the deny scans and the audit row. It is a
 * reconstruction for matching and messages and it is never executed; nothing may
 * ever hand it back to a shell.
 */
export interface ResolvedArgv {
  /** The vector exactly as the caller passed it. */
  readonly argv: readonly string[];
  /** `argv[0]` — the program, as spelled. */
  readonly program: string;
  /** `path.basename(program)` — what an allowlist entry like `git` matches. */
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

export type ResolveFailureCode = 'not_present' | 'not_a_string' | 'invalid_url' | 'not_absolute';

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

/** `undefined` / `null` / `''` → absent. Anything non-string → refusal. */
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

/** Mint a `ResolvedCommand`. */
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

/**
 * Mint a `ResolvedArgv`. The ONLY place one comes from.
 *
 * A STRING is `not_a_string` here, which reads backwards until you see what it
 * is for: the old exec entry point took a string, and a caller that still passes
 * one must be REFUSED rather than quietly re-parsed into a vector. Re-parsing is
 * how the shell would come back.
 */
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
  // WHATWG keeps the brackets on an IPv6 host; strip them once, here, so every
  // consumer sees the same spelling `net.isIP` accepts.
  const hostname = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
  return {
    ok: true,
    value: { raw: str.value, href: u.href, hostname, protocol: u.protocol } as unknown as ResolvedUrl,
  };
}

/**
 * A hostname the platform reaches unconditionally (`web_search` only ever talks
 * to `api.search.brave.com`). Declared effects whose `from` is `fixed:<host>`
 * resolve through here rather than through an argument.
 */
export function resolveFixedHost(host: string): ResolvedUrl {
  return { raw: host, href: `https://${host}/`, hostname: host, protocol: 'https:' } as unknown as ResolvedUrl;
}

/** True when a resolved path escapes the directory it claims to live in. */
export function escapesDirectory(resolved: ResolvedPath, dir: string): boolean {
  const root = canonicalizeAgentPath(dir);
  return !(resolved.lexical === root || resolved.lexical.startsWith(root + path.sep));
}
