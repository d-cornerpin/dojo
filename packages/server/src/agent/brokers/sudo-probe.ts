// Sudo without a password prompt: answer early instead of hanging on a prompt nobody will type.

import { execFile } from 'node:child_process';
import os from 'node:os';
import { createLogger } from '../../logger.js';
import { isSudoLine } from './sudo-policy.js';
import { SUDO_PROBE_TIMEOUT_MS, sudoPasswordPromptMessage } from './sudo-copy.js';

const logger = createLogger('sudo-probe');

/** Only a YES is cached, for the process's life; a NO is re-asked: sudoers can be fixed while running. */
let passwordless: boolean | null = null;

export function resetSudoProbeCache(): void {
  passwordless = null;
}

/** `sudo -n true`: does sudo run without prompting? Never runs the caller's command. */
async function probePasswordless(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = execFile('sudo', ['-n', 'true'], { timeout: SUDO_PROBE_TIMEOUT_MS }, (err) => {
      // Any error answers NO, fail closed: a wrong "yes" hangs, a wrong "no" prints an actionable message.
      resolve(!err);
    });
    child.on('error', () => resolve(false));
  });
}

/** The message to return instead of running a hanging sudo line; null = carry on. */
export async function sudoWouldHang(command: string): Promise<string | null> {
  const trimmed = command.trim();
  if (!isSudoLine(trimmed) && !/(^|[\s;&|(])sudo\s/.test(trimmed)) return null;
  if (passwordless !== true) {
    const probe = await probePasswordless();
    if (probe) passwordless = true;
    logger.info('sudo passwordless probe', { passwordless: probe });
  }
  if (passwordless) return null;
  return sudoPasswordPromptMessage(os.userInfo().username);

}
