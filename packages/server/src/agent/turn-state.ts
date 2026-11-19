// State that OUTLIVES a turn (runtime ↔ assembler); this module's existence breaks their import cycle.

import { AsyncLocalStorage } from 'node:async_hooks';

// Turn-start instant: assembly skips mid-turn user messages; cleared only after the next wakeup is queued.
export const turnBoundary = new Map<string, string>();

// Carries "a human is waiting" across an engine auto-continue; read once and deleted so a stale one never restores.
export const continuationContext = new Map<string, {
  convKey: string;
  conversationId: string | null;
  counterparty: import('./v2/counterparty.js').TurnCounterparty;
  address?: import('./v2/turn-address.js').TurnAddress;
}>();

// A new session starts its untracked-work count from zero.
export function clearServedConversations(agentId: string): void {
  untrackedWorkAcrossTurns.delete(agentId);
}

// Carries the untracked work-tool count across CONSECUTIVE turns of the SAME human conversation, so a
// turn break cannot reset the >=6 floor. Keyed by agentId; stored convKey tags the conversation.
export const untrackedWorkAcrossTurns = new Map<string, { convKey: string; count: number }>();

export function accumulateUntrackedWorkAcrossTurns(agentId: string, convKey: string, delta: number): number {
  const prev = untrackedWorkAcrossTurns.get(agentId);
  const base = prev && prev.convKey === convKey ? prev.count : 0;
  const count = base + delta;
  untrackedWorkAcrossTurns.set(agentId, { convKey, count });
  return count;
}

export function getUntrackedWorkAcrossTurns(agentId: string, convKey: string): number {
  const prev = untrackedWorkAcrossTurns.get(agentId);
  return prev && prev.convKey === convKey ? prev.count : 0;
}

export function clearUntrackedWorkAcrossTurns(agentId: string): void {
  untrackedWorkAcrossTurns.delete(agentId);
}

export function clearUntrackedWorkAcrossTurnsForConversation(agentId: string, convKey: string): void {
  const prev = untrackedWorkAcrossTurns.get(agentId);
  if (prev && prev.convKey === convKey) untrackedWorkAcrossTurns.delete(agentId);
}

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
