// ════════════════════════════════════════════════════════════════════════════════════════
// THE SUDO POLICY'S VOCABULARY AND ITS WORDS — a LEAF, imported by the decision and by nobody's
// decision in turn.
//
// ⚠ SPLIT OUT OF `sudo-policy.ts` BECAUSE I SAID I WOULD. That file's last ratchet raise named this
// file as the next move if it grew again — it grew again (F1/F2/F3), so this is a promise being kept
// rather than a new idea, and the raise argument in `ratchets.json` is what holds me to it.
//
// WHAT BELONGS HERE: the three policy values, the config key, every refusal an agent READS, the
// owner's card, and the one line a human runs once. WHAT DOES NOT: any decision. Nothing in this file
// asks whether a line is privileged — that question has exactly one home and it is the other file.
// It mirrors `dashboard/src/lib/sudo-policy.ts`, which has held the UI's copy since round 1 for the
// same reason: copy a person reads should be findable without reading a parser.
//
// ⚠ AND IT IS A LEAF ON PURPOSE. `platform.ts` needed `SudoPolicy` and `sudo-policy.ts` imports
// `platform.ts`, so the type living there was a cycle the compiler tolerated and a reader should not
// have to. Importing a TYPE from a leaf is honest; importing it from the module that imports you is a
// loop that only works because types are erased.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The three values, and the only three. */
export type SudoPolicy = 'blocked' | 'gated' | 'free';

/** Shipped default, per the ruling. A box that has never been configured GATES. */
export const SUDO_POLICY_DEFAULT: SudoPolicy = 'gated';

/** The config row's key. One spelling, exported, so the route, the cache and the UI agree. */
export const SUDO_POLICY_KEY = 'sudo_policy';

/** The refusal for a privilege token the grammar cannot place — fail closed by construction. */
export const SUDO_UNPLACEABLE_REASON =
  'Global deny: this line contains `sudo` (or `doas`) somewhere the permission broker cannot place — '
  + 'inside a substitution, a nested quote or a construct it does not parse. A line whose structure '
  + 'cannot be read is not run as root. Write the privileged command as its own plain line so the '
  + 'floor, your grants and the box policy can all see it.';

/** The `blocked` refusal, VERBATIM what the floor said before this change. */
export const SUDO_BLOCKED_REASON = 'Global deny: command starting with "sudo" is prohibited';

/**
 * THE ROLE WALL (owner ruling 2026-09-27: *"ONLY the main agent gets Sudo access ever."*).
 *
 * It speaks in the FLOOR's voice — "Global deny" — and not in the policy's, because that is what it
 * is: no value of `sudo_policy` reaches this refusal, so telling a sub-agent that the policy refused
 * it would be false and would send it to the owner asking for a setting change that cannot help.
 * It names the ONE route that exists instead, which is the same courtesy every other floor refusal in
 * this tree extends: say what is impossible, then say what is possible.
 */
export const SUDO_NOT_PRIMARY_REASON =
  'Global deny: sudo is reserved to the primary agent and no permission setting changes that. This '
  + 'is a role boundary, not a grant you can be given. If the work genuinely needs administrator '
  + 'rights, hand it to the primary agent (send_to_agent) and let it decide.';

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

/**
 * THE OWNER'S CARD for a held primary sudo call (`gated`).
 *
 * Plain language, engine-fixed, never model-authored — the same discipline the Healer's card states.
 * It says WHAT was asked, that nothing has happened, what declining costs (nothing), and it does NOT
 * recommend approval: an administrator command on the owner's own Mac is his call, and a card that
 * nudges is a card that gets clicked through.
 */
export function sudoOwnerCardCopy(command: string): {
  title: string; description: string; proposedFix: string; evidence: readonly string[];
} {
  return {
    title: 'Your agent wants to run an administrator command',
    description:
      'Your main agent is asking to run something as administrator (sudo) on this Mac. Nothing has '
      + 'run yet, and nothing will unless you approve it. Declining changes nothing at all. Approve it '
      + 'only if you recognise this as something you asked for — and if you would rather not be asked '
      + 'each time, Settings → Security → sudo policy has a setting for that in both directions.',
    proposedFix: `Run this as administrator: ${command}`,
    evidence: [
      'Administrator commands can change or remove anything on this Mac, so the agent pauses first.',
      'The platform\'s hard limits still apply: it cannot erase the disk or read your credentials '
      + 'file, whatever you choose here.',
    ],
  };
}

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
