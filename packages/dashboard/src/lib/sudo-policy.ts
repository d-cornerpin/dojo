// The sudo policy as the dashboard shows it. The rule lives here, not in the Settings component,
// so the server suite can ask about it; the component renders what this file decides.

export type SudoPolicy = 'blocked' | 'gated' | 'free';

/** Shipped default. A box that has never been configured GATES. */
export const SUDO_POLICY_DEFAULT: SudoPolicy = 'gated';

export const SUDO_POLICY_KEY = 'sudo_policy';

export const SUDO_POLICY_ORDER: readonly SudoPolicy[] = ['blocked', 'gated', 'free'];

export const SUDO_POLICY_LABELS: Record<SudoPolicy, string> = {
  blocked: 'Blocked, admin commands are refused',
  gated: 'Gated, admin commands need your approval (default)',
  free: 'Free, admin commands run without asking',
};

export const SUDO_POLICY_HINTS: Record<SudoPolicy, string> = {
  blocked:
    'Your MAIN AGENT’s ADMIN commands (sudo, and the macOS administrator-privileges prompt) are refused '
    + 'existed. Pick this if you would rather nothing here touch anything needing administrator rights.',
  gated:
    'Your MAIN AGENT’s ADMIN command is held and you get a card to approve or decline, one approval, '
    + 'one run, and nothing runs while it waits. This is the shipped default.',
  free:
    'Your MAIN AGENT’s ADMIN commands run like any other command. The safety floor still applies (see '
    + 'below), and it is still limited to the commands its own permissions allow.',
};

/** The sentence that must appear under every value: it is true under all three. */
export const SUDO_FLOOR_NOTE =
  'ONE POLICY, EVERY ADMIN DOOR: this covers sudo AND the AppleScript / osascript “with administrator '
  + 'privileges” prompt, which reaches the same power under a different name. It governs your MAIN '
  + 'AGENT ONLY, every other agent is refused admin rights outright under all three settings, a role '
  + 'boundary that no setting changes. And under every setting the platform’s hard floor still applies '
  + 'inside an admin command: '
  + 'sudo rm -rf /, sudo rm -rf ~, sudo chmod 777 and anything touching the credentials file are '
  + 'refused. Sudo is unwrapped and the whole permission check re-runs on the command inside it, so '
  + 'this setting can never widen an agent past its own permissions.';

/** An unknown or missing stored value reads as the default, never as `free`. */
export function readSudoPolicy(stored: string | null | undefined): SudoPolicy {
  return stored === 'blocked' || stored === 'gated' || stored === 'free' ? stored : SUDO_POLICY_DEFAULT;
}

export function sudoPolicyWarning(policy: SudoPolicy): string | null {
  if (policy !== 'free') return null;
  // "Heads up" is a reserved owner-alert marker owned by shared/src/visibility.ts, hence "Note:".
  return 'Note: sudo on this Mac may still ask for a password, and nothing here can type one. '
    + 'If the agent reports that, it will print the one command to run once by hand to fix it.';
}
