// ════════════════════════════════════════
// The Dreamer's filler rule (spec A21): "is this message conversational filler?" — moved out of
// `vault/maintenance.ts` with its patterns so the decision model can be asked alongside it (v3.5 C3) without a
// 2,000-line file growing. The rule is exactly what it was. This module imports no decision code: during a
// triage pass (`beginFillerPass` … `settleFiller`, `memory/shape-judgment.ts`) it only NOTES which short messages
// the rule judged and what it said, and applies the verdicts the pass settled — none in `rule` and `shadow` mode.
// ════════════════════════════════════════

// Conversational filler, acknowledgments. Drop the whole message if its
// trimmed content matches. Length-bounded so prose containing "got it"
// doesn't get false-positived.
const ACK_FILLER_PATTERNS: RegExp[] = [
  /^(sure|got it|okay|ok|alright|understood|will do|on it|working on it now?|let me think( about (this|that))?|let me check|one moment|hmm|hmmm|right|yep|yes|no problem|sounds good|makes sense|of course)[.!]?$/i,
  /^(thanks|thank you)[.!]?$/i,
];

// Process narration the agent emits between tool calls, pure scaffolding.
// Only the assistant narrates its own process; a user opening with "I'll…"
// or "First,…" is stating a plan or a fact, not scaffolding.
const ASSISTANT_NARRATION_PATTERNS: RegExp[] = [
  /^(let me |i'?ll |i'?m going to |now i'?ll |first,? |next,? |then,? )/i,
  /^(checking|searching|reading|writing|looking at|analyzing|processing|continuing|proceeding)\b/i,
  /^(i found|i see|i notice|i can see|i'?ve found)\b/i,
];

/** What the current triage pass has seen: role + trimmed text -> the text and the rule's answer (the rule reads the role, so the role is part of the key). Null outside a pass (nothing accumulates). */
let seen: Map<string, { text: string; rule: boolean }> | null = null;
/** The model's verdicts, settled at the end of the last pass, for texts it was clearly sure about (model mode only). */
let settled = new Map<string, boolean>();

export function beginFillerPass(): void { seen = new Map(); }
/** The messages the rule judged this pass, drained: [text, rule's answer, key for the verdict]. */
export function takeFillerCandidates(): Array<[string, boolean, string]> { const out = [...(seen ?? [])].map(([key, v]): [string, boolean, string] => [v.text, v.rule, key]); seen = null; return out; }
export function setFillerVerdicts(verdicts: Map<string, boolean>): void { settled = verdicts; }

/** `role` defaults to the assistant (the role the narration rule applies to). */
export function isFiller(content: string, role = 'assistant'): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  // Allow process-narration patterns to be caught up to ~80 chars (one
  // sentence). True prose >100 chars is never filler.
  if (trimmed.length > 100) return false;
  const rule = ACK_FILLER_PATTERNS.some((pat) => pat.test(trimmed))
    || (role === 'assistant' && ASSISTANT_NARRATION_PATTERNS.some((pat) => pat.test(trimmed)));
  const key = `${role}\u0000${trimmed}`;
  seen?.set(key, { text: trimmed, rule });
  return settled.get(key) ?? rule;
}
