// Prompt-assembly registry — the walker + context builder (R3+).
//
// assembleSystemFromRegistry walks the canonical slot order, preferring a
// registered entry for each slot and falling back to the legacy per-slot text
// for everything not yet migrated. It returns the joined system prompt plus the
// entry id that produced each part (for the receipt). The legacy parts producer
// (assembleSystemPromptParts) stays the source of truth for unmigrated slots
// until R7 deletes it. See DOJO-PROMPT-REGISTRY-PLAN.md §2.2.

import { getDb } from '../../db/connection.js';
import { isPrimaryAgent, isPMAgent, getOwnerName } from '../../config/platform.js';
import { getModelCapabilities } from '../../services/capabilities.js';
import { getContextWindow } from '../../agent/model.js';
import { resolveInboundContext, resolveTtsEngine, type PromptTurnContext } from '../assembler.js';
import { getSystemEntries, getMessageEntries } from './registry.js';
import { pushEngineMessage } from '../../agent/v2/engine-message.js';
import {
  PART_JOINER,
  type AssemblyContext,
  type AssemblyTurnState,
  type EngineMessage,
} from './types.js';
// Side-effect: registers the migrated entries at module load.
import './entries.js';

/**
 * Build the single context bundle threaded to every entry. Computes the cheap,
 * shared identity/capability values once. Inbound-channel resolution and the
 * full TTS-engine resolution are populated as the slots that need them migrate
 * (R4); message-side turn state comes from the loop via `turnState` (R5). Until
 * then those fields carry safe defaults that no migrated entry reads.
 */
export function buildAssemblyContext(
  agentId: string,
  modelId: string,
  turnContext?: PromptTurnContext,
  turnState?: AssemblyTurnState,
): AssemblyContext {
  let capabilities: string[] = [];
  try {
    capabilities = getModelCapabilities(modelId);
  } catch {
    capabilities = [];
  }
  const isPrimary = isPrimaryAgent(agentId);
  // Inbound-channel resolution runs once, primary only (matches the legacy front
  // block's `if (isPrimaryAgent)` gate). Non-primary agents have no front-three.
  const inbound = isPrimary
    ? resolveInboundContext(agentId)
    : { inboundChannel: null, smsFromNumber: null, phoneFromNumber: null, replyDestination: null, lastContent: '' };
  return {
    agentId,
    modelId,
    turnContext,
    db: getDb(),
    isPrimary,
    isPM: isPMAgent(agentId),
    capabilities,
    contextWindow: getContextWindow(modelId),
    ownerName: getOwnerName(),
    // The reply goes to THIS turn's counterparty (the actual inbound sender),
    // not always the owner. Falls back to the owner for proactive/dashboard turns.
    replyRecipientName: turnContext?.counterparty?.name ?? getOwnerName(),
    ttsEngine: resolveTtsEngine(turnContext),
    lastUserContent: inbound.lastContent,
    inboundChannel: inbound.inboundChannel,
    smsFromNumber: inbound.smsFromNumber,
    phoneFromNumber: inbound.phoneFromNumber,
    replyDestination: inbound.replyDestination,
    // Message-side turn state (R5 threads the real values from the loop).
    loopCount: turnState?.loopCount ?? 1,
    turnNumber: turnState?.turnNumber ?? 0,
    lastUserMessageContent: turnState?.lastUserMessageContent ?? '',
    pendingNudge: turnState?.pendingNudge ?? null,
  };
}

export interface RegistrySystemResult {
  text: string;
  /** Entry id per emitted part (null = produced by the legacy fallback). */
  entryIds: (string | null)[];
}

/**
 * Produce the system prompt from the registry. Entry-only walk: every system
 * slot is a registered entry (R4 migrated all 23), so there is no legacy
 * fallback. getSystemEntries() returns them slot-sorted (canonical order);
 * rawAppend entries (the weak technique hint) are appended post-walk via
 * appendSystemHint, skipped here. A render that throws is contained (skipped) so
 * one bad entry can't fail the whole assembly — matching the legacy per-block
 * try/catch.
 */
export function assembleSystemFromRegistry(ctx: AssemblyContext): RegistrySystemResult {
  const outParts: string[] = [];
  const outIds: (string | null)[] = [];
  for (const entry of getSystemEntries()) {
    if (entry.rawAppend) continue;
    let r: string | string[] | null = null;
    try {
      r = (entry.when?.(ctx) ?? true) ? entry.render(ctx) : null;
    } catch {
      r = null;
    }
    const texts = r == null ? [] : Array.isArray(r) ? r : [r];
    for (const t of texts) {
      if (t != null && t !== '') {
        outParts.push(t);
        outIds.push(entry.id);
      }
    }
  }
  return { text: outParts.join(PART_JOINER), entryIds: outIds };
}

/**
 * Render a single message-side entry by id (R3 message-side PoC). Builds the
 * context, checks `when`, and returns the first rendered message (or null).
 * The loop calls this in registry mode at the legacy injection site, so the
 * injected message lands at the same position — byte-identical to legacy. R5
 * replaces this single-entry shim with a full message walk that owns all the
 * §3c sites in one ordered pass.
 */
export function renderMessageEntryById(
  id: string,
  agentId: string,
  modelId: string,
  turnContext?: PromptTurnContext,
  turnState?: AssemblyTurnState,
): EngineMessage | null {
  const ctx = buildAssemblyContext(agentId, modelId, turnContext, turnState);
  return renderMessageEntry(id, ctx);
}

/** Render a single message-side entry against a prebuilt context. */
export function renderMessageEntry(id: string, ctx: AssemblyContext): EngineMessage | null {
  const entry = getMessageEntries().find((e) => e.id === id);
  if (!entry) return null;
  if (entry.when && !entry.when(ctx)) return null;
  const r = entry.render(ctx);
  if (r == null) return null;
  return Array.isArray(r) ? (r[0] ?? null) : r;
}

/**
 * Render a message entry by id and inject it into `messages` via the single
 * engine-message channel — the registry-owned injection path. The loop calls
 * THIS instead of pushEngineMessage at each §3c site, so once the legacy inline
 * branches are deleted (R7) no raw injection remains in loop.ts (R8 guard).
 * Returns whether a message was injected.
 */
export function injectRegistryMessage(id: string, messages: EngineMessage[], ctx: AssemblyContext): boolean {
  const msg = renderMessageEntry(id, ctx);
  if (!msg || typeof msg.content !== 'string') return false;
  return pushEngineMessage(messages, msg.content);
}

/**
 * Render a raw-append system entry by id and append its text to the END of the
 * system prompt (no `---` separator) — matches the legacy `systemPrompt += hint`
 * for the weak technique hint. The `+=` lives HERE (registry module), so the
 * loop has no raw systemPrompt+= (R8 guard). Returns the new system prompt.
 */
export function appendSystemHint(systemPrompt: string, id: string, ctx: AssemblyContext): string {
  const entry = getSystemEntries().find((e) => e.id === id);
  if (!entry) return systemPrompt;
  if (entry.when && !entry.when(ctx)) return systemPrompt;
  const r = entry.render(ctx);
  const text = r == null ? '' : Array.isArray(r) ? r.join(PART_JOINER) : r;
  return text ? systemPrompt + text : systemPrompt;
}
