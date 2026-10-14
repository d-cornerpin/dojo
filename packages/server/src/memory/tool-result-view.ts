// ════════════════════════════════════════════════════════════════════════════════════════
// THE SIZE OF ONE TOOL RESULT IN THE MODEL'S VIEW — one number, one note.
//
// The assembler shows the agent at most V2_MAX_TOOL_RESULT_TOKENS of any single tool result,
// kept from the HEAD. A tool that pages (file_read) has to size its page to THAT number or its
// honest "N more lines remain; continue at offset N" footer — at the END of the page — is the
// part the view cuts away (run 7, S4: a 243,752-char page, 15,000 tokens seen, the footer and the
// needle never in view, the agent answered "I read the whole log"). So the number lives here, a
// leaf under `budget.ts`, and the paging tool, its definition's own cap and both truncation
// sites in the assembler read it instead of each holding a figure.
//
// History of the number: raised 3000 → 15000 in v2.7.3 so a typical document the agent just read
// stays intact through the session while one runaway result still cannot take the whole window.
// ════════════════════════════════════════════════════════════════════════════════════════

import { CHARS_PER_TOKEN, estimateTokens } from './budget.js';

export const V2_MAX_TOOL_RESULT_TOKENS = 15000;

/** The same bound in characters, for a tool sizing a page: `estimateTokens(text) <= V2_MAX_TOOL_RESULT_TOKENS`
 *  holds exactly when `text.length <= TOOL_RESULT_VIEW_CHARS`. */
export const TOOL_RESULT_VIEW_CHARS = V2_MAX_TOOL_RESULT_TOKENS * CHARS_PER_TOKEN;

/**
 * The backstop for output that does not page. A result within the view is returned as it is; a longer
 * one keeps its head and ends in a note that says WHAT was kept, so the agent can never read a cut
 * result as a whole one. `hint` is the tool-specific advice for getting the rest.
 */
export function capToolResultView(text: string, hint: string): string {
  const tokens = estimateTokens(text);
  if (tokens <= V2_MAX_TOOL_RESULT_TOKENS) return text;
  const keepChars = Math.max(500, Math.floor(text.length * (V2_MAX_TOOL_RESULT_TOKENS / tokens)));
  return text.slice(0, keepChars) +
    `\n\n[... CUT: only the first ~${keepChars} chars (~${V2_MAX_TOOL_RESULT_TOKENS} tokens) of this ${text.length}-char (~${tokens}-token) result were kept; the rest is NOT shown here. ${hint}]`;
}
