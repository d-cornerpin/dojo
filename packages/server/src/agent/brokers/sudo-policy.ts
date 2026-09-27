// ════════════════════════════════════════════════════════════════════════════════════════
// SUDO IS A POLICY, NOT A WALL — owner ruling, 2026-09-26 (ships v3.2.2).
//
// ── THE RULING ───────────────────────────────────────────────────────────────────────────────
// `sudo *` leaves the hardcoded `GLOBAL_EXEC_DENY` floor and becomes a PER-BOX SETTING:
// `blocked | gated | free`, shipped default **gated**.
//
// ── THE PREMISE, IN HIS WORDS: the agent's own Mac mini means the main agent controls the
// machine, and the blanket block contradicted that. THE PLATFORM CONTRADICTED ITSELF OUT LOUD ──
// `services/imessage-bridge.ts`'s `IMSG_INSTALL_HINT` is a setup instruction the platform prints
// FOR THE AGENT TO RUN:
//
//     git clone …/imsg.git && cd imsg && make build &&
//     sudo cp bin/imsg /opt/homebrew/bin/ &&
//     sudo cp .build/*/release/PhoneNumberKit_PhoneNumberKit.bundle /opt/homebrew/bin/
//
// Two `sudo` lines, printed by the platform, which the platform then refused to let the agent
// execute. `migration/dependency-script.ts:53` prints `sudo apt-get install -y <pkg>` for the same
// reason. A floor that forbids the very command the product hands over is not a safety property; it
// is a contradiction the owner has now resolved.
//
// ── ⚠ THE NON-NEGOTIABLE, AND IT IS THE WHOLE SECURITY ARGUMENT ──────────────────────────────
// SUDO IS A TRANSPARENT WRAPPER FOR AUTHORIZATION PURPOSES. The other three floor entries
// (`rm -rf /`, `rm -rf ~`, `chmod 777 *`) and EVERYTHING ELSE IN THE BROKER PIPELINE — the
// `secrets.yaml` substring, the tokenized sensitive-path scan, the agent's own grant rows — must
// bite INSIDE a sudo line under EVERY policy, including `free`. So the decision is:
//
//     1. strip `sudo` AND ITS OPTIONS off the front → the INNER command
//     2. re-run the ENTIRE authorization over the inner command, as if sudo were not there
//     3. only if that passes does POLICY apply, ON TOP
//
// `sudo rm -rf /` is therefore refused under `free`, and a deny-all agent still cannot run
// `sudo ls` — step 2 is where both of those happen. Anything else would make `free` a hole through
// the floor, and `gated` a hole the owner could open by clicking a dropdown.
//
// ⚠ STEP 1 IS THE SECURITY-CRITICAL PART AND IT IS NOT `slice(5)`. `sudo -u root rm -rf /` with a
// naive prefix strip leaves `-u root rm -rf /`, which matches no floor pattern at all — the floor
// would silently stop biting the moment anybody passed a flag. `parseSudo` below skips sudo's
// options, including the ones that TAKE A VALUE, and its fixture table carries every shape.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────────────────────
// NOT primary-only. The policy is BOX-WIDE, and sudo remains subject to each agent's exec grants
// exactly as every other command is: a deny-all agent cannot exec anything, sudo included. The
// policy widens what the FLOOR permits; it never widens a grant.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getSudoPolicyRaw } from '../../config/platform.js';
// `types.js` is a leaf (no broker imports), so the verdict helpers come from there rather than
// from `proc.ts` — which imports THIS module, and would be a cycle.
import { allow, deny, type Verdict } from './types.js';

/** The three values, and the only three. */
export type SudoPolicy = 'blocked' | 'gated' | 'free';

/** Shipped default, per the ruling. A box that has never been configured GATES. */
export const SUDO_POLICY_DEFAULT: SudoPolicy = 'gated';

/** The config row's key. One spelling, exported, so the route, the cache and the UI agree. */
export const SUDO_POLICY_KEY = 'sudo_policy';

/**
 * The box's policy, read through the platform-config cache.
 *
 * AN UNRECOGNISED VALUE READS AS THE DEFAULT rather than as `free`. A typo in a config row, or a
 * downgrade that wrote a word this build does not know, must never widen authority — the same
 * direction every other fail-safe in this tree takes.
 */
export function getSudoPolicy(): SudoPolicy {
  const raw = getSudoPolicyRaw();
  return raw === 'blocked' || raw === 'gated' || raw === 'free' ? raw : SUDO_POLICY_DEFAULT;
}

/**
 * sudo options that CONSUME THE NEXT ARGUMENT. Getting this list wrong is how the floor stops
 * biting: an unlisted value-taking option leaves its value as the apparent inner command, so
 * `sudo -u root rm -rf /` would authorize `root` and run `rm -rf /`.
 *
 * From sudo(8). The short forms are what a model actually writes; the long forms are included
 * because `--user=root` and `--user root` are both legal and the second needs the skip.
 */
const SUDO_OPTS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from',
  '-D', '--chdir', '-R', '--chroot', '-T', '--command-timeout', '-U', '--other-user',
  '-r', '--role', '-t', '--type',
]);

/**
 * sudo options that request an INTERACTIVE ROOT SHELL rather than running a command. There is no
 * inner command to authorize, so there is nothing the broker can reason about — an unbounded root
 * shell is refused under every policy, including `free`.
 */
const SUDO_SHELL_OPTS: ReadonlySet<string> = new Set(['-i', '--login', '-s', '--shell']);

export interface ParsedSudo {
  /** The command as it would read with sudo and its options removed. '' when there is none. */
  readonly inner: string;
  /** True when the line asks for an interactive root shell instead of running a command. */
  readonly interactiveShell: boolean;
  /** True when `-n`/`--non-interactive` was already passed by the caller. */
  readonly nonInteractive: boolean;
  /** True when an option's value carried a quote, so the whitespace split cannot be trusted. */
  readonly quotedOptionValue: boolean;
}

/** Is this line's PROGRAM sudo? Basename-aware, so `/usr/bin/sudo` is the same program. */
export function isSudoLine(trimmed: string): boolean {
  const head = trimmed.split(/\s+/)[0] ?? '';
  const base = head.includes('/') ? head.slice(head.lastIndexOf('/') + 1) : head;
  return base === 'sudo';
}

/**
 * Strip `sudo` and its options, returning the command sudo would actually run.
 *
 * ⚠ RECURSES ON A NESTED `sudo`, because `sudo sudo rm -rf /` is one command with two wrappers and
 * the floor has to see the bottom of the stack. Bounded by the token count, so it cannot spin.
 *
 * Crude by the same admission the sensitive-path scan makes: this is not a shell parser, and a
 * determined bypass through a heredoc or a base64 pipe gets past it. What it does guarantee is that
 * the ORDINARY spellings a model writes cannot slip a floor pattern past the broker.
 */
export function parseSudo(trimmed: string): ParsedSudo {
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let i = 1;                       // token 0 is sudo itself
  let nonInteractive = false;
  let quotedOptionValue = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--') { i += 1; break; }
    if (!t.startsWith('-')) break;
    if (t === '-n' || t === '--non-interactive') { nonInteractive = true; i += 1; continue; }
    if (SUDO_SHELL_OPTS.has(t)) {
      // `sudo -i` / `sudo -s` MAY be followed by a command; with nothing after it, it is a shell.
      const rest = tokens.slice(i + 1).join(' ');
      return rest.length === 0
        ? { inner: '', interactiveShell: true, nonInteractive, quotedOptionValue }
        : { ...parseInner(rest), nonInteractive, quotedOptionValue };
    }
    if (t.includes('=')) { i += 1; continue; }            // --user=root, already self-contained
    if (SUDO_OPTS_WITH_VALUE.has(t)) {
      // A value that opens a quote means the real value spans tokens we cannot count.
      if (/['"]/.test(tokens[i + 1] ?? '')) quotedOptionValue = true;
      i += 2; continue;
    }
    i += 1;                                               // an ordinary boolean flag
  }
  const rest = tokens.slice(i).join(' ');
  if (rest.length === 0) return { inner: '', interactiveShell: true, nonInteractive, quotedOptionValue };
  return { ...parseInner(rest), nonInteractive, quotedOptionValue };
}

/** One more layer, for a nested wrapper. */
function parseInner(rest: string): { inner: string; interactiveShell: boolean } {
  if (isSudoLine(rest)) {
    const again = parseSudo(rest);
    return { inner: again.inner, interactiveShell: again.interactiveShell };
  }
  return { inner: rest, interactiveShell: false };
}

/** The `blocked` refusal, VERBATIM what the floor said before this change. */
export const SUDO_BLOCKED_REASON = 'Global deny: command starting with "sudo" is prohibited';

/**
 * THE DECISION, and the ORDER OF THESE THREE STEPS IS THE SECURITY PROPERTY.
 *
 * `reauthorize` is the broker's own per-command authority, handed in as a callback so this module
 * decides the POLICY without importing the broker (which imports this one). It runs the floor, the
 * `secrets.yaml` substring, the agent's grant rows — everything — over the INNER command.
 *
 * ⚠ THE SENSITIVE-PATH SCAN IS NOT RE-RUN HERE, AND THAT IS MEASURED RATHER THAN ASSUMED:
 * `commandReadsSensitiveFile` walks EVERY token looking for a reader, so it is position-independent
 * and already sees inside a sudo line — `sudo cat <secret>` and `sudo -u root cat /etc/shadow` both
 * match on the `cat` at token 1 or 3. Verified before the inner call was removed, and pinned by a
 * clause, so the reliance is a fact somebody checks rather than a habit.
 *
 * `gated` returns ALLOW. The consent hold is filed upstream of the broker by the destructive gate at
 * dispatch (`isDestructiveCall` classifies a sudo line as destructive under `gated`, and the existing
 * card + `approve_destructive_action` machinery does the rest). A deny here would refuse the
 * post-approval retry — spending the one-shot approval for nothing, the dead-end
 * `manifestPermitsDestructiveCall` exists to prevent — and would stop the PRIMARY, which that gate
 * deliberately does not hold, from ever running sudo.
 */
export function authorizeSudoLine(
  trimmed: string,
  reauthorize: (inner: string) => Verdict,
): Verdict {
  const parsed = parseSudo(trimmed);
  if (parsed.interactiveShell || parsed.inner.length === 0) {
    return deny('ladder-parity', 'sudo-interactive-shell', SUDO_INTERACTIVE_SHELL_REASON);
  }
  // ⚠ FAIL CLOSED WHEN THE PARSE WAS DEFEATED, AND MY OWN FIXTURE TABLE IS WHY THIS EXISTS.
  // `parseSudo` splits on whitespace, so an option VALUE CONTAINING A QUOTED SPACE defeats it:
  // `sudo -p "pw: " rm -rf /` tokenizes to [sudo, -p, "pw:, ", rm, …]; the parser takes `"pw:` as
  // `-p`'s value and hands back `" rm -rf /` as the inner command — which matches NO floor pattern,
  // because the floor matches a PREFIX and the stray quote is now in front of it. The floor silently
  // stopped biting on a shape a model can write by accident.
  //
  // Two fixes were measured and one was rejected: re-scanning the line with the word `sudo` textually
  // removed does NOT help, because `-p "pw: " rm -rf /` still does not START with a floor pattern, and
  // widening the floor to a SUBSTRING match would refuse `echo "rm -rf /"` — a live behaviour change
  // beyond this feature's remit. So an unparseable sudo line is REFUSED rather than guessed at: the
  // command is unusual, the message says exactly how to rewrite it, and a floor that cannot read a
  // line must never assume the line is safe.
  if (parsed.quotedOptionValue) {
    return deny('ladder-parity', 'sudo-unparseable-options', SUDO_UNPARSEABLE_REASON);
  }
  const inner = reauthorize(parsed.inner);
  if (!inner.allowed) return inner;
  const policy = getSudoPolicy();
  if (policy === 'blocked') return deny('ladder-parity', 'sudo-policy:blocked', SUDO_BLOCKED_REASON);
  return allow(`sudo-policy:${policy}(${inner.rule})`);
}

/** The refusal for a sudo line whose options this parser cannot read — see `authorizeSudoLine`. */
export const SUDO_UNPARSEABLE_REASON =
  'Refused: this sudo line has a quoted option value, and the permission broker cannot reliably tell '
  + 'where sudo\'s own options end and your command begins — so it will not guess. Rewrite it with the '
  + 'command plain after sudo (for example `sudo cp a b` rather than `sudo -p "…" cp a b`).';

/** The interactive-root-shell refusal — no inner command exists to authorize. */
export const SUDO_INTERACTIVE_SHELL_REASON =
  'Refused: `sudo` with no command asks for an interactive root shell, which has nothing the '
  + 'permission broker can check. Run the specific command you need through sudo instead, so the '
  + 'floor and your grants can both see it.';

// ════════════════════════════════════════════════════════════════════════════════════════
// HONEST FAILURE — the password prompt, and the ONE command a human runs once.
//
// A non-interactive `sudo` on a box without a NOPASSWD rule does not fail: it BLOCKS on a password
// prompt nobody will ever type into, and the turn dies on a timeout with no explanation. That is
// the failure mode `gated` and `free` would otherwise ship with, and it looks like the feature is
// broken rather than unconfigured.
//
// ⚠ NO AUTOMATIC SUDOERS WRITING IN v1, by instruction and on merit: a process that edits its own
// sudoers to grant itself root is the shape every hardening guide exists to prevent, and it would
// have to run as root to do it. The platform PRINTS ONE LINE; a human runs it once.
// ════════════════════════════════════════════════════════════════════════════════════════

/** How long a probe may take before the box is treated as password-gated. */
export const SUDO_PROBE_TIMEOUT_MS = 1_500;

/**
 * The sudoers drop-in the message tells the human to install, and the scope is argued rather than
 * maximal.
 *
 * SCOPED TO THE USER, NOT TO A COMMAND LIST. A command-scoped rule (`NOPASSWD: /bin/cp`) reads
 * safer and is not: the whole point of the policy is that the agent runs the commands the OWNER's
 * box needs, which is not a list anybody can write in advance, and a half-list produces exactly the
 * silent hang this message exists to end — for the commands somebody forgot. The real boundary is
 * the one the broker enforces on every line (the floor, the sensitive-path scan, the agent's
 * grants), and `blocked` remains the setting for a box that wants no sudo at all.
 */
export function sudoersDropInLine(username: string): string {
  return `${username} ALL=(ALL) NOPASSWD: ALL`;
}

/**
 * The truthful, actionable answer when sudo would hang.
 *
 * It names WHAT happened (not a refusal — an unconfigured box), the ONE command to run, where it
 * goes, and the alternative (set the policy to `blocked`) so the reader is not cornered into
 * granting root to make a message go away.
 */
export function sudoPasswordPromptMessage(username: string, policy: SudoPolicy): string {
  return 'Refused, and this is a box-setup gap rather than a permission denial: `sudo` on this '
    + 'machine wants a password, and nothing here can type one — a non-interactive sudo would hang '
    + 'at the prompt until the turn times out, so it is not attempted.\n\n'
    + `The sudo policy is \`${policy}\`, so the command is allowed in principle. To make it actually `
    + 'work, a HUMAN runs this ONCE, by hand, in a terminal on this Mac:\n\n'
    + `    echo '${sudoersDropInLine(username)}' | sudo tee /etc/sudoers.d/dojo && sudo chmod 0440 /etc/sudoers.d/dojo\n\n`
    + 'That grants passwordless sudo to this user account. Nothing in the platform writes that file '
    + 'for you, on purpose. If you would rather not grant it, set Settings → Security → sudo policy '
    + 'to `blocked` and the agent will stop asking.';
}
