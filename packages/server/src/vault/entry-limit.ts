// The one length rule for a saved fact, and the plain words each door uses when it applies.
import { estimateTokens } from '../memory/budget.js';

export const MAX_ENTRY_TOKENS = 500;

/** The one length rule for a saved fact: over 500 tokens is cut to 2000 characters plus a pointer line. Create and edit both use it. */
/** True when a save would be cut by `capEntryContent`. */
export function isOverEntryLimit(content: string): boolean {
  return estimateTokens(content) > MAX_ENTRY_TOKENS;
}

/**
 * The plain refusal the owner's dashboard doors give instead of cutting. The owner's own text is
 * never silently shortened (owner data is never lost): the door says no, and nothing is saved.
 */
export function ownerEntryTooLongMessage(content: string): string {
  return `That memory is too long to save as one entry (about ${estimateTokens(content)} tokens; the limit is ${MAX_ENTRY_TOKENS}). Nothing was saved or changed. Shorten it, or split it into two memories.`;
}

/** The plain line an agent is told when its own save was cut by `capEntryContent`. */
export const AGENT_ENTRY_CUT_NOTE =
  `Note: this was longer than ${MAX_ENTRY_TOKENS} tokens, so the saved text was cut to ${MAX_ENTRY_TOKENS * 4} characters and ends with a truncation marker. Put longer procedures in a technique, or save the rest as a separate entry.`;

export function capEntryContent(content: string): string {
  if (estimateTokens(content) > MAX_ENTRY_TOKENS) {
    const maxChars = MAX_ENTRY_TOKENS * 4;
    return content.slice(0, maxChars) + '\n[Truncated -- consider creating a technique for longer procedures]';
  }
  return content;
}

