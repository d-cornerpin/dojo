// THE PROCESS BROKER: the exec permission checks, asked of a resolved command. Refusals: a line naming
// a hidden file (`shellLineNamesHidden`), then the global exec deny on the WHOLE line before any construct
// is unpacked (so it cannot hide in a for header; sudo is the main agent's alone, not a floor item).
// Refusal text rides verbatim on the verdict: the agent loop keys retry off [BLOCKED]. Control
// is grammar, not a program: authority runs per simple command, refusal names it; a line naming
// no command is checked whole. Grammar widens; authority does not.

import path from 'node:path';
import { isPrimaryAgent } from '../../config/platform.js';
import { shellLineNamesHidden } from './deny.js';
import { viewerFor } from './fs.js';
import { lexShellLine } from './shell-words.js';
import {
  authorizePrivilege, isSudoLine, mentionsPrivilegeToken, privilegeTokenIsQuotedData,
  privilegedInnerCommands,
} from './sudo-policy.js';
import { SUDO_UNPLACEABLE_REASON } from './sudo-copy.js';
import { SHELL_INTERPRETERS, execSimpleCommands, withoutDataBodies } from '../exec-grammar.js';
import {
  evaluateRules, matchCommandPattern, matchCommandDenyPattern, type Grant,
} from './grants.js';
import type { ResolvedArgv, ResolvedCommand } from './resolve.js';
import { allow, deny, type Verdict } from './types.js';

/** Hard-coded, NOT a grant_rule row: the floor for every agent but the main one, read inside sudo too. */
const GLOBAL_EXEC_DENY: readonly string[] = ['rm -rf /', 'rm -rf ~', 'chmod 777 *'];

/** The same line with its PROGRAM spelled as a basename: an absolute path is the same program, so
 *  the deny asks both spellings. Only DENY normalises; a wider allow is the owner's capability call. */
function basenameNormalized(trimmed: string): string | null {
  const firstSpace = trimmed.search(/\s/);
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  if (!head.includes('/')) return null;
  const base = path.basename(head);
  if (!base || base === head) return null;
  return base + (firstSpace === -1 ? '' : trimmed.slice(firstSpace));
}

/** Deny over ONE spelling; basis says whether basename normalising added the refusal. */
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
  return null;
}

/** The one hidden-file refusal for a line, at every door that runs one (shell, exec, each AppleScript payload). */
export function hiddenFileDeny(line: string, agentId: string, cwd?: string): Verdict | null {
  const reason = shellLineNamesHidden(line, viewerFor(agentId), cwd);
  return reason ? deny('ladder-parity', 'exec-sensitive-read', reason, `[BLOCKED] refused: ${reason}. The Dojo never shows a secret file to an agent.`) : null;
}

/** SHELL authority for a line (a script, a do shell script payload): every simple command needs an allow row; deny rows read `runs`. */
export function authorizeShellCommandText(grant: Grant, line: string, commands = execSimpleCommands(line), runs = execSimpleCommands(line, false)): Verdict {
  let verdict = allow('exec-grant');
  for (const command of commands) {
    verdict = authorizeOneCommand(grant, command, 'shell', [line, ...runs]);
    if (!verdict.allowed) break;
  }
  return verdict;
}

/** The deny scan, exported so the AppleScript broker's do shell script payload meets the same floor.
 *  `floor` false (the main agent) skips it: its writes meet the warn-once hurdle instead. */
export function globalExecDeny(trimmed: string, floor = true): Verdict | null {
  if (!floor) return null;
  const normalized = basenameNormalized(trimmed);
  return globalExecDenyOneSpelling(trimmed, 'ladder-parity') ?? (normalized ? globalExecDenyOneSpelling(normalized, 'bypass-hardening') : null);
}

/** Every command a line runs as the floor reads it: the whole line, each simple command, and what a
 *  privilege wrapper runs one interpreter deeper. */
export function floorReadings(raw: string): string[] {
  const runs = execSimpleCommands(raw, false);
  return [raw.trim(), ...runs, ...runs.flatMap((seg) => privilegedInnerCommands(seg))];
}

/** One simple command's authority: deny rows on it or on `runs`, the line and all it runs (a deny may span a pipe,
 *  and can only refuse), then allow rows on the command alone, glob on it or its base command. */
function authorizeOneCommand(grant: Grant, command: string, kind: 'proc' | 'shell' = 'shell', runs: readonly string[] = []): Verdict {
  const trimmed = command.trim();
  const lexable = kind === 'proc' || lexShellLine(trimmed) !== null;   // a shell quote left open: only `*` admits it
  const globals = globalExecDeny(trimmed, !isPrimaryAgent(grant.agentId));
  if (globals) return globals;

  // SUDO: the main agent's alone; the floor already read the inner command.
  if (isSudoLine(trimmed)) return authorizePrivilege(grant.agentId);

  const baseCommand = trimmed.split(/\s+/)[0];
  const verdict = evaluateRules(grant, kind, (pattern, mode) =>
    mode === 'deny'
      ? [trimmed, ...runs].some((run) => matchCommandDenyPattern(pattern, run.trim()))
      : (lexable || pattern === '*') && matchCommandPattern(pattern, trimmed, baseCommand));

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

/** Programs that are not programs: shell builtins with no binary to run. */
const SHELL_BUILTINS: ReadonlySet<string> = new Set<string>([
  'eval', 'source', '.', 'exec', 'command',
]);

const INLINE_SCRIPT_FLAGS: ReadonlySet<string> = new Set<string>(['-c', '--command', '-lc', '-ic']);

/**
 * INLINE SCRIPT TEXT IS NOT AN ARGUMENT: for other agents `sh -c` is a shell script in argv's clothes,
 * refused over EVERY element (`env FOO=1 sh -c` re-points the program after argv[0] was read), so it
 * meets the shell door's checks. The main agent skips those checks, so its `sh -c` runs. A script FILE runs.
 */
function isInlineShellScript(argv: readonly string[]): boolean {
  return argv.some((a) => SHELL_INTERPRETERS.has(path.basename(a))) && argv.some((a) => INLINE_SCRIPT_FLAGS.has(a));
}

/** The argv door. Refusals in order: builtins and (for other agents) -c on the program; a hidden file named and the global
 *  deny on the rebuilt line. Then the proc rows, deny before allow; no row means deny. */
export function authorizeArgv(grant: Grant, resource: ResolvedArgv, cwd?: string): Verdict {
  if (SHELL_BUILTINS.has(resource.base)) {
    return deny(
      'ladder-parity',
      `argv-builtin:${resource.base}`,
      `"${resource.base}" is a shell builtin, not a program`,
      `[BLOCKED] exec refused: "${resource.base}" is a shell builtin, not a program, so there is nothing for exec to run. If you need shell behaviour use the shell tool — shell({script:"…"}) runs the whole line under /bin/zsh.`,
    );
  }
  if (!isPrimaryAgent(grant.agentId) && isInlineShellScript(resource.argv)) {
    return deny(
      'ladder-parity',
      'argv-inline-script',
      'exec runs one program with literal arguments; inline shell script text belongs at the shell door',
      `[BLOCKED] exec refused: this is inline shell script text ("-c"), and exec({argv:[…]}) runs one program with literal arguments and no shell — pipes, redirects, loops and substitution do not work there. Use shell({script:"…"}) instead, which runs the whole line under /bin/zsh. Running a script FILE is fine here: exec({argv:["sh","/path/to/script.sh"]}) works.`,
    );
  }

  const refused = hiddenFileDeny(resource.display, grant.agentId, cwd) ?? globalExecDeny(resource.display, !isPrimaryAgent(grant.agentId));
  if (refused) return refused;

  return authorizeOneCommand(grant, resource.display, 'proc');
}

/** THE SHELL DOOR: shell({script}) under /bin/zsh -c, over the shell rows. */
export function authorizeProc(grant: Grant, resource: ResolvedCommand, cwd?: string): Verdict {
  const hidden = hiddenFileDeny(resource.raw, grant.agentId, cwd);
  if (hidden) return hidden;
  // The floor reads the whole line (a construct's header is not one of its commands), every simple
  // command and what a privilege wrapper runs; the main agent does not meet it.
  const floor = !isPrimaryAgent(grant.agentId);
  if (floor) for (const command of floorReadings(resource.raw)) {
    const denied = globalExecDeny(command, floor);
    if (denied) return denied;
  }

  // THE PRIVILEGE PASS, BEFORE the grant pass, over EVERY simple command the line contains.
  // 1. the sound floor: a privilege token anywhere in the RAW line, asked before any parse.
  // 2. the precise walk: simple commands from the shared grammar, wrappers unwrapped; a privileged
  //    segment meets the role wall; floor fired and walk placed nothing: UNPLACEABLE, refused to other agents.
  const segments = execSimpleCommands(resource.raw);
  const runs = execSimpleCommands(resource.raw, false);
  let privilegedSeen = false;
  for (const seg of runs) {
    if (!isSudoLine(seg)) continue;
    privilegedSeen = true;
    const v = authorizePrivilege(grant.agentId);
    if (!v.allowed) return v;
  }
  if (!privilegedSeen && !isPrimaryAgent(grant.agentId) && mentionsPrivilegeToken(withoutDataBodies(resource.raw))) {
    // The token is in the line and no segment owns it: a substitution, a nested quote, an opaque
    // construct. HARMLESS DATA is the one exemption: quoted spans only, and no interpreter runs them.
    if (!privilegeTokenIsQuotedData(resource.raw, segments)) {
      return deny('bypass-hardening', 'sudo-unplaceable', SUDO_UNPLACEABLE_REASON);
    }
  }

  return authorizeShellCommandText(grant, resource.raw, segments, runs);
}
