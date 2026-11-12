// One channel for engine-injected user-role messages; dedup keeps an identical one out of the context.

import type Anthropic from '@anthropic-ai/sdk';
import { tagMessageLane } from '../../memory/message-lane-tag.js';

type LoopMessage = { role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] };

const DEDUP_TAIL_WINDOW = 8;

/** laneId is required: an untagged injection is sniffed as organic prose, invisible as an engine nudge. */
export function pushEngineMessage(messages: LoopMessage[], content: string, laneId: string): boolean {
  const from = Math.max(0, messages.length - DEDUP_TAIL_WINDOW);
  for (let i = messages.length - 1; i >= from; i--) {
    if (typeof messages[i].content === 'string' && messages[i].content === content) {
      return false; // already present: skip the duplicate
    }
  }
  messages.push(tagMessageLane({ role: 'user', content }, laneId));
  return true;
}
