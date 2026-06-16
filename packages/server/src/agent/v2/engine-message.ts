// ════════════════════════════════════════
// One channel for engine-injected user-role messages (remediation 3c).
//
// The engine injects several synthetic user-role messages into a turn:
// strong-match technique guidance, auto-tracker task notifications, steering
// nudges, and the no-tools capability note. Pre-consolidation each did its
// own `messages.push({ role: 'user', content })`, so there was no single
// place that owned framing or guarded against the same nudge landing twice.
//
// This is that single place. The per-site GATE (whether/when to inject) stays
// at the call site, where it belongs; this owns the HOW: a dedup safety net so
// an identical engine injection never appears twice in one in-flight context
// (the "repeats itself" failure mode, on the input side). Behavior-preserving
// for the existing sites — it only ADDS the dedup guard.
// ════════════════════════════════════════

import type Anthropic from '@anthropic-ai/sdk';

type LoopMessage = { role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] };

const DEDUP_TAIL_WINDOW = 8;

/**
 * Push an engine-injected user-role message, skipping it if identical string
 * content already appears in the recent tail. Returns true if pushed.
 */
export function pushEngineMessage(messages: LoopMessage[], content: string): boolean {
  const from = Math.max(0, messages.length - DEDUP_TAIL_WINDOW);
  for (let i = messages.length - 1; i >= from; i--) {
    if (typeof messages[i].content === 'string' && messages[i].content === content) {
      return false; // already present — don't duplicate the engine nudge
    }
  }
  messages.push({ role: 'user', content });
  return true;
}
