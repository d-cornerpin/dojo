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
import { tagMessageLane } from '../../memory/message-lane-tag.js';

type LoopMessage = { role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] };

const DEDUP_TAIL_WINDOW = 8;

/**
 * Push an engine-injected user-role message, skipping it if identical string
 * content already appears in the recent tail. Returns true if pushed.
 *
 * ── PHASE-3 T6, requirement F23: TAGGED AT EMISSION ──
 * `laneId` names the injection. It was optional-with-a-default for exactly one commit and
 * is REQUIRED, because a default is how an untagged injection stays invisible: the receipt
 * classifies an unrecognised user-role message as `organic` by pattern-sniffing its prose,
 * and research 06 §8 lists four engine injections that reach a model looking like something
 * the user typed. The compiler now refuses a new injection that does not say who it is.
 */
export function pushEngineMessage(messages: LoopMessage[], content: string, laneId: string): boolean {
  const from = Math.max(0, messages.length - DEDUP_TAIL_WINDOW);
  for (let i = messages.length - 1; i >= from; i--) {
    if (typeof messages[i].content === 'string' && messages[i].content === content) {
      return false; // already present — don't duplicate the engine nudge
    }
  }
  messages.push(tagMessageLane({ role: 'user', content }, laneId));
  return true;
}
