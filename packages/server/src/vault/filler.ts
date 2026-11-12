// The Dreamer's filler rule; imports no decision code. The previous pass's model verdicts override the rule.

// Acknowledgments; whole-message matches only, so prose containing "got it" is not filler.
const ACK_FILLER_PATTERNS: RegExp[] = [
  /^(sure|got it|okay|ok|alright|understood|will do|on it|working on it now?|let me think( about (this|that))?|let me check|one moment|hmm|hmmm|right|yep|yes|no problem|sounds good|makes sense|of course)[.!]?$/i,
  /^(thanks|thank you)[.!]?$/i,
];

// Assistant-only narration; a user opening with "I'll" is stating a plan, not scaffolding.
const ASSISTANT_NARRATION_PATTERNS: RegExp[] = [
  /^(let me |i'?ll |i'?m going to |now i'?ll |first,? |next,? |then,? )/i,
  /^(checking|searching|reading|writing|looking at|analyzing|processing|continuing|proceeding)\b/i,
  /^(i found|i see|i notice|i can see|i'?ve found)\b/i,
];

/** What the current triage pass has seen: role + trimmed text -> text and the rule's answer. Null outside a pass. */
let seen: Map<string, { text: string; rule: boolean }> | null = null;
let settled = new Map<string, boolean>();

export function beginFillerPass(): void { seen = new Map(); }
export function takeFillerCandidates(): Array<[string, boolean, string]> { const out = [...(seen ?? [])].map(([key, v]): [string, boolean, string] => [v.text, v.rule, key]); seen = null; return out; }
export function setFillerVerdicts(verdicts: Map<string, boolean>): void { settled = verdicts; }

export function isFiller(content: string, role = 'assistant'): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length > 100) return false;
  const rule = ACK_FILLER_PATTERNS.some((pat) => pat.test(trimmed))
    || (role === 'assistant' && ASSISTANT_NARRATION_PATTERNS.some((pat) => pat.test(trimmed)));
  const key = `${role}\u0000${trimmed}`;
  seen?.set(key, { text: trimmed, rule });
  return settled.get(key) ?? rule;
}
