// ════════════════════════════════════════════════════════════════════════════
// CONVERSATION RECALL (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// `recall_recent_thread`, `history_search`, `history_get`, `history_expand` —
// the four tools `tools/categories.ts` files under "Conversation Recall".
//
// RELOCATION, NOT REWRITE. Each body below is the body that stood in the switch,
// byte-faithful. The only edits are the ones a move REQUIRES: the trailing
// `content = …; break;` became `return { content, isError }`, and the two
// dynamic imports the move retires (below) became static ones. No logic was
// improved, deduplicated or pruned on the way out; anything worth changing here
// is a later task's, recorded as a hand-up rather than taken silently.
//
// ── THE DYNAMIC IMPORTS THAT DIED HERE, AND WHY THEY WERE SAFE TO KILL ──
// The bodies fetched `./turn-state.js` three times and `../memory/recall.js`
// once through `await import(…)`. Neither broke a cycle: `agent/tools.ts`
// already imported `turn-state.js` STATICALLY at its own line 3, and neither
// `turn-state.ts` nor `memory/recall.ts` imports anything from the toolbox at
// all (measured, not assumed). They are the hack class §T0-PINS P8 names, they
// are not on the sanctioned list, and a module that is not `tools.ts` has no
// cycle for them to break — so they are static imports here.
// ════════════════════════════════════════════════════════════════════════════

import { coerceNumberArg } from '../pagination.js';
import { getRecallBudgetUsed, addRecallBudgetUsed, currentTurnConversationId } from '../../turn-state.js';
import { recallRecentThread } from '../../../memory/recall.js';
import { memoryGrep, memoryDescribe, memoryExpand } from '../../../memory/retrieval.js';
import type { ToolHandlerMap } from '../handler.js';

// RC-3 item 2: per-turn recall budget. Cumulative recall_recent_thread +
// history_search EMITTED output tokens are tracked per turn (agent/turn-state.ts);
// past this budget the tools return a short engine notice instead of another dump.
// Deterministic brake on the recall doom loop (the excavation itself creates the
// context pressure that forces the compaction the agent is flailing to recover
// from). Tokens are estimated as chars/4 at the dispatch site.
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
    // RC-3 item 2: per-turn recall budget (deterministic doom-loop brake). Once
    // cumulative recall/history output for THIS turn crosses the budget, return a
    // short engine notice instead of another 12-16k-char dump (the excavation
    // itself is what forces the compaction the agent is flailing to recover from).
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
    // OPEN-15: default to the current conversation; allow an explicit
    // scope:"all" to recover across conversations when the agent really
    // means "show me everything recent."
    const recallScope = args.scope === 'all' ? 'all' : 'conversation';
    // E-C1: scope recall to the conversation THIS turn is serving (from live
    // turn state), not the last-stamped heuristic that bled an unrelated human
    // conversation into recall on engine/A2A turns. PHASE-2 T10I: the scope is the
    // conversation's FK; the `.has()` test is the three-state contract (entry+id = that
    // conversation, entry+null = engine/A2A turn, no entry = outside a turn).
    const turnConversationId = currentTurnConversationId.has(agentId)
      ? (currentTurnConversationId.get(agentId) ?? null)
      : undefined;
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
    // RC-3: bill the emitted output against this turn's recall budget.
    addRecallBudgetUsed(agentId, Math.ceil(content.length / 4));
    return { content, isError: false };
  },

  async history_search({ agentId, args }) {
    // Accept `query` as an alias for `pattern`. `pattern` is canonical, but
    // agents who learned the tool from natural descriptions ("search for the
    // QUARK marker") often pass `query`. Both are declared in the schema
    // above (so the unknown-arg detector does not warn), and required is
    // loosened there because either one satisfies this call. Without this
    // fallback, undefined was silently passed to the FTS5 engine and
    // returned irrelevant rows. Validate explicitly.
    const grepPattern = (args.pattern ?? args.query) as string | undefined;
    if (!grepPattern || typeof grepPattern !== 'string' || !grepPattern.trim()) {
      return {
        content: 'Error: history_search needs a non-empty `pattern` (the search string). Example: history_search({ pattern: "budget meeting" }).',
        isError: true,
      };
    }
    // RC-3: history_search shares the per-turn recall budget with
    // recall_recent_thread (both are the doom-loop excavation fuel).
    {
      const used = getRecallBudgetUsed(agentId);
      if (used >= RECALL_BUDGET_TOKENS) {
        return { content: recallBudgetNotice(used), isError: false };
      }
    }
    const content = memoryGrep(agentId, {
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

// C27: memory_search removed; its calls alias to history_search
// ({query} -> {pattern}) before dispatch, so no handler is needed here.
