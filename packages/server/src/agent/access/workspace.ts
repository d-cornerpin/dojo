// ════════════════════════════════════════════════════════════════════════════
// THE WORKSPACE DOORS, PER ACCOUNT (UX-ACCESS A1).
//
// Census C4: `getAgentGoogleAccessLevel(_agentId, isPrimary, isPM)` and its
// Microsoft twin ignore their own agent argument — *"the underscore is the code
// admitting it"* — so which mailbox an agent may touch was a property of the
// TOOL NAME (`user_`-prefixed → the owner's account, unprefixed → the agent's)
// and of one role ladder shared by every agent on the box. "Read work mail but
// not personal mail" had nowhere to live.
//
// It lives here. The account KIND is still read off the tool name, because that
// is what the name genuinely encodes and nothing about that was wrong; what is
// new is that the kind is then looked up in THIS agent's grants instead of a
// ladder. Post-migration both kinds carry the same tier for every agent, so
// every verdict below is identical to HEAD's.
//
// ── AND THE SEND HALF IS A CHANNEL QUESTION, NOT A WRITE-TIER ONE ──
// `gmail_send` is two different permissions wearing one name: it writes to a
// Workspace account AND it reaches a human. The write tier answers the first;
// the channel grant answers the second. Both must pass, which is what makes
// "may draft in my calendar, may not email anyone" expressible.
// ════════════════════════════════════════════════════════════════════════════

import type { AccountKind } from '@dojo/shared';
import { channelForTool } from './channels.js';
import { integrationLevelFor, mayUseChannel } from './read.js';

export type WorkspaceProvider = 'google' | 'microsoft';

/** The account kind a tool routes to — the lexical binding, verbatim
 *  (`surface.ts:446-448`, `provider/mailbox-banner.ts:74`). */
export function accountKindForTool(tool: string): AccountKind {
  return tool.startsWith('user_') ? 'user' : 'agent';
}

/** May this agent READ through this tool's account? `none` is the only refusal:
 *  a `read` grant is exactly what a read tool needs. */
export function mayReadWorkspace(agentId: string, tool: string, provider: WorkspaceProvider): boolean {
  return integrationLevelFor(agentId, provider, accountKindForTool(tool)) !== 'none';
}

/**
 * May this agent WRITE through this tool's account?
 *
 * Two conjuncts, and the second one is why this function exists rather than a
 * bare level compare at each call site: a write tool that also REACHES A PERSON
 * (`gmail_send`, `outlook_reply`, `teams_send_message` and their `user_` twins —
 * the build-checked `SEND_TO_PEOPLE` surface) additionally needs the channel
 * grant. An agent with `full` Workspace access and no email channel may create
 * a calendar event and may not send a mail, which is the owner's own "Reader"
 * exemplar with the write half turned on.
 */
export function mayWriteWorkspace(agentId: string, tool: string, provider: WorkspaceProvider): boolean {
  if (integrationLevelFor(agentId, provider, accountKindForTool(tool)) !== 'full') return false;
  const channel = channelForTool(tool);
  return channel === null || mayUseChannel(agentId, channel);
}
