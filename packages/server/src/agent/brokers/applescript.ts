
import { ownsTheMac } from '../owns-the-mac.js';
import { evaluateRules, type Grant } from './grants.js';
import { commandReadsSensitiveFile, globalExecDeny, authorizeShellCommandText } from './proc.js';
import { authorizePrivilege, mentionsAdminPrivileges } from './sudo-policy.js';
import type { ResolvedCommand } from './resolve.js';
import { allow, deny, type Verdict } from './types.js';

const DO_SHELL_SCRIPT_RE = /\bdo\s+shell\s+script\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi;

/** The shell lines an AppleScript's `do shell script` statements run. */
export function shellPayloads(script: string): string[] {
  return [...script.matchAll(DO_SHELL_SCRIPT_RE)].map((m) => m[1].slice(1, -1).replace(/\\(["'\\])/g, '$1'));
}

// osascript is a second interpreter: its "do shell script" reaches back into
// /bin/sh, so the script body and every payload answer to the shell rules.
export function authorizeAppleScript(grant: Grant, script: ResolvedCommand): Verdict {
  // Checking the raw body refuses a script that merely names the secret store.
  const floor = !ownsTheMac(grant.agentId);
  const globals = globalExecDeny(script.raw, floor);
  if (globals) return globals;

  // "do shell script ... with administrator privileges" is macOS root with no
  // sudo token, so it answers to the same role wall as sudo.
  if (mentionsAdminPrivileges(script.raw)) {
    const verdict = authorizePrivilege(grant.agentId);

    if (!verdict.allowed) return verdict;
  }

  for (const inner of shellPayloads(script.raw)) {
    const payloadDeny = globalExecDeny(inner.trim(), floor);

    if (payloadDeny) return payloadDeny;
    const scan = commandReadsSensitiveFile(inner);
    if (scan.blocked) {
      return deny(
        'bypass-hardening',
        'applescript-shell-sensitive-read',
        scan.reason,
        `[BLOCKED] applescript refused: ${scan.reason}. AppleScript's "do shell script" is the shell, so it answers to the same rules the shell tool does.`,
      );
    }
    const verdict = authorizeShellCommandText(grant, inner);
    if (!verdict.allowed) return verdict;
  }

  const verdict = evaluateRules(grant, 'applescript', (pattern) =>
    pattern === '*' || pattern === 'applescript' || pattern === 'applescript_run');
  if (verdict.decided && verdict.allowed) return allow(verdict.pattern);
  return deny(
    'ladder-parity',
    'no-applescript-grant',
    'system_control permission required: applescript',
  );
}
