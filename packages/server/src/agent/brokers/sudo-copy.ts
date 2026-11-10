// The sudo policy's vocabulary and its copy; a LEAF, imported by the decision and owning no decision.
// A leaf on purpose: sudo-policy.ts imports platform.ts, which needs SudoPolicy; living there cycles.

export type SudoPolicy = 'blocked' | 'gated' | 'free';

/** Shipped default: a box that has never been configured GATES. */
export const SUDO_POLICY_DEFAULT: SudoPolicy = 'gated';

export const SUDO_POLICY_KEY = 'sudo_policy';

/** Refusal for a privilege token the grammar cannot place: fail closed by construction. */
export const SUDO_UNPLACEABLE_REASON =
  'Global deny: this line contains `sudo` (or `doas`) somewhere the permission broker cannot place — '
  + 'inside a substitution, a nested quote or a construct it does not parse. A line whose structure '
  + 'cannot be read is not run as root. Write the privileged command as its own plain line so the '
  + 'floor, your grants and the box policy can all see it.';

export const SUDO_BLOCKED_REASON = 'Global deny: command starting with "sudo" is prohibited';

/** The role wall: only the primary ever gets sudo; no policy value reaches it, so it speaks as the floor. */
export const SUDO_NOT_PRIMARY_REASON =
  'Global deny: sudo is reserved to the primary agent and no permission setting changes that. This '
  + 'is a role boundary, not a grant you can be given. If the work genuinely needs administrator '
  + 'rights, hand it to the primary agent (send_to_agent) and let it decide.';

export const SUDO_UNPARSEABLE_REASON =
  'Refused: this sudo line has a quoted option value, and the permission broker cannot reliably tell '
  + 'where sudo\'s own options end and your command begins — so it will not guess. Rewrite it with the '
  + 'command plain after sudo (for example `sudo cp a b` rather than `sudo -p "…" cp a b`).';

export const SUDO_INTERACTIVE_SHELL_REASON =
  'Refused: `sudo` with no command asks for an interactive root shell, which has nothing the '
  + 'permission broker can check. Run the specific command you need through sudo instead, so the '
  + 'floor and your grants can both see it.';

/** Names the one route: mention in the reply, do not retry; the policy passed in keeps the words true. */
export function sudoHeldRefusal(command: string, policy: SudoPolicy): string {
  return `[Waiting for the owner] Nothing has run, and this is not a permission you are missing. `
    + `This Mac's sudo policy is \`${policy}\`, which means an administrator command needs the owner's `
    + `yes before it executes — so \`${command}\` is now on a card in his dashboard, and that card is the `
    + `only thing between it and running. Every sudo line on this box is held the same way while the `
    + `policy is \`${policy}\`, so a different spelling, a wrapper or a retry will not get around it: `
    + `do NOT retry and do NOT look for another route. What you CAN do: finish the rest of your turn, `
    + `and if this work is what the owner is waiting on, SAY IN YOUR REPLY that an administrator command `
    + `is waiting for his approval — he may not be looking at the dashboard. If he approves, the engine `
    + `brings this exact command back to you to run. If he declines, nothing happens and nothing is `
    + `broken.`;
}

/** The owner's card: plain, engine-fixed, never model-authored; it never recommends approval. */
export function sudoOwnerCardCopy(command: string): {
  title: string; description: string; proposedFix: string; evidence: readonly string[];
} {
  return {
    title: 'Your agent wants to run an administrator command',
    description:
      'Your main agent is asking to run something as administrator (sudo) on this Mac. Nothing has '
      + 'run yet, and nothing will unless you approve it. Declining changes nothing at all. Approve it '
      + 'only if you recognise this as something you asked for — and if you would rather not be asked '
      + 'each time, Settings → Security → Administrator privileges has a setting for that in both directions.',
    proposedFix: `Run this as administrator: ${command}`,
    evidence: [
      'Administrator commands can change or remove anything on this Mac, so the agent pauses first.',
      'The platform\'s hard limits still apply: it cannot erase the disk or read your credentials '
      + 'file, whatever you choose here.',
    ],
  };
}

// A non-interactive sudo with no NOPASSWD rule does not fail: it blocks at a password prompt
// nobody types, and the turn times out. NO AUTOMATIC SUDOERS WRITING: the platform prints one line.

export const SUDO_PROBE_TIMEOUT_MS = 1_500;

/** Scoped to the USER, not a command list: a half-list reproduces the silent hang it exists to end. */
export function sudoersDropInLine(username: string): string {
  return `${username} ALL=(ALL) NOPASSWD: ALL`;
}

/** The Dojo never writes /etc/sudoers.d: the line is stated, never run. */
export function sudoPasswordPromptMessage(username: string, policy: SudoPolicy): string {
  return 'Refused, and this is a box-setup gap rather than a permission denial: `sudo` on this '
    + 'machine wants a password, and nothing here can type one, so it is not attempted (a non-interactive '
    + 'sudo would wait at the prompt until the turn times out).\n\n'
    + `The sudo policy is \`${policy}\`, so the command is allowed in principle. sudo runs without a password `
    + `for this account once /etc/sudoers.d/dojo holds this line, with mode 0440:\n\n    ${sudoersDropInLine(username)}\n\n`
    + 'The Dojo never writes that file. With Settings → Security → Administrator privileges set to `blocked`, '
    + 'the agent does not ask for sudo.';
}
