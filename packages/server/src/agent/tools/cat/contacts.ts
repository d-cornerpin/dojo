// ════════════════════════════════════════════════════════════════════════════
// DOJO Contacts (7 tools) + Squad Coordination (2 tools), one module because they shared
// a run of the switch.
// The `await import('../contacts/tools.js')` calls are kept on purpose: pinned sanctioned,
// moving with their handlers. `contacts/tools.js` imports nothing from the toolbox, so they
// could also be static; the squad vault calls are static.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../../db/connection.js';
import { vaultRememberInNamespace, vaultSearchInNamespace, resolveAgentNamespace } from '../../../vault/namespaces.js';
import { coerceNumberArg } from '../pagination.js';
import type { ToolHandlerMap } from '../handler.js';

export const contactsHandlers: ToolHandlerMap = {
  async contact_remember({ agentId, args }) {
    const { executeContactRemember } = await import('../../../contacts/tools.js');
    const content = executeContactRemember(agentId, args);
    return { content, isError: content.startsWith('Error') };
  },

  async contact_search({ args }) {
    const { executeContactSearch } = await import('../../../contacts/tools.js');
    const content = executeContactSearch(args);
    return { content, isError: content.startsWith('Error') };
  },

  async contact_list({ args }) {
    const { executeContactList } = await import('../../../contacts/tools.js');
    const content = executeContactList(args);
    return { content, isError: content.startsWith('Error') };
  },

  async contact_get({ args }) {
    const { executeContactGet } = await import('../../../contacts/tools.js');
    const content = executeContactGet(args);
    return { content, isError: content.startsWith('Error') };
  },

  async contact_update({ agentId, args }) {
    const { executeContactUpdate } = await import('../../../contacts/tools.js');
    const content = executeContactUpdate(agentId, args);
    return { content, isError: content.startsWith('Error') };
  },

  async contact_forget({ args }) {
    const { executeContactForget } = await import('../../../contacts/tools.js');
    const content = executeContactForget(args);
    return { content, isError: content.startsWith('Error') };
  },

  async contacts_overview() {
    const { executeContactDescribe } = await import('../../../contacts/tools.js');
    return { content: executeContactDescribe(), isError: false };
  },

  // Squad Coordination

  async squad_share({ agentId, args }) {
    const namespace = resolveAgentNamespace(agentId);
    if (!namespace) {
      return {
        content: 'Error: You are not a member of any squad (no group_id). squad_share / squad_recall are only available to agents in a group. Use vault_remember instead, or ask your owner to assign you to a group.',
        isError: true,
      };
    }
    const shareContent = (args.content as string | undefined)?.trim();
    if (!shareContent) {
      return { content: 'Error: content is required.', isError: true };
    }
    const tags = (args.tags as unknown[] | undefined)?.filter((t): t is string => typeof t === 'string') ?? [];
    const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    const entry = await vaultRememberInNamespace({
      agentId,
      agentName: agentRow?.name,
      namespace,
      content: shareContent,
      tags,
    });
    return { content: `Shared to ${namespace}. Entry id: ${entry.id}.`, isError: false };
  },

  async squad_recall({ agentId, args }) {
    const namespace = resolveAgentNamespace(agentId);
    if (!namespace) {
      return {
        content: 'Error: You are not a member of any squad (no group_id). squad_recall is only available to agents in a group.',
        isError: true,
      };
    }
    const query = (args.query as string | undefined) ?? '';
    const tag = args.tag as string | undefined;
    const limitArg = coerceNumberArg(args.limit);
    const limit = limitArg !== null && limitArg >= 1 ? Math.floor(limitArg) : 5;
    const matches = vaultSearchInNamespace({ namespace, query, tag, limit });
    if (matches.length === 0) {
      return { content: `No squad memory entries match in ${namespace}.`, isError: false };
    }
    const lines = matches.map((m) => {
      const author = m.agentName ?? m.agentId;
      const tagStr = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
      return `- ${author} (${m.createdAt}): ${m.snippet}${tagStr}\n  ID: ${m.id} | Length: ${m.fullLength} chars (use vault_get to read full).`;
    });
    const content = `Squad memory (${matches.length} match${matches.length === 1 ? '' : 'es'} in ${namespace}):\n\n${lines.join('\n\n')}`;
    return { content, isError: false };
  },
};
