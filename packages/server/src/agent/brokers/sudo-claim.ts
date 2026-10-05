// ════════════════════════════════════════════════════════════════════════════════════════
// ONE TRUTH ABOUT ADMINISTRATOR COMMANDS — UX-ACCESS A4's fold-in of the v3.2.2 sudo door.
//
// v3.2.2 put the truth in the TOOL DESCRIPTIONS only (`agent/tools/surface.ts`), because that
// is the surface the blast proved a model believes: told "Any other command will be blocked",
// the primary never issued a sudo call at all. The soul's `## Capabilities` list said nothing
// about administrator commands, and A4 is the platform's one mechanism for *the agent checks
// its current capabilities instead of trusting memory* — so the two surfaces were one edit
// away from being able to disagree, and only one of them had an authority behind it.
//
// THIS MODULE IS THE SEAM, AND IT IS A LEAF. It owns exactly two things:
//   • the DOOR  — `agentMayRunAdminCommands`, the single predicate BOTH surfaces ask;
//   • the WORDS — the `## Capabilities` line (`prompt/templates.ts` ships it, the register in
//     `prompt/assembler.ts` strips it when the door says no) and the tool-description sentence
//     (`agent/tools/surface.ts` appends it to `exec` and `shell`).
// Nothing here parses a command or authorizes a call. That question has one home and it is
// `sudo-policy.ts`, which this module READS and never re-implements — the same discipline
// `sudo-copy.ts` keeps for the refusals an agent reads.
//
// ── WHY THE DOOR HAS THREE CONJUNCTS, each LIFTED from the authorizer, none invented ──
//  1. THE ROLE WALL. `authorizeSudoLine` refuses a non-primary BEFORE it reads the policy
//     (owner ruling 2026-09-27; `SUDO_NOT_PRIMARY_REASON` says so in the floor's voice): no
//     value of any setting reaches it. A soul asserting the line on a non-primary agent would
//     be stating a falsehood, and the per-agent `<ID>-SOUL.md` branch of `soulFileForAgent`
//     is exactly how the default `## Capabilities` list reaches an agent that is not primary.
//  2. THE POLICY. `blocked` is a refusal; `gated` and `free` both ALLOW at this layer (the
//     hold is filed upstream at dispatch, `isSudoHoldRequired`), which is why ONE line is true
//     under both and why the line names the hold instead of promising immediate execution.
//  3. A COMMAND GRANT. sudo rides `exec` or `shell`; an agent holding neither has no door to
//     knock on. `shell` is NOT stripped from the advertised surface by an empty `exec_allow`
//     — it answers to `shell_allow` (`brokers/grants.ts:129`) — so before this fold-in a
//     primary with no command grant at all was still told, on its `shell` description, that
//     it could run administrator commands. This conjunct is what makes that false reading go
//     away on both surfaces at once rather than on one of them.
//
// ── CACHE SAFETY (the tenet), stated because the soul line rides the CACHED prefix ──
// Every conjunct is per-agent or per-box state that changes rarely, and all three ALREADY move
// `computeAgentToolFingerprint` (`surface.ts`): the policy as its own field, the role as
// `primary`, the grants inside `permissions`. Nothing here reads per-turn data, so two turns of
// the same state assemble byte-identical prefixes — and when the state DOES change, the soul
// line and the tool fingerprint move in the same assembly off the same policy read.
// ════════════════════════════════════════════════════════════════════════════════════════

import { isPrimaryAgent } from '../../config/platform.js';
import { getAgentPermissions } from '../manifest.js';
import { getSudoPolicy } from './sudo-policy.js';
import type { SudoPolicy } from './sudo-copy.js';

/**
 * THE DOOR. Asked by `agent/tools/surface.ts` for the tool descriptions and, through
 * `SOUL_ADMIN_COMMANDS_CLAIM` below, by the soul capability register.
 *
 * The policy is a PARAMETER rather than a read, so the caller that already holds one does not
 * take a second — `getFilteredTools` reads it exactly once per surface build and a flip landing
 * between two reads is the defect that review finding closed (`surface.ts:154-157`).
 */
export function agentMayRunAdminCommands(agentId: string, policy: SudoPolicy): boolean {
  if (!isPrimaryAgent(agentId)) return false;
  if (policy === 'blocked') return false;
  const manifest = getAgentPermissions(agentId);
  return manifest.exec_allow.length > 0 || (manifest.shell_allow?.length ?? 0) > 0;
}

/**
 * THE `## Capabilities` LINE, byte-for-byte as `prompt/templates.ts` ships it inside
 * `DEFAULT_SOUL_MD` — trailing newline included, because the register removes a WHOLE LINE.
 *
 * It names the hold rather than promising execution, which is what makes one sentence true
 * under both `gated` and `free`; and it is deliberately the only sentence here that an owner
 * could ever see in his own `SOUL.md`, so it says what the platform does and nothing about
 * what he should want.
 */
export const SOUL_ADMIN_COMMANDS_LINE =
  '- You can run administrator (sudo) commands; the box\'s policy decides whether each one '
  + 'runs immediately or is held for the owner\'s approval.\n';

/**
 * THE TOOL-DESCRIPTION SENTENCE — relocated verbatim from `surface.ts`'s `sudoDoorSentence`,
 * which is why the wording below is unchanged down to the leading space.
 *
 * The caller has already asked the door; this function only chooses WORDS for a policy value,
 * so the two surfaces cannot disagree about WHO may knock. `finiteList` adds the caveat the
 * review demanded: sudo raises privilege, it does not widen the command list.
 */
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

/**
 * THE REGISTER ENTRY, defined here beside the door and the words rather than in the register,
 * so `prompt/assembler.ts` spells neither.
 *
 * ⚠ THE TYPE IS WRITTEN STRUCTURALLY ON PURPOSE. `SoulCapabilityClaim` lives in
 * `prompt/assembler.ts`, which imports this module; importing the type back would be the loop
 * `sudo-copy.ts`'s header refuses — a cycle the compiler tolerates only because types are
 * erased. Structural assignability is what makes the entry fit with no cycle at all.
 *
 * The policy read lives INSIDE `holds`, so the claim answers to the box's policy AT ASSEMBLY —
 * the same moment, and the same value, the tool fingerprint is computed from.
 */
export const SOUL_ADMIN_COMMANDS_CLAIM: {
  readonly line: string;
  readonly holds: (agentId: string) => boolean;
} = {
  line: SOUL_ADMIN_COMMANDS_LINE,
  holds: (agentId) => agentMayRunAdminCommands(agentId, getSudoPolicy()),
};
