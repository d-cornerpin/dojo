// ════════════════════════════════════════════════════════════════════════════
// VAULT (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// The seven tools `tools/categories.ts` files under "Vault (Long-Term Memory)".
//
// RELOCATION, NOT REWRITE. Each body is the body that stood in the switch,
// byte-faithful; only the trailing `content = …; break;` became a `return`.
// `vault_remember`'s bounce-shape regex, `vault_refresh`'s own try/catch, and
// `vault_discard_archives`'s Dreamer-only refusal are carried across exactly as
// they were, including the audit row's `'tool_call'` action type and the log
// line's field names.
//
// ── THE DYNAMIC IMPORTS THAT DIED HERE ──
// The bodies fetched `../vault/store.js` twice and `../config/platform.js` once
// through `await import(…)`. Measured at this HEAD: neither module imports
// anything from the toolbox, so neither call broke a cycle, and neither is on
// §T0-PINS P8's pinned sanctioned list. They are static imports now.
// `isDreamerAgent` in particular was already imported statically by
// `agent/tools.ts` — the lazy fetch was a second route to the same symbol.
// ════════════════════════════════════════════════════════════════════════════

import {
  executeVaultRemember, executeVaultSearch, executeVaultForget, executeVaultExpand, executeVaultUpdate,
} from '../../../vault/tools.js';
import { getPinnedEntries, getSessionContextEntries, deleteConversation } from '../../../vault/store.js';
import { isDreamerAgent } from '../../../config/platform.js';
import { auditLog, toolsLogger as logger } from '../util.js';
import type { ToolHandlerMap } from '../handler.js';

export const vaultHandlers: ToolHandlerMap = {
  async vault_remember({ agentId, args }) {
    const content = await executeVaultRemember(agentId, args);
    // RC-13: vault_remember bounces return plain refusal strings that do NOT
    // start with "Error" ("Too long…", "Reads like narrative prose…",
    // "Refused:…", "Near-duplicate:…"). Left as startsWith('Error') they read
    // as SUCCESS to every downstream mechanism (the bookkeeping "reply
    // 'Saved.'" nudge, recordToolOutcome's failure ledger). Treat every bounce
    // shape as a real tool error so a rejected save never masquerades as done.
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
    // Phase 4 §C, return the snapshot the assembler would have injected
    // at session start (pinned + session_context-tagged entries).
    try {
      // W3-4: scoped to the calling agent's own vault (per-agent design).
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
    // Dreamer-only, silently no-op for everyone else so the dispatcher
    // doesn't crash if a non-Dreamer agent somehow calls it. The
    // permission gate at tools-policy / always-loaded should prevent
    // this anyway.
    if (!isDreamerAgent(agentId)) {
      return { content: 'Error: vault_discard_archives is Dreamer-only.', isError: true };
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
        const ok = deleteConversation(id);
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
};
