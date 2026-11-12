// Prompt-assembly registry: the container the declarative assembler (memory/assembler.ts) walks to
// produce the system prompt and message array. Entries register here at module load.

import type { PromptInjection, SystemInjection, MessageInjection } from './types.js';

// One array; accessors filter by target and return slot-sorted views. Duplicate ids throw: an id is the
// receipt's handle and the enforcement guard's key, so a collision must surface at startup.

const REGISTRY: PromptInjection[] = [];
const seenIds = new Set<string>();

export function register(entry: PromptInjection): void {
  if (seenIds.has(entry.id)) {
    throw new Error(`Duplicate prompt-injection id: ${entry.id}`);
  }
  seenIds.add(entry.id);
  REGISTRY.push(entry);
}

function bySlotThenOrder(a: PromptInjection, b: PromptInjection): number {
  const slotDelta = (a.slot as number) - (b.slot as number);
  if (slotDelta !== 0) return slotDelta;
  return (a.order ?? 0) - (b.order ?? 0);
}

export function getSystemEntries(): SystemInjection[] {
  return REGISTRY.filter((e): e is SystemInjection => e.target === 'system').sort(bySlotThenOrder);
}

export function getMessageEntries(): MessageInjection[] {
  return REGISTRY.filter((e): e is MessageInjection => e.target === 'messages').sort(bySlotThenOrder);
}

/** All registered ids, consumed by the enforcement guard and the inventory test. */
export function registeredIds(): string[] {
  return REGISTRY.map((e) => e.id);
}

export function __resetRegistryForTests(): void {
  REGISTRY.length = 0;
  seenIds.clear();
}
