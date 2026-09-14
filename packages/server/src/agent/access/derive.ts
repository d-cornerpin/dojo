// ════════════════════════════════════════════════════════════════════════════
// THE SNAPSHOT (UX-ACCESS A1) — today's effective access, re-expressed as grants.
//
// This is the migration, and the migration is the whole phase. Owner ruling 3:
// *"Sensei agents other than the primary keep EXACTLY their current effective
// permissions … migrated to declared, owner-editable grants byte-equivalent in
// effect. The primary keeps everything."* So the honest way to write the new
// authority is not to invent a policy — it is to MEASURE the old one.
//
// Every field below is a transcription of a mechanism the census located, cited
// on its own line. Nothing here decides anything; if a line does not match the
// mechanism it cites, the before/after capability diff is non-empty and the
// proof fails, which is exactly the instrument this file is meant to be checked
// by (`__tests__/access-migration-parity.test.ts`).
//
// ── WHY DERIVATION IS LAZY AND MATERIALIZATION IS SEPARATE ──
// `getAccessGrants` falls back to this function for any agent with no stored
// grants, so an un-migrated agent behaves exactly as it did at HEAD *by
// construction* rather than by a backfill having run. `materialize.ts` then
// writes the same value into the row so the owner has something to EDIT — which
// is ruling 3's other half (the boot rewriter retires so edits stop reverting).
// Materialization is therefore provably a no-op: stored equals derived.
// ════════════════════════════════════════════════════════════════════════════

import type { AccessGrants, ChannelGrants, IntegrationLevel } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { isPrimaryAgent, isPMAgent } from '../../config/platform.js';
import { parseToolsPolicyText } from './tools-policy.js';

/** The identity-derived Workspace tier, with connectivity DELIBERATELY excluded.
 *
 *  `getAgentGoogleAccessLevel` (google/auth.ts:761) answers `'none'` when no
 *  account is connected or the provider is disabled — a fact about the BOX, not
 *  a grant held by the agent. Folding it in here would write "this agent may not
 *  read mail" into a row on a box that merely has not connected yet, and the
 *  grant would then survive the connection. So the grant carries the role tier
 *  (`isPM → none`, `isPrimary → full`, else `read` — the ladder verbatim) and
 *  connectivity stays where it is, ANDed at the door.
 */
function workspaceTier(primary: boolean, pm: boolean): IntegrationLevel {
  if (pm) return 'none';
  if (primary) return 'full';
  return 'read';
}

/**
 * THE CHANNEL SNAPSHOT — and it is one line of truth from the census.
 *
 * §0: *"every outbound human channel — iMessage, SMS, voice, email send, Teams
 * send — is gated on `isPrimaryAgent(agentId)`."* There is no second tier and no
 * row to write, so the migration is exact: the primary holds every channel, at
 * the `'all'` tier (an agent that can `imessage_send` today can message every
 * approved contact, §2.3), and every other agent holds none.
 *
 * The MASTER follows owner ruling 1 rather than the old mechanism, because the
 * old mechanism had no master to copy: every non-sensei agent gets one (`false`
 * — they hold no channel today); a sensei that is not the primary gets `null`,
 * meaning it has no such toggle and communicates through the main agent.
 */
function channelSnapshot(primary: boolean, sensei: boolean): ChannelGrants {
  if (primary) {
    return { master: true, imessage: 'all', sms: 'all', voice: 'all', email: 'all', teams: 'all' };
  }
  return {
    master: sensei ? null : false,
    imessage: 'none', sms: 'none', voice: 'none', email: 'none', teams: 'none',
  };
}

interface AgentAccessRow {
  classification: string | null;
  tools_policy: string | null;
}

/** The agent's own columns this snapshot reads. Separated so the parity test can
 *  drive the derivation without a live agents table. */
export function deriveGrantsFromRow(
  agentId: string,
  row: AgentAccessRow | undefined,
  primary = isPrimaryAgent(agentId),
  pm = isPMAgent(agentId),
): AccessGrants {
  const sensei = row?.classification === 'sensei';
  const policy = parseToolsPolicyText(row?.tools_policy);
  const tier = workspaceTier(primary, pm);
  return {
    v: 1,
    tools: {
      // `'*'` and not an enumeration, and that is a measurement rather than a
      // choice: no mechanism at HEAD withholds a CATEGORY from an agent, so the
      // honest snapshot of "which categories does this agent hold" is "all of
      // them". The positive category layer is live (surface.ts filters on it)
      // and simply refuses nothing until an owner or a spawn narrows it — which
      // is what makes A1 invisible and A3's panel meaningful.
      categories: '*',
      // `tools_policy` moves into the object VERBATIM, both directions. Its
      // semantics are unchanged in A1 (the census records at C2 that `allow`
      // restricts rather than grants); what changed is that the column stopped
      // being an authority, which is what lets the boot rewriters retire.
      allow: policy.allow,
      deny: policy.deny,
    },
    integrations: {
      // surface.ts:594 pushes the Plaud set with NO identity check — every agent
      // that exists gets it when the box is connected (census C13, and the PM
      // getting it despite `none` for both Workspace providers is the proof).
      plaud: true,
      // surface.ts:604 pushes the credential tools unconditionally and
      // `gatesForCall` mints no `secrets` gate, so every agent may read, update
      // or delete every credential today (census C3). `true` is that fact —
      // A1 wrote `'*'` here, and UX-ACCESS A5 collapsed the field to the boolean
      // the owner edits, which is the same measurement in the shape that can now
      // be stated on screen.
      credentials: true,
      google: { agent: tier, user: tier },
      microsoft: { agent: tier, user: tier },
    },
    channels: channelSnapshot(primary, sensei),
    // UX-ACCESS A4. `'*'` is a measurement, not a policy: `checkTechniqueAccess`
    // (techniques/tools.ts:543) refuses on STATE and squad membership and takes
    // no agent id at all, the published index takes none either, and the matcher
    // offers `listTechniques({state:'published'})` to every non-PM agent. So at
    // HEAD every agent may run every published technique, and the snapshot says
    // so. What is new is that an owner can now narrow it.
    techniques: '*',
  };
}

/** This agent's current effective access, as grants. One SELECT. */
export function deriveLegacyGrants(agentId: string): AccessGrants {
  let row: AgentAccessRow | undefined;
  try {
    row = getDb()
      .prepare('SELECT classification, tools_policy FROM agents WHERE id = ?')
      .get(agentId) as AgentAccessRow | undefined;
  } catch {
    // A database that cannot be read must never NARROW access — the same
    // posture `grantFor` takes (brokers/grants.ts:241). An unknown agent falls
    // through to the non-sensei, non-primary snapshot below, which is what
    // `getAgentPermissions` already does for an id that is not in the table.
    row = undefined;
  }
  return deriveGrantsFromRow(agentId, row);
}
