// ════════════════════════════════════════════════════════════════════════════
// THE PROCESS BROKER (PHASE-5 T2 Step 2).
//
// `permissions.ts:checkExecPermission` + `checkExecCommand` + the exec handler's
// own sensitive-file scan, in one place, asked of a RESOLVED command.
//
// ── THE THREE THINGS IT REFUSES, AND WHY EACH EXISTS ──
// 1. THE GLOBAL EXEC DENY (`rm -rf /`, `rm -rf ~`, `sudo *`, `chmod 777 *`) —
//    unoverridable, checked on the WHOLE line before any construct is unpacked,
//    so a deny cannot be hidden inside a `for` header.
// 2. THE `secrets.yaml` SUBSTRING (v2.3.19, Scenario 3 finding) — a file_write
//    deny cannot see `echo x >> ~/.dojo/secrets.yaml`, and the substring catches
//    every spelling: tilde, absolute, `$HOME`, bare basename, inside `$(…)` or
//    backticks, on either side of a redirect. This is the redirection-append
//    class the T2 corpus names.
// 3. THE SENSITIVE-FILE COMMAND SCAN — `cat ~/.ssh/id_rsa` and friends, caught
//    at the tokenized-argument level before the shell runs.
//
// (3) MOVED HERE from the string-exec handler body in the same change that
// introduced this module, because leaving it there would have left two places
// that answer "may this command run" — the disease this phase exists to delete.
// Its refusal MESSAGE is carried verbatim on the verdict (`blockedMessage`), so
// nothing an agent reads changed: `agent/v2/loop.ts` keys retry behaviour off
// the `[BLOCKED]` prefix and the text after it is what the model is steered by.
//
// ── EXEC-LOOP (owner ruling 2026-07-28) IS PRESERVED EXACTLY ──
// *"why wouldn't we allow an agent to do commands if they have shell access?"*
// A control-flow line is the shell's own grammar, not a program, so the
// per-command authority check runs over the INNER commands `execInnerCommands`
// names, and the refusal names the inner command. Grammar widens; authority does
// not. A construct with nothing nameable inside it falls back to the whole line,
// i.e. the pre-ruling refusal, so an agent with no shell access is still denied.
// ════════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import { foldPath } from '../fs-case.js';
import { resolveHomePath as resolvePath } from '../path-resolve.js';
import { GLOBAL_EXEC_DENY_SUBSTRINGS, isSensitivePath } from './deny.js';
import {
  evaluateRules, matchCommandPattern, matchCommandDenyPattern, type Grant,
} from './grants.js';
import type { ResolvedArgv, ResolvedCommand } from './resolve.js';
import { allow, deny, type Verdict } from './types.js';

/** Hard-coded, unoverridable, and NOT a `grant_rule` row: a table row is a row
 *  somebody can delete, and these four are the platform's floor. Verbatim from
 *  `permissions.ts:GLOBAL_EXEC_DENY`. */
const GLOBAL_EXEC_DENY: readonly string[] = ['rm -rf /', 'rm -rf ~', 'sudo *', 'chmod 777 *'];

/** Verbatim from `tools.ts:SENSITIVE_FILE_READING_COMMANDS` — the obvious
 *  readers and the exfiltration shapes. Not a full shell parser and never
 *  claimed to be: the point is that an accidental `cat ~/.dojo/secrets.yaml`
 *  never leaks into the conversation. */
const SENSITIVE_FILE_READING_COMMANDS: ReadonlySet<string> = new Set<string>([
  'cat', 'less', 'more', 'head', 'tail', 'bat', 'nl', 'strings',
  'cp', 'mv', 'rsync', 'scp', // exfiltration shapes
  'sed', 'awk', 'grep', 'rg', 'ag', 'fgrep', 'egrep',
  'xxd', 'od', 'hexdump',
]);

/**
 * The same line with its PROGRAM spelled as a basename.
 *
 * ⚠ FOUND BY THE T3 CORPUS, AND IT WAS OPEN BEFORE T3 TOO: `rm -rf /` is a
 * global deny and `/bin/rm -rf /` was not, because the deny patterns are
 * matched against the line as typed. An absolute path is the same program by
 * another spelling — the exec family's version of the case-fold and symlink
 * classes T2 closed on the filesystem side — so the deny is asked about BOTH.
 *
 * Deliberately asymmetric: only the DENY side normalises. The ALLOW side keeps
 * matching the line as written, because widening `exec_allow:['git *']` to also
 * accept `/usr/bin/git` would be a new capability, and P5-R5 says a new
 * capability is the owner's decision, not a worker's tidy-up. Normalising for
 * denies only can refuse more and never permit more.
 */
function basenameNormalized(trimmed: string): string | null {
  const firstSpace = trimmed.search(/\s/);
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  if (!head.includes('/')) return null;
  const base = path.basename(head);
  if (!base || base === head) return null;
  return base + (firstSpace === -1 ? '' : trimmed.slice(firstSpace));
}

/** The deny scan over ONE spelling of the line. `basis` is what tells a refusal
 *  the tree already produced (`ladder-parity`) from the one T3 adds by
 *  normalising the program's path (`bypass-hardening`) — the verdict says which
 *  it is rather than a comment claiming it. */
function globalExecDenyOneSpelling(trimmed: string, basis: 'ladder-parity' | 'bypass-hardening'): Verdict | null {
  for (const pattern of GLOBAL_EXEC_DENY) {
    if (matchCommandDenyPattern(pattern, trimmed)) {
      const prefix = pattern.endsWith(' *') ? pattern.slice(0, -2) : null;
      return deny(
        basis,
        `global-exec-deny:${pattern}`,
        prefix && trimmed !== pattern
          ? `Global deny: command starting with "${prefix}" is prohibited`
          : `Global deny: command "${trimmed}" is prohibited`,
      );
    }
  }
  for (const needle of GLOBAL_EXEC_DENY_SUBSTRINGS) {
    // Folded so `cat ~/.dojo/Secrets.yaml` — the same file on APFS — is caught.
    if (foldPath(trimmed).includes(needle)) {
      return deny(
        basis,
        `global-exec-substring:${needle}`,
        `Global deny: shell commands cannot read or modify ${needle} — this file holds API keys and is protected. Use Settings → Providers in the dashboard to change credentials.`,
      );
    }
  }
  return null;
}

/** The deny scan, exported for the AppleScript broker: a `do shell script`
 *  payload is a shell command and must meet the identical floor. */
export function globalExecDenyPublic(trimmed: string): Verdict | null {
  return globalExecDeny(trimmed);
}

/** One command's SHELL authority, exported for the AppleScript broker so a
 *  `do shell script "…"` payload answers to the same grant rows the shell tool
 *  does — the whole point of the cage. */
export function authorizeShellCommandText(grant: Grant, command: string): Verdict {
  return authorizeOneCommand(grant, command, 'shell');
}

function globalExecDeny(trimmed: string): Verdict | null {
  const asTyped = globalExecDenyOneSpelling(trimmed, 'ladder-parity');
  if (asTyped) return asTyped;
  const normalized = basenameNormalized(trimmed);
  if (normalized) return globalExecDenyOneSpelling(normalized, 'bypass-hardening');
  return null;
}

/**
 * The tokenized sensitive-path scan, moved from the string-exec handler. Crude on purpose
 * — a sufficiently motivated bypass (heredocs, base64-decoded paths) gets
 * through, and the substring rule above is what covers the file that actually
 * matters.
 */
export function commandReadsSensitiveFile(command: string): { blocked: true; reason: string } | { blocked: false } {
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { blocked: false };
  for (let i = 0; i < tokens.length; i++) {
    const cmd = path.basename(tokens[i]);
    if (!SENSITIVE_FILE_READING_COMMANDS.has(cmd)) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const arg = tokens[j];
      if (arg === '|' || arg === '||' || arg === '&&' || arg === ';' || arg === '>') break;
      if (arg.startsWith('-')) continue; // flags
      const expanded = resolvePath(arg);
      if (isSensitivePath(path.isAbsolute(expanded) ? expanded : path.resolve(expanded))) {
        return { blocked: true, reason: `path "${arg}" is on the sensitive-files block list` };
      }
    }
  }
  return { blocked: false };
}

/** Per-command authority: the deny rows, then the allow rows, `checkExecCommand`
 *  semantics verbatim (glob on the whole line OR on the base command). */
function authorizeOneCommand(grant: Grant, command: string, kind: 'proc' | 'shell' = 'shell'): Verdict {
  const trimmed = command.trim();
  const globals = globalExecDeny(trimmed);
  if (globals) return globals;

  const baseCommand = trimmed.split(/\s+/)[0];
  const verdict = evaluateRules(grant, kind, (pattern, mode) =>
    mode === 'deny'
      ? matchCommandDenyPattern(pattern, trimmed)
      : matchCommandPattern(pattern, trimmed, baseCommand));

  if (verdict.decided && verdict.allowed) return allow(verdict.pattern);
  if (verdict.decided && !verdict.allowed) {
    const prefix = verdict.pattern.endsWith(' *') ? verdict.pattern.slice(0, -2) : null;
    return deny(
      'ladder-parity',
      `exec-deny:${verdict.pattern}`,
      prefix && trimmed !== verdict.pattern
        ? `Command denied by agent policy: starts with "${prefix}"`
        : `Command denied by agent policy: "${command}"`,
    );
  }
  const allowedList = (
    kind === 'shell'
      ? (grant.manifest.shell_allow ?? grant.manifest.exec_allow ?? [])
      : (grant.manifest.exec_allow ?? [])
  ).join(', ');
  return deny(
    'ladder-parity',
    kind === 'shell' ? 'no-shell-grant' : 'no-exec-grant',
    `Command "${baseCommand}" is not allowed. Your permitted commands are: ${allowedList}`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// THE ARGV DOOR (PHASE-5 T3 Step 1) — `exec({argv})`, no shell anywhere.
// ════════════════════════════════════════════════════════════════════════════

/**
 * INLINE SCRIPT TEXT IS NOT AN ARGUMENT, AND THAT IS THE ONLY THING THIS
 * REFUSES.
 *
 * `exec({argv:['sh','-c','<anything>']})` is a shell script wearing argv's
 * clothes: the allowlist would gate `sh` and then never see what `sh` was told
 * to do, which would make the whole no-shell rebuild theatre. So the argv door
 * refuses the `-c` form and NAMES the other door in the refusal.
 *
 * ⚠ AND IT REFUSES NOTHING ELSE, WHICH IS THE PART THAT MATTERS. `sh
 * count.sh`, `bash build.sh`, `node script.js`, `zsh -l` all still run: they
 * execute a FILE, the file got there through the fs broker, and refusing them
 * would delete the ordinary "write a script and run it" workflow — a capability
 * loss, which the phase's posture makes the owner's decision and not a
 * worker's. The first draft of this function refused any interpreter as argv[0]
 * and the kit's own `coding-task` scenario is what showed that up: its entire
 * premise is *"write a small script … run your script"*.
 *
 * The `-c` scan runs over EVERY element, not just argv[1], because
 * `env FOO=1 sh -c '…'` re-points the program after the allowlist has already
 * looked at it.
 *
 * `eval`, `source`, `.` and `exec` are shell BUILTINS — there is no such program
 * to execFile — so naming them produces a refusal a model can act on instead of
 * an ENOENT it will retry.
 */
const SHELL_INTERPRETERS: ReadonlySet<string> = new Set<string>([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'ash', 'busybox',
]);

/** Programs that are not programs: shell builtins with no binary to run. */
const SHELL_BUILTINS: ReadonlySet<string> = new Set<string>([
  'eval', 'source', '.', 'exec', 'command',
]);

const INLINE_SCRIPT_FLAGS: ReadonlySet<string> = new Set<string>(['-c', '--command', '-lc', '-ic']);

/** Is this vector `<some shell> -c <script text>` in any spelling? */
function isInlineShellScript(argv: readonly string[]): boolean {
  const hasInterpreter = argv.some((a) => SHELL_INTERPRETERS.has(path.basename(a)));
  if (!hasInterpreter) return false;
  return argv.some((a) => INLINE_SCRIPT_FLAGS.has(a));
}

/**
 * `authorize(grant, {kind:'proc', resource})` — the rebuilt exec door.
 *
 * Three refusals, in the order that makes each one un-walk-around-able:
 *   1. the shell interpreters above, on the PROGRAM (basename and spelling);
 *   2. the global deny + the `secrets.yaml` substring, on the reconstructed
 *      line, so `['rm','-rf','/']` is the same refusal `rm -rf /` always was;
 *   3. the tokenized sensitive-read scan over the argv ELEMENTS, which is
 *      strictly better than the string version it inherits: there is no quoting
 *      to get wrong, because the caller already told us where each token ends.
 * Then the grant's own `proc` rows decide, deny before allow, and an agent with
 * no allow row runs nothing — deny-by-default is the absence of a row, not a
 * special case.
 */
export function authorizeArgv(grant: Grant, resource: ResolvedArgv): Verdict {
  if (SHELL_BUILTINS.has(resource.base)) {
    return deny(
      'ladder-parity',
      `argv-builtin:${resource.base}`,
      `"${resource.base}" is a shell builtin, not a program`,
      `[BLOCKED] exec refused: "${resource.base}" is a shell builtin, not a program, so there is nothing for exec to run. If you need shell behaviour use the shell tool — shell({script:"…"}) runs the whole line under /bin/zsh.`,
    );
  }
  if (isInlineShellScript(resource.argv)) {
    return deny(
      'ladder-parity',
      'argv-inline-script',
      'exec runs one program with literal arguments; inline shell script text belongs at the shell door',
      `[BLOCKED] exec refused: this is inline shell script text ("-c"), and exec({argv:[…]}) runs one program with literal arguments and no shell — pipes, redirects, loops and substitution do not work there. Use shell({script:"…"}) instead, which runs the whole line under /bin/zsh. Running a script FILE is fine here: exec({argv:["sh","/path/to/script.sh"]}) works.`,
    );
  }

  const globals = globalExecDeny(resource.display);
  if (globals) return globals;

  const scan = argvReadsSensitiveFile(resource.argv);
  if (scan.blocked) {
    return deny(
      'ladder-parity',
      'exec-sensitive-read',
      scan.reason,
      `[BLOCKED] exec refused: ${scan.reason}. The DOJO never echoes secret files into the conversation. If you need a value from secrets.yaml (API key, OAuth token, etc.), ask the user, those values live in process memory only, not in agent context.`,
    );
  }

  return authorizeOneCommand(grant, resource.display, 'proc');
}

/**
 * The tokenized sensitive-path scan over an ARGUMENT VECTOR.
 *
 * Same rule as `commandReadsSensitiveFile`, and deliberately the same crudeness,
 * but it does not have to guess where a token ends: the caller supplied the
 * boundaries, so the whitespace split that the string version lives with is gone
 * and a quoted path with a space in it is finally one token.
 */
export function argvReadsSensitiveFile(argv: readonly string[]): { blocked: true; reason: string } | { blocked: false } {
  if (argv.length === 0) return { blocked: false };
  for (let i = 0; i < argv.length; i++) {
    const cmd = path.basename(argv[i]);
    if (!SENSITIVE_FILE_READING_COMMANDS.has(cmd)) continue;
    for (let j = i + 1; j < argv.length; j++) {
      const arg = argv[j];
      if (arg.startsWith('-')) continue; // flags
      const expanded = resolvePath(arg);
      if (isSensitivePath(path.isAbsolute(expanded) ? expanded : path.resolve(expanded))) {
        return { blocked: true, reason: `path "${arg}" is on the sensitive-files block list` };
      }
    }
  }
  return { blocked: false };
}

/**
 * `authorize(grant, {kind:'shell'|'proc', resource})`.
 *
 * `scanSensitiveReads` exists so `checkPermission`'s legacy `type:'exec'` shape
 * — which is also the EXACT call the destructive-approval seam records
 * (`destructive-gate.ts:126`, and RULING P5-R3 makes that coupling T3's to
 * move) — keeps answering the identical question it answered before. The
 * dispatcher asks with the scan ON, which is where the string-exec handler used to ask it.
 */
export function authorizeProc(
  grant: Grant,
  resource: ResolvedCommand,
  scanSensitiveReads = false,
): Verdict {
  // The WHOLE line meets the global deny first: a construct's header is not one
  // of the inner commands, and `secrets.yaml` must not become reachable by
  // hiding it in one.
  const wholeLine = globalExecDeny(resource.trimmed);
  if (wholeLine) return wholeLine;

  if (scanSensitiveReads) {
    const scan = commandReadsSensitiveFile(resource.raw);
    if (scan.blocked) {
      return deny(
        'ladder-parity',
        'exec-sensitive-read',
        scan.reason,
        `[BLOCKED] exec refused: ${scan.reason}. The DOJO never echoes secret files into the conversation. If you need a value from secrets.yaml (API key, OAuth token, etc.), ask the user, those values live in process memory only, not in agent context.`,
      );
    }
  }

  const parts = resource.inner.length > 0 ? resource.inner : [resource.raw];
  for (const part of parts) {
    const verdict = authorizeOneCommand(grant, part);
    if (!verdict.allowed) return verdict;
  }
  return allow('exec-grant');
}

/**
 * THE SHELL DOOR (PHASE-5 T3 Step 1) — `shell({script})` under `/bin/zsh -c`.
 *
 * The authority is byte-identical to what `exec` applied yesterday, because it
 * IS that code: `authorizeProc` with the sensitive-read scan ON, reading the
 * `shell` grant rows. What changed is not the answer, it is the NAME of the
 * grant that gives it and the fact that the script's full text now arrives at a
 * door that exists to audit it, instead of at a door whose schema said
 * *"the shell command to execute"* and whose gate pretended a program name was
 * the whole story.
 *
 * The EXEC-LOOP ruling (owner, 2026-07-28) lives here: `resource.inner` is the
 * grammar unpack, so a `for`/`while`/`if` line is checked per inner command and
 * a construct with nothing nameable inside falls back to the whole line.
 */
export function authorizeShellScript(grant: Grant, resource: ResolvedCommand): Verdict {
  return authorizeProc(grant, resource, true);
}
