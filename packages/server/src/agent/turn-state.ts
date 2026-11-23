// State that OUTLIVES a turn (runtime ↔ assembler); this module's existence breaks their import cycle.

import { AsyncLocalStorage } from 'node:async_hooks';

// Turn-start instant: assembly skips mid-turn user messages; cleared only after the next wakeup is queued.
export const turnBoundary = new Map<string, string>();

export const MAX_A2A_TURN_RETRIES = 2;

// Async-scoped so concurrent safe-batch calls keep their own id; a record for another agent gets null.
const toolCallContext = new AsyncLocalStorage<{ agentId: string; callId: string }>();

export function runWithToolCallId<T>(agentId: string, callId: string, fn: () => Promise<T>): Promise<T> {
  return toolCallContext.run({ agentId, callId }, fn);
}

export function getCurrentToolCallId(agentId: string): string | null {
  const ctx = toolCallContext.getStore();
  return ctx?.agentId === agentId ? ctx.callId : null;
}
