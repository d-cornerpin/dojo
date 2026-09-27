// ════════════════════════════════════════════════════════════════════════════════════════
// SUDO WITHOUT A PASSWORD PROMPT — the honest failure (owner ruling 2026-09-26, v3.2.2).
//
// ── THE FAILURE THIS EXISTS TO END ───────────────────────────────────────────────────────────
// Making `sudo` a policy is only half the feature. On a box with no NOPASSWD rule, a sudo line run
// from a daemon does not fail — IT BLOCKS ON A PASSWORD PROMPT nobody will ever type into. The
// process sits there until the tool timeout kills it, and the agent reports a timeout. The owner
// reads that as "the sudo feature is broken", which is the one impression a newly-shipped setting
// cannot afford, and the actual state — an unconfigured sudoers — is never mentioned.
//
// ── WHY A PROBE AND NOT A TIGHTER TIMEOUT ────────────────────────────────────────────────────
// A tight timeout on the real command cannot tell "waiting for a password" from "this build takes
// twenty seconds", and shortening the real timeout would break every legitimate long sudo. `sudo -n`
// asks sudo itself the question — "would you need to prompt?" — and answers immediately, without
// running anything. It is the same question the failure is about, asked of the only authority on it.
//
// ⚠ AND IT IS `-n true`, NOT `-n <the real command>`. Probing with the real command would RUN it when
// the answer is yes, which is exactly the side effect a probe must not have. `true` is a no-op.
//
// ── NO AUTOMATIC SUDOERS WRITING IN v1, by instruction and on merit ──────────────────────────
// A process that edits its own sudoers to grant itself root is the shape every hardening guide warns
// about, and it would need root to do it — the very thing it is trying to obtain. So the platform
// PRINTS ONE LINE and a human runs it once, by hand. `sudoPasswordPromptMessage` is that line's home.
// ════════════════════════════════════════════════════════════════════════════════════════

import { execFile } from 'node:child_process';
import os from 'node:os';
import { createLogger } from '../../logger.js';
import { getSudoPolicy, isSudoLine } from './sudo-policy.js';
import { SUDO_PROBE_TIMEOUT_MS, sudoPasswordPromptMessage } from './sudo-copy.js';

const logger = createLogger('sudo-probe');

/**
 * Cached per process, because the answer changes only when a human edits sudoers.
 *
 * `null` = not yet probed. A positive answer (passwordless works) is cached for the life of the
 * process; a NEGATIVE answer is cached too, and that is the deliberate part — the alternative is
 * probing on every sudo call of a box that will keep saying no, and the message tells the human the
 * change needs a restart-free path only if they ask for one. `resetSudoProbeCache` exists for tests
 * and for the settings route to call when the policy changes.
 */
let passwordless: boolean | null = null;

export function resetSudoProbeCache(): void {
  passwordless = null;
}

/** `sudo -n true` — does sudo run without prompting? Never runs the caller's command. */
async function probePasswordless(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = execFile('sudo', ['-n', 'true'], { timeout: SUDO_PROBE_TIMEOUT_MS }, (err) => {
      // Any error at all — a non-zero exit, `sudo: a password is required`, sudo missing, the
      // timeout — answers NO. Fail-closed is right here: a wrong "yes" hands the caller the hang
      // this module exists to prevent, while a wrong "no" prints an actionable message.
      resolve(!err);
    });
    child.on('error', () => resolve(false));
  });
}

/**
 * If this command is a sudo line that would hang, the message to return INSTEAD of running it.
 * `null` means "carry on" — either it is not sudo, or sudo is passwordless here.
 *
 * Returns `null` under the `blocked` policy as well, and deliberately: a blocked box never reaches
 * execution (the broker's floor refused it long before), so a probe here would be dead code that
 * spawns a process. Under `free` and `gated` the command HAS been authorized, so the only thing
 * standing between it and running is the password.
 */
export async function sudoWouldHang(command: string): Promise<string | null> {
  const trimmed = command.trim();
  if (!isSudoLine(trimmed) && !/(^|[\s;&|(])sudo\s/.test(trimmed)) return null;
  const policy = getSudoPolicy();
  if (policy === 'blocked') return null;
  if (passwordless === null) {
    passwordless = await probePasswordless();
    logger.info('sudo passwordless probe', { passwordless, policy });
  }
  if (passwordless) return null;
  return sudoPasswordPromptMessage(os.userInfo().username, policy);
}
