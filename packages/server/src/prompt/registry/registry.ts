// Prompt-assembly registry — the container the assembler walks to produce the
// system prompt + message array. Every PromptInjection entry registers here at
// module load; the declarative assembler (memory/assembler.ts) is the sole path.
// See DOJO-PROMPT-REGISTRY-PLAN.md.

import type { PromptInjection, SystemInjection, MessageInjection } from './types.js';

// ── The registry ────────────────────────────────────────────────────────────
// One array; accessors filter by target and return slot-sorted views. Entries
// register at module load (R3+ register their blocks). Duplicate ids THROW — an
// id is the receipt's handle and the R8 enforcement guard's key, so a collision
// must surface at startup, not silently.

const REGISTRY: PromptInjection[] = [];
const seenIds = new Set<string>();

export function register(entry: PromptInjection): void {
  if (seenIds.has(entry.id)) {
    throw new Error(`Duplicate prompt-injection id: ${entry.id}`);
  }
  seenIds.add(entry.id);
  REGISTRY.push(entry);
}

export function registerAll(entries: PromptInjection[]): void {
  for (const e of entries) register(e);
}

function bySlotThenOrder(a: PromptInjection, b: PromptInjection): number {
  const slotDelta = (a.slot as number) - (b.slot as number);
  if (slotDelta !== 0) return slotDelta;
  return (a.order ?? 0) - (b.order ?? 0);
}

/** System entries, slot-sorted (canonical assembly order). */
export function getSystemEntries(): SystemInjection[] {
  return REGISTRY.filter((e): e is SystemInjection => e.target === 'system').sort(bySlotThenOrder);
}

/** Message entries, slot-sorted (canonical build order). */
export function getMessageEntries(): MessageInjection[] {
  return REGISTRY.filter((e): e is MessageInjection => e.target === 'messages').sort(bySlotThenOrder);
}

/** All registered ids — the R8 enforcement guard + R9 inventory test consume this. */
export function registeredIds(): string[] {
  return REGISTRY.map((e) => e.id);
}

/** Test-only: clear the registry so a suite can register a controlled set. */
export function __resetRegistryForTests(): void {
  REGISTRY.length = 0;
  seenIds.clear();
}
