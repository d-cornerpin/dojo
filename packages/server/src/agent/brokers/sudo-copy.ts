// The administrator-rights copy: a LEAF, so sudo-policy.ts and sudo-probe.ts can both read it.

/** Refusal for a privilege token the grammar cannot place: fail closed by construction. */
export const SUDO_UNPLACEABLE_REASON =
  'Global deny: this line contains `sudo` (or `doas`) somewhere the permission broker cannot place — '
  + 'inside a substitution, a nested quote or a construct it does not parse. A line whose structure '
  + 'cannot be read is not run as root. Write the privileged command as its own plain line so the '
  + 'floor and your grants can both see it.';

/** The role wall: only the primary ever gets sudo; no setting reaches it, so it speaks as the floor. */
export const SUDO_NOT_PRIMARY_REASON =
  'Global deny: sudo is reserved to the primary agent and no permission setting changes that. This '
  + 'is a role boundary, not a grant you can be given. If the work genuinely needs administrator '
  + 'rights, hand it to the primary agent (send_to_agent) and let it decide.';

// A non-interactive sudo with no NOPASSWD rule does not fail: it blocks at a password prompt
// nobody types, and the turn times out. NO AUTOMATIC SUDOERS WRITING: the platform prints one line.

export const SUDO_PROBE_TIMEOUT_MS = 1_500;

/** Scoped to the USER, not a command list: a half-list reproduces the silent hang it exists to end. */
export function sudoersDropInLine(username: string): string {
  return `${username} ALL=(ALL) NOPASSWD: ALL`;
}

/** The Dojo never writes /etc/sudoers.d: the line is stated, never run. */
export function sudoPasswordPromptMessage(username: string): string {
  return 'Not run, and this is a box-setup gap rather than a permission denial: `sudo` on this '
    + 'machine wants a password, and nothing here can type one (a non-interactive sudo would wait '
    + 'at the prompt until the turn times out).\n\n'
    + `sudo runs without a password for this account once /etc/sudoers.d/dojo holds this line, with mode 0440:\n\n    ${sudoersDropInLine(username)}\n\n`
    + 'The Dojo never writes that file.';
}
