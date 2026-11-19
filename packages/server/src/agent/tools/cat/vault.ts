// VAULT: the seven tools `tools/categories.ts` files under "Vault (Long-Term
// Memory)", plus `lesson_record`. The bodies are the switch bodies, unchanged.
// The vault and platform modules are STATIC imports here: none of them imports
// anything from the toolbox, so none of these lines can form an import cycle.

import {
  executeVaultRemember, executeVaultSearch, executeVaultForget, executeVaultExpand, executeVaultUpdate,
} from '../../../vault/tools.js';
import { getPinnedEntries, getSessionContextEntries, discardConversation } from '../../../vault/store.js';
import { isDreamerAgent, isPrimaryAgent } from '../../../config/platform.js';
import { recordLesson, LessonRefused } from '../../../vault/lessons-store.js';
import { auditLog, toolsLogger as logger } from '../util.js';
import type { ToolHandlerMap } from '../handler.js';

export const vaultHandlers: ToolHandlerMap = {
  async vault_remember({ agentId, args }) {
    const content = await executeVaultRemember(agentId, args);
    // Bounces ("Too long…", "Reads like narrative prose…", "Refused:…",
    // "Near-duplicate:…") do not start with "Error", so startsWith('Error')
    // would read a rejected save as SUCCESS to every downstream mechanism.
    // Grade every bounce shape as a real tool error.
    return { content, isError: /^(Error|Too long|Reads like narrative prose|Refused|Near-duplicate)/.test(content) };
  },

  async vault_search({ agentId, args }) {
    const content = await executeVaultSearch(agentId, args);
    return { content, isError: content.startsWith('Error') };
  },

  async vault_get({ agentId, args }) {
    const content = executeVaultExpand(agentId, args);
    return { content, isError: content.startsWith('Error') };
  },

  async vault_refresh({ agentId }) {
    // Return the snapshot the assembler would have injected at session start:
    // pinned plus session_context-tagged entries.
    try {
      // Scoped to the calling agent's own vault (per-agent design).
      const pinned = getPinnedEntries(agentId);
      const sessionCtx = getSessionContextEntries(agentId);
      // Dedupe (a pinned entry might also be tagged session_context).
      const seen = new Set<string>();
      const merged: typeof pinned = [];
      for (const e of [...pinned, ...sessionCtx]) {
        if (!seen.has(e.id)) { seen.add(e.id); merged.push(e); }
      }
      if (merged.length === 0) {
        return {
          content: 'Vault refresh: no pinned or session_context-tagged entries found. Use vault_remember(content, pin=true) or vault_remember(content, tags=["session_context"]) to add some.',
          isError: false,
        };
      }
      const lines = merged.map((e) => {
        const flags: string[] = [];
        if (e.isPinned) flags.push('pinned');
        if (e.isPermanent) flags.push('permanent');
        if (e.tags?.includes('session_context')) flags.push('session_context');
        const flagStr = flags.length > 0 ? ` {${flags.join(',')}}` : '';
        return `[${e.type}]${flagStr} ${e.content}\n  ID: ${e.id}`;
      });
      return { content: `Vault snapshot (${merged.length} entries):\n\n${lines.join('\n\n')}`, isError: false };
    } catch (err) {
      return { content: `Error refreshing vault: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async vault_forget({ agentId, args }) {
    const content = executeVaultForget(agentId, args);
    return { content, isError: content.startsWith('Error') };
  },

  async vault_update({ agentId, args }) {
    const content = await executeVaultUpdate(agentId, args);
    return { content, isError: content.startsWith('Error') };
  },

  async vault_discard_archives({ agentId, args }) {
    // The Dreamer and the main agent only; any other caller gets an error, not a silent delete.
    if (!isDreamerAgent(agentId) && !isPrimaryAgent(agentId)) {
      return { content: 'Error: vault_discard_archives is for the Dreamer and the main agent only.', isError: true };
    }
    const archiveIds = (args.archive_ids as unknown[] | undefined)?.filter((id): id is string => typeof id === 'string') ?? [];
    const reason = (args.reason as string | undefined)?.trim() || '(no reason given)';
    if (archiveIds.length === 0) {
      return { content: 'Error: archive_ids is required and must contain at least one ID.', isError: true };
    }
    let deleted = 0;
    const skipped: string[] = [];
    for (const id of archiveIds) {
      try {
        const ok = discardConversation(id);
        if (ok) deleted++;
        else skipped.push(id);
      } catch {
        skipped.push(id);
      }
    }
    auditLog(agentId, 'tool_call', 'vault_discard_archives', 'success',
      `deleted=${deleted} skipped=${skipped.length} reason=${reason.slice(0, 200)}`,
    );
    logger.info('Dreamer discarded vault archives', {
      deleted, skipped: skipped.length, reason: reason.slice(0, 200),
    }, agentId);
    const content = `Discarded ${deleted} archive${deleted === 1 ? '' : 's'}` +
      (skipped.length > 0 ? `. ${skipped.length} archive ID${skipped.length === 1 ? '' : 's'} could not be deleted (already gone or invalid): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''}` : '.');
    return { content, isError: false };
  },

  async lesson_record({ agentId, args }) {
    // The Dreamer and the main agent only; the one door into the lessons table (vault/lessons-store.ts validates).
    if (!isDreamerAgent(agentId) && !isPrimaryAgent(agentId)) return { content: 'Error: lesson_record is for the Dreamer and the main agent only.', isError: true };
    try {
      const { id, renewed } = await recordLesson({
        taskId: String(args.task_id ?? ''), cue: String(args.cue ?? ''), lesson: String(args.lesson ?? ''),
        evidenceEventIds: Array.isArray(args.evidence_event_ids) ? (args.evidence_event_ids as unknown[]).map(Number) : [],
        confidence: Number(args.confidence),
      });
      auditLog(agentId, 'tool_call', 'lesson_record', 'success', `lesson=${id} renewed=${renewed}`);
      return { content: renewed ? `Lesson ${id} renewed (this cue was already held).` : `Lesson ${id} recorded.`, isError: false };
    } catch (err) {
      if (err instanceof LessonRefused) return { content: err.message, isError: true };
      return { content: `Error recording lesson: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};
