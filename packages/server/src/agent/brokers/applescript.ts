// ════════════════════════════════════════════════════════════════════════════
// THE APPLESCRIPT BROKER (PHASE-5 T3 Step 2) — osascript, caged.
//
// It gets its own module for the same reason it gets its own grant: it is not a
// process broker case, it is a SECOND INTERPRETER. §T0-PINS P7 calls
// `system-control.ts`'s `execSync('osascript -')` *"still the cleanest allowlist
// bypass in the tree"*, and the reason is structural — `system_control` gates a
// CATEGORY NAME, and the thing that needs authorizing is the SCRIPT.
// ════════════════════════════════════════════════════════════════════════════

import { evaluateRules, type Grant } from './grants.js';
import { commandReadsSensitiveFile, globalExecDenyPublic, authorizeShellCommandText } from './proc.js';
import type { ResolvedCommand } from './resolve.js';
import { allow, deny, type Verdict } from './types.js';

/**
 * THE APPLESCRIPT DOOR (PHASE-5 T3 Step 2) — its own class, and here is why.
 *
 * `osascript` is a second interpreter with no allowlist of its own, and
 * AppleScript's `do shell script "…"` reaches straight back into `/bin/sh`. Any
 * agent that could run `applescript_run` could therefore run anything, past the
 * exec allowlist entirely — §T0-PINS P7 calls it *"still the cleanest allowlist
 * bypass in the tree"*. Two things close that here:
 *
 *   1. the grant is its own row (`applescript`), so an agent's AppleScript reach
 *      is nameable and deniable on its own rather than a side effect of holding
 *      `system_control`;
 *   2. THE SCRIPT TEXT IS AUDITED. The same global deny and the same
 *      `secrets.yaml` substring rule the shell door applies run over the script
 *      body, and a `do shell script` payload is unpacked and put through the
 *      SHELL grant — so AppleScript cannot be used to run a command the agent
 *      would be refused if it typed it at the shell door. That is the bypass
 *      class closing, which RULING P5-R5 names as strengthening rather than
 *      narrowing: reaching `secrets.yaml` through osascript was never a
 *      capability.
 */
const DO_SHELL_SCRIPT_RE = /\bdo\s+shell\s+script\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi;

export function authorizeAppleScript(grant: Grant, script: ResolvedCommand): Verdict {
  // 1. The whole body meets the global deny + the secrets substring. A script
  //    that merely NAMES the secret store is refused however it meant to read it.
  const globals = globalExecDenyPublic(script.raw);
  if (globals) return globals;

  // 2. Any `do shell script "…"` payload is a shell command, so it answers to
  //    the SHELL grant exactly as if the agent had typed it there.
  for (const match of script.raw.matchAll(DO_SHELL_SCRIPT_RE)) {
    const quoted = match[1];
    const inner = quoted.slice(1, -1).replace(/\\(["'\\])/g, '$1');
    const payloadDeny = globalExecDenyPublic(inner.trim());
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

  // 3. The grant itself.
  const verdict = evaluateRules(grant, 'applescript', (pattern) =>
    pattern === '*' || pattern === 'applescript' || pattern === 'applescript_run');
  if (verdict.decided && verdict.allowed) return allow(verdict.pattern);
  return deny(
    'ladder-parity',
    'no-applescript-grant',
    'system_control permission required: applescript',
  );
}