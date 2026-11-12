// RECALL: `recall_recent_thread`, `history_search`, `history_get`, `history_expand`:
// the four tools `tools/categories.ts` files under "Conversation Recall". Every
// import is static; none of these modules imports anything from the toolbox.

import { coerceNumberArg } from '../pagination.js';
import { getRecallBudgetUsed, addRecallBudgetUsed, turnConversationScope } from '../../turn-context.js';
import { recallRecentThread } from '../../../memory/recall.js';
import { memoryGrep, memoryDescribe, memoryExpand } from '../../../memory/retrieval.js';
import type { ToolHandlerMap } from '../handler.js';

// Per-turn recall budget: cumulative recall_recent_thread + history_search
// EMITTED tokens (estimated chars/4 at dispatch), past which the tools return
// a short notice. The excavation itself forces the compaction it fights.
const RECALL_BUDGET_TOKENS = 8000;

function recallBudgetNotice(usedTokens: number): string {
  const k = Math.round(usedTokens / 1000);
  return (
    `You have recalled ~${k}k tokens this turn. The current conversation is already in ` +
    `your context; if you are looking for a specific message, use history_search with a ` +
    `narrow pattern, or ask the person directly.`
  );
}

export const recallHandlers: ToolHandlerMap = {
  async recall_recent_thread({ agentId, args }) {
    {
      const used = getRecallBudgetUsed(agentId);
      if (used >= RECALL_BUDGET_TOKENS) {
        return { content: recallBudgetNotice(used), isError: false };
      }
    }
    const turnCount = Math.min(30, Math.max(1, Math.floor(coerceNumberArg(args.turn_count) ?? 8)));
    const includeToolCalls = args.include_tool_calls === false ? false : true;
    const includeToolResults = args.include_tool_results === true;
    const truncateToolResultChars = Math.min(
      4000,
      Math.max(200, Math.floor(coerceNumberArg(args.truncate_tool_result_chars) ?? 1500)),
    );
    const truncateMessageChars = Math.min(
      8000,
      Math.max(200, Math.floor(coerceNumberArg(args.truncate_message_chars) ?? 1500)),
    );
    const beforeId = typeof args.before_id === 'string' ? args.before_id : undefined;
    const since = typeof args.since === 'string' ? args.since : undefined;
    // Default to the current conversation; scope:"all" goes cross-conversation.
    const recallScope = args.scope === 'all' ? 'all' : 'conversation';
    // Scope to the conversation THIS turn serves; `.has()` is the three-state
    // contract: entry+id = it, entry+null = engine/A2A turn, no entry = no turn.
    const turnConversationId = turnConversationScope(agentId);
    const content = recallRecentThread(agentId, {
      turnCount,
      includeToolCalls,
      includeToolResults,
      truncateToolResultChars,
      truncateMessageChars,
      beforeId,
      since,
      scope: recallScope,
      turnConversationId,
    });
    // Bill the emitted output against this turn's recall budget.
    addRecallBudgetUsed(agentId, Math.ceil(content.length / 4));
    return { content, isError: false };
  },

  async history_search({ agentId, args }) {
    // `query` aliases canonical `pattern` (both declared; either satisfies the
    // loosened `required`). Passing undefined to FTS5 returns irrelevant rows.
    const grepPattern = (args.pattern ?? args.query) as string | undefined;
    if (!grepPattern || typeof grepPattern !== 'string' || !grepPattern.trim()) {
      return {
        content: 'Error: history_search needs a non-empty `pattern` (the search string). Example: history_search({ pattern: "budget meeting" }).',
        isError: true,
      };
    }
    {
      const used = getRecallBudgetUsed(agentId);
      if (used >= RECALL_BUDGET_TOKENS) {
        return { content: recallBudgetNotice(used), isError: false };
      }
    }
    const content = await memoryGrep(agentId, {
      pattern: grepPattern,
      mode: args.mode as 'full_text' | 'regex' | undefined,
      scope: args.scope as 'messages' | 'summaries' | 'both' | undefined,
      since: args.since as string | undefined,
      before: args.before as string | undefined,
      limit: args.limit as number | undefined,
    });
    addRecallBudgetUsed(agentId, Math.ceil(content.length / 4));
    return { content, isError: false };
  },

  async history_get({ agentId, args }) {
    return { content: memoryDescribe(agentId, { id: args.id as string }), isError: false };
  },

  async history_expand({ agentId, args }) {
    const content = await memoryExpand(agentId, {
      query: args.query as string | undefined,
      summary_ids: args.summary_ids as string[] | undefined,
      prompt: args.prompt as string,
    });
    return { content, isError: false };
  },
};

// `memory_search` has no handler: its calls alias to history_search
// ({query} -> {pattern}) before dispatch.
