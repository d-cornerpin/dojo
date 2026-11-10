// Leaf door for admin capability: tool descriptions and the soul ask it; sudo-policy.ts alone authorizes.

import { isPrimaryAgent } from '../../config/platform.js';
import { getAgentPermissions } from '../manifest.js';
import { getSudoPolicy } from './sudo-policy.js';
import type { SudoPolicy } from './sudo-copy.js';

/** `gated` and `free` both ALLOW (the hold is filed upstream), so the words name the hold, not execution.
 *  Role wall first: no setting reaches a non-primary. The grant test cannot bite today but keeps the
 *  manifest the authority. The soul line rides the cached prefix: ask only state that moves the fingerprint. */
export function agentMayRunAdminCommands(agentId: string, policy: SudoPolicy): boolean {
  if (!isPrimaryAgent(agentId)) return false;
  if (policy === 'blocked') return false;
  const manifest = getAgentPermissions(agentId);
  return manifest.exec_allow.length > 0 || (manifest.shell_allow?.length ?? 0) > 0;
}

/** Byte-identical to prompt/templates.ts, trailing newline included: the register strips a whole line. */
export const SOUL_ADMIN_COMMANDS_LINE =
  '- You can run administrator (sudo) commands; the box\'s policy decides whether each one '
  + 'runs immediately or is held for the owner\'s approval.\n';

export function adminCommandsToolSentence(policy: SudoPolicy, finiteList: boolean): string {
  const caveat = finiteList
    ? ' The command inside the sudo line must still be one of your permitted commands — sudo raises privilege, it does not widen your command list.'
    : '';
  if (policy === 'gated') {
    return ' Administrator commands: as this box\'s primary agent you may issue a `sudo` command — it will not run immediately; it is HELD and the owner is asked to approve it on their dashboard, and the tool result will say so. Do not treat that hold as a failure and do not retry it.' + caveat;
  }
  if (policy === 'free') {
    return ' Administrator commands: as this box\'s primary agent you may issue a `sudo` command — the box\'s sudo policy runs it directly, subject to a safety floor that refuses catastrophic commands.' + caveat;
  }
  return '';
}

/** Structural type on purpose: prompt/assembler.ts imports this module; importing its type back cycles. */
export const SOUL_ADMIN_COMMANDS_CLAIM: {
  readonly line: string;
  readonly holds: (agentId: string) => boolean;
} = {
  line: SOUL_ADMIN_COMMANDS_LINE,
  holds: (agentId) => agentMayRunAdminCommands(agentId, getSudoPolicy()),
};
