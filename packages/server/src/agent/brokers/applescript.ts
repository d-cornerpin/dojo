
import { evaluateRules, type Grant } from './grants.js';
import { commandReadsSensitiveFile, globalExecDeny, authorizeShellCommandText } from './proc.js';
import { authorizeAdminPrivilegeRequest, mentionsAdminPrivileges } from './sudo-policy.js';
import type { ResolvedCommand } from './resolve.js';
import { allow, deny, type Verdict } from './types.js';

const DO_SHELL_SCRIPT_RE = /\bdo\s+shell\s+script\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi;

// osascript is a second interpreter: its "do shell script" reaches back into
// /bin/sh, so the script body and every payload answer to the shell rules.
export function authorizeAppleScript(grant: Grant, script: ResolvedCommand): Verdict {
  // Checking the raw body refuses a script that merely names the secret store.
  const globals = globalExecDeny(script.raw);
  if (globals) return globals;

  // "do shell script ... with administrator privileges" is macOS root with no
  // sudo token, so it answers to the same admin privilege policy as sudo.
  if (mentionsAdminPrivileges(script.raw)) {
    const verdict = authorizeAdminPrivilegeRequest(grant.agentId);
    if (!verdict.allowed) return verdict;
  }

  for (const match of script.raw.matchAll(DO_SHELL_SCRIPT_RE)) {
    const quoted = match[1];
    const inner = quoted.slice(1, -1).replace(/\\(["'\\])/g, '$1');
    const payloadDeny = globalExecDeny(inner.trim());
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
