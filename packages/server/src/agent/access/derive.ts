// THE SNAPSHOT: today's effective access, re-expressed as grants. Every value MEASURED, not chosen.

import type { AccessGrants, ChannelGrants, IntegrationLevel } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { isPrimaryAgent, isPMAgent } from '../../config/platform.js';
import { parseToolsPolicyText } from './tools-policy.js';

/** Role tier only; connectivity is DELIBERATELY excluded: it is a fact about the BOX, not a grant,
 *  and a grant must not claim "may not read mail" on a box that has merely not connected yet. */
function workspaceTier(primary: boolean, pm: boolean): IntegrationLevel {
  if (pm) return 'none';
  if (primary) return 'full';
  return 'read';
}

/** The primary holds every channel at 'all'; every other agent holds none. The master is false for
 *  a non-sensei agent and null for a sensei that is not the primary: it has no such toggle. */
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
      // `'*'` is a measurement, not a choice: no mechanism withholds a CATEGORY from an agent.
      categories: '*',
      // The stored `tools_policy` moves in verbatim, both directions; only its authority as a column ended.
      allow: policy.allow,
      deny: policy.deny,
    },
    integrations: {
      // plaud/credentials `true` is measurement: no mechanism withholds them, every agent holds both today.
      plaud: true,
      credentials: true,
      google: { agent: tier, user: tier },
      microsoft: { agent: tier, user: tier },
    },
    channels: channelSnapshot(primary, sensei),
    // `'*'` measures HEAD: no technique door took an agent id, so every agent ran every published one.
    techniques: '*',
  };
}

export function deriveLegacyGrants(agentId: string): AccessGrants {
  let row: AgentAccessRow | undefined;
  try {
    row = getDb()
      .prepare('SELECT classification, tools_policy FROM agents WHERE id = ?')
      .get(agentId) as AgentAccessRow | undefined;
  } catch {
    // An unreadable database must never NARROW access: an unknown id takes the non-primary snapshot.
    row = undefined;
  }
  return deriveGrantsFromRow(agentId, row);
}
