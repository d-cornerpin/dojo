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
// (3) MOVED HERE from `executeExec`'s handler body in the same change that
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
import type { ResolvedCommand } from './resolve.js';
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

function globalExecDeny(trimmed: string): Verdict | null {
  for (const pattern of GLOBAL_EXEC_DENY) {
    if (matchCommandDenyPattern(pattern, trimmed)) {
      const prefix = pattern.endsWith(' *') ? pattern.slice(0, -2) : null;
      return deny(
        'ladder-parity',
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
        'ladder-parity',
        `global-exec-substring:${needle}`,
        `Global deny: shell commands cannot read or modify ${needle} — this file holds API keys and is protected. Use Settings → Providers in the dashboard to change credentials.`,
      );
    }
  }
  return null;
}

/**
 * The tokenized sensitive-path scan, moved from `executeExec`. Crude on purpose
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
function authorizeOneCommand(grant: Grant, command: string): Verdict {
  const trimmed = command.trim();
  const globals = globalExecDeny(trimmed);
  if (globals) return globals;

  const baseCommand = trimmed.split(/\s+/)[0];
  const verdict = evaluateRules(grant, 'shell', (pattern, mode) =>
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
  const allowedList = (grant.manifest.exec_allow ?? []).join(', ');
  return deny(
    'ladder-parity',
    'no-exec-grant',
    `Command "${baseCommand}" is not allowed. Your permitted commands are: ${allowedList}`,
  );
}

/**
 * `authorize(grant, {kind:'shell'|'proc', resource})`.
 *
 * `scanSensitiveReads` exists so `checkPermission`'s legacy `type:'exec'` shape
 * — which is also the EXACT call the destructive-approval seam records
 * (`destructive-gate.ts:126`, and RULING P5-R3 makes that coupling T3's to
 * move) — keeps answering the identical question it answered before. The
 * dispatcher asks with the scan ON, which is where `executeExec` used to ask it.
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
