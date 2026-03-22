import type Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { assembleSystemPrompt } from '../prompt/assembler.js';
import { getContextWindow } from '../agent/model.js';
import { estimateTokens, getRecentMessages } from './store.js';
import { getContextSummaries } from './dag.js';
import { getLatestBriefing } from './briefing.js';
import type { Summary } from './dag.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('memory-assembler');

const DEFAULTS = {
  freshTailCount: 32,
  contextThreshold: 0.75,
};

// ── Context Assembly ──

export function assembleContext(
  agentId: string,
  modelId: string,
): {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>;
} {
  const contextWindow = getContextWindow(modelId);
  const maxTokens = Math.floor(DEFAULTS.contextThreshold * contextWindow);

  // 1. System prompt
  const systemPrompt = assembleSystemPrompt(agentId, modelId);
  let usedTokens = estimateTokens(systemPrompt);

  const messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }> = [];

  // 2. Morning briefing
  const briefing = getLatestBriefing(agentId);
  if (briefing) {
    const briefingText = `<briefing generated="${new Date().toISOString().split('T')[0]}">\n${briefing.content}\n</briefing>`;
    const briefingTokens = estimateTokens(briefingText);

    if (usedTokens + briefingTokens < maxTokens) {
      messages.push({ role: 'user', content: briefingText });
      messages.push({ role: 'assistant', content: 'Understood, I have reviewed the morning briefing.' });
      usedTokens += briefingTokens + estimateTokens('Understood, I have reviewed the morning briefing.');
    }
  }

  // 3. Summaries from context_items
  const summaries = getContextSummaries(agentId);

  if (summaries.length > 0) {
    // Budget check: drop oldest summaries if they would overflow
    const summariesToInclude = budgetSummaries(summaries, maxTokens - usedTokens);

    if (summariesToInclude.length > 0) {
      const summaryText = summariesToInclude.map(s => formatSummaryXml(s)).join('\n\n');
      const summaryTokens = estimateTokens(summaryText);

      const wrappedText = `The following are summaries of earlier conversation history:\n\n${summaryText}`;

      messages.push({ role: 'user', content: wrappedText });
      messages.push({ role: 'assistant', content: 'Thank you, I have reviewed the conversation summaries and will use them as context.' });
      usedTokens += summaryTokens + estimateTokens('Thank you, I have reviewed the conversation summaries and will use them as context.');
    }
  }

  // 4. Fresh tail
  const freshTail = getRecentMessages(agentId, DEFAULTS.freshTailCount);

  // Budget: only include messages that fit
  const tailMessages = budgetFreshTail(freshTail, maxTokens - usedTokens);

  // Sanitize fresh tail: drop orphaned tool_result messages whose tool_use
  // was trimmed by budget constraints, and ensure valid pairing
  const sanitized = sanitizeToolPairs(tailMessages);

  for (const msg of sanitized) {
    const parsed = parseMessageContent(msg);

    if (msg.role === 'tool') {
      // Tool results go as user role with content blocks
      messages.push({ role: 'user', content: parsed as Anthropic.ContentBlockParam[] });
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({ role: msg.role, content: parsed });
    }
    // Skip system messages in history
  }

  // Ensure messages start with user role (Anthropic API requirement)
  // Also drop any leading tool_result messages — they reference tool_use IDs
  // from a preceding assistant message that's no longer in context
  while (messages.length > 0) {
    const first = messages[0];
    if (first.role !== 'user') {
      messages.shift();
      continue;
    }
    // Check if this "user" message is actually a tool_result (mapped from tool role)
    if (Array.isArray(first.content)) {
      const hasToolResult = (first.content as Array<{ type?: string }>).some(
        (b) => b.type === 'tool_result',
      );
      if (hasToolResult) {
        messages.shift();
        continue;
      }
    }
    break;
  }

  // Ensure alternating roles
  const merged = mergeConsecutiveRoles(messages);

  // Ensure conversation ends with a user message (Anthropic API requirement —
  // "does not support assistant message prefill")
  while (merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
    merged.pop();
  }

  // Guard: if we have zero messages after all filtering, inject a minimal user message
  // so the API call doesn't fail with "at least one message is required"
  if (merged.length === 0) {
    logger.warn('Context assembly produced 0 messages — injecting fallback', {}, agentId);
    merged.push({ role: 'user', content: 'Continue with your current task.' });
  }

  logger.info('Context assembled', {
    systemPromptTokens: estimateTokens(systemPrompt),
    summaryCount: summaries.length,
    freshTailCount: tailMessages.length,
    totalMessages: merged.length,
    estimatedTokens: usedTokens,
  }, agentId);

  return { systemPrompt, messages: merged };
}

// ── Helpers ──

function formatSummaryXml(summary: Summary): string {
  return `<summary id="${summary.id}" depth="${summary.depth}" kind="${summary.kind}" tokens="${summary.tokenCount}" earliest="${summary.earliestAt}" latest="${summary.latestAt}">
${summary.content}
</summary>`;
}

function budgetSummaries(summaries: Summary[], availableTokens: number): Summary[] {
  // Reserve at least 30% of available tokens for fresh tail
  const summaryBudget = Math.floor(availableTokens * 0.7);
  let usedTokens = 0;

  // Include from newest to oldest (reverse), since newest summaries are most relevant
  // But we want chronological order in output, so collect indices
  const included: Summary[] = [];

  // First pass: try to include all
  for (const summary of summaries) {
    if (usedTokens + summary.tokenCount <= summaryBudget) {
      included.push(summary);
      usedTokens += summary.tokenCount;
    }
  }

  // If all fit, return them all (already in chronological order)
  if (included.length === summaries.length) {
    return included;
  }

  // Otherwise, drop oldest first until we fit
  const reversed = [...summaries].reverse();
  const keptFromNewest: Summary[] = [];
  usedTokens = 0;

  for (const summary of reversed) {
    if (usedTokens + summary.tokenCount <= summaryBudget) {
      keptFromNewest.push(summary);
      usedTokens += summary.tokenCount;
    }
  }

  // Return in chronological order
  return keptFromNewest.reverse();
}

function budgetFreshTail(messages: Message[], availableTokens: number): Message[] {
  // Group messages into atomic units: tool_use + tool_result pairs must stay together.
  // A "group" is either a standalone message or an [assistant(tool_use), tool(tool_result)] pair.
  interface Group {
    messages: Message[];
    tokens: number;
  }

  const groups: Group[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const tokens = msg.tokenCount ?? estimateTokens(msg.content);

    // Check if this assistant message has tool_use and is followed by a tool message
    let hasToolUse = false;
    try {
      const parsed = JSON.parse(msg.content);
      if (Array.isArray(parsed)) {
        hasToolUse = parsed.some((b: { type?: string }) => b.type === 'tool_use');
      }
    } catch {}

    if (hasToolUse && msg.role === 'assistant' && i + 1 < messages.length && messages[i + 1].role === 'tool') {
      const nextMsg = messages[i + 1];
      const nextTokens = nextMsg.tokenCount ?? estimateTokens(nextMsg.content);
      groups.push({ messages: [msg, nextMsg], tokens: tokens + nextTokens });
      i += 2;
    } else {
      groups.push({ messages: [msg], tokens });
      i++;
    }
  }

  // Work backwards, include groups that fit the budget
  let usedTokens = 0;
  const includedGroups: Group[] = [];

  for (let g = groups.length - 1; g >= 0; g--) {
    if (usedTokens + groups[g].tokens > availableTokens && includedGroups.length > 0) {
      break;
    }
    includedGroups.push(groups[g]);
    usedTokens += groups[g].tokens;
  }

  // Flatten and return in chronological order
  return includedGroups.reverse().flatMap(g => g.messages);
}

/**
 * Ensure tool_use / tool_result pairs are always complete.
 * Every tool_use in an assistant message must have a matching tool_result in the
 * immediately following user/tool message, and vice versa.
 */
function sanitizeToolPairs(messages: Message[]): Message[] {
  // Build list with parsed tool IDs for each message
  interface Annotated {
    msg: Message;
    toolUseIds: string[];   // IDs from tool_use blocks (assistant messages)
    toolResultIds: string[]; // IDs from tool_result blocks (tool messages)
  }

  const annotated: Annotated[] = messages.map((msg) => {
    const toolUseIds: string[] = [];
    const toolResultIds: string[] = [];

    try {
      const parsed = JSON.parse(msg.content);
      if (Array.isArray(parsed)) {
        for (const block of parsed) {
          if (block.type === 'tool_use' && block.id) {
            toolUseIds.push(block.id);
          }
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolResultIds.push(block.tool_use_id);
          }
        }
      }
    } catch {
      // Plain text — no tool blocks
    }

    return { msg, toolUseIds, toolResultIds };
  });

  // Iterate and keep only valid pairs.
  // An assistant message with tool_use must be immediately followed by a tool message
  // with matching tool_result IDs. If either is missing, drop BOTH.
  const keep = new Array<boolean>(annotated.length).fill(true);

  for (let i = 0; i < annotated.length; i++) {
    const entry = annotated[i];

    if (entry.toolUseIds.length > 0) {
      // This is an assistant message with tool_use. Check the next message.
      const next = i + 1 < annotated.length ? annotated[i + 1] : null;
      if (!next || next.msg.role !== 'tool') {
        // No tool_result follows — drop this assistant message
        keep[i] = false;
        continue;
      }

      // Check that every tool_use ID has a matching tool_result
      const resultIdSet = new Set(next.toolResultIds);
      const allMatched = entry.toolUseIds.every((id) => resultIdSet.has(id));
      if (!allMatched) {
        // Mismatch — drop both
        keep[i] = false;
        keep[i + 1] = false;
      }
    }

    if (entry.toolResultIds.length > 0 && entry.msg.role === 'tool') {
      // This is a tool_result message. Check the previous message.
      const prev = i > 0 ? annotated[i - 1] : null;
      if (!prev || prev.toolUseIds.length === 0) {
        // No preceding tool_use — drop this tool_result
        keep[i] = false;
        continue;
      }

      // Check that every tool_result ID has a matching tool_use
      const useIdSet = new Set(prev.toolUseIds);
      const allMatched = entry.toolResultIds.every((id) => useIdSet.has(id));
      if (!allMatched) {
        keep[i] = false;
        keep[i - 1] = false;
      }
    }
  }

  const result = annotated.filter((_, i) => keep[i]).map((a) => a.msg);

  const dropped = annotated.length - result.length;
  if (dropped > 0) {
    const droppedDetails = annotated
      .map((a, i) => keep[i] ? null : `[${i}] role=${a.msg.role} useIds=${a.toolUseIds.join(',')} resultIds=${a.toolResultIds.join(',')}`)
      .filter(Boolean);
    logger.warn(`Dropped ${dropped} messages with broken tool_use/tool_result pairs from context`, {
      details: droppedDetails.slice(0, 10),
    });
  }

  return result;
}

function parseMessageContent(
  msg: Message,
): string | Anthropic.ContentBlockParam[] {
  try {
    const parsed = JSON.parse(msg.content);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return msg.content;
  } catch {
    return msg.content;
  }
}

function mergeConsecutiveRoles(
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
): Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }> {
  const merged: typeof messages = [];

  for (const msg of messages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      const prev = merged[merged.length - 1];
      if (typeof prev.content === 'string' && typeof msg.content === 'string') {
        prev.content = prev.content + '\n\n' + msg.content;
      } else {
        const prevArr = typeof prev.content === 'string'
          ? [{ type: 'text' as const, text: prev.content }]
          : prev.content;
        const msgArr = typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content;
        prev.content = [...prevArr, ...msgArr];
      }
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}
