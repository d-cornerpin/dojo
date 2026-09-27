// ════════════════════════════════════════════════════════════════════════════════════════
// THE SUDO POLICY, AS THE DASHBOARD SHOWS IT — owner ruling 2026-09-26, ships v3.2.2.
//
// The rule lives HERE rather than inside the Settings component for the reason every other
// `lib/` rule in this folder does: a decision embedded in JSX is a decision no test can ask about
// without mounting a page. The component renders what this file decides.
//
// ── WHAT THE COPY HAS TO GET RIGHT, because it is the only place the owner meets this ──────────
// Three things, and the third is the one a careless dropdown would omit:
//   1. what each value DOES, in the order of increasing authority;
//   2. that `gated` is the shipped default, so nobody wonders what a fresh box does;
//   3. THAT THE FLOOR STILL BITES. `free` does not mean "anything": `sudo rm -rf /` is refused
//      under every value, because the broker strips the wrapper and re-runs its whole pipeline over
//      the inner command before policy is consulted. An owner who reads `free` as "no limits" will
//      eventually be surprised by a refusal, and a surprise about a safety floor is a support
//      ticket that ends in "the permissions are broken".
// ════════════════════════════════════════════════════════════════════════════════════════

/** The three values, mirroring the server's `SudoPolicy`. */
export type SudoPolicy = 'blocked' | 'gated' | 'free';

/** Shipped default. A box that has never been configured GATES. */
export const SUDO_POLICY_DEFAULT: SudoPolicy = 'gated';

/** The config row this dropdown reads and writes. */
export const SUDO_POLICY_KEY = 'sudo_policy';

/** Increasing authority, and the dropdown renders them in exactly this order. */
export const SUDO_POLICY_ORDER: readonly SudoPolicy[] = ['blocked', 'gated', 'free'];

export const SUDO_POLICY_LABELS: Record<SudoPolicy, string> = {
  blocked: 'Blocked — sudo is refused',
  gated: 'Gated — sudo needs approval (default)',
  free: 'Free — sudo runs without asking',
};

export const SUDO_POLICY_HINTS: Record<SudoPolicy, string> = {
  blocked:
    'Any command starting with sudo is refused outright, the way it was before this setting existed. '
    + 'Pick this if you would rather the agent never touch anything that needs root.',
  gated:
    'A sudo command is held and routed for approval through the same card destructive actions use — '
    + 'one approval, one run. This is the shipped default.',
  free:
    'Sudo commands run like any other command. The safety floor still applies (see below), and each '
    + 'agent is still limited to the commands its own permissions allow.',
};

/**
 * The sentence that must appear whatever the value is.
 *
 * Not a hint on one option — a standing statement under all three, because it is true under all
 * three and it is the thing an owner is most likely to get wrong about `free`.
 */
export const SUDO_FLOOR_NOTE =
  'Under every setting, the platform’s hard floor still applies inside a sudo command: '
  + 'sudo rm -rf /, sudo rm -rf ~, sudo chmod 777 and anything touching the credentials file are '
  + 'refused. Sudo is unwrapped and the whole permission check re-runs on the command inside it, so '
  + 'this setting can never widen an agent past its own permissions.';

/** An unknown or missing stored value reads as the default — never as `free`. */
export function readSudoPolicy(stored: string | null | undefined): SudoPolicy {
  return stored === 'blocked' || stored === 'gated' || stored === 'free' ? stored : SUDO_POLICY_DEFAULT;
}

/**
 * Does choosing this value deserve a warning beside the dropdown, and what does it say?
 *
 * `free` is the only one, and the warning is about the PASSWORD rather than about danger: the
 * setting does nothing on a box whose sudo prompts, and saying so here is what stops "I set it to
 * free and nothing happened". `blocked` gets no warning — it is the conservative end — and `gated`
 * gets none because it is the default.
 */
export function sudoPolicyWarning(policy: SudoPolicy): string | null {
  if (policy !== 'free') return null;
  // ⚠ NOT "Heads up" — that literal is a RESERVED OWNER-ALERT MARKER owned by
  // `shared/src/visibility.ts`, and `marker-ownership.test.ts` refuses a second copy of it. Caught by
  // that census, not by review.
  return 'Note: sudo on this Mac may still ask for a password, and nothing here can type one. '
    + 'If the agent reports that, it will print the one command to run once by hand to fix it.';
}
