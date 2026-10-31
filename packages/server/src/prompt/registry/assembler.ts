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
import { agentTurnWindow } from '../../router/router-window.js';
import { resolveInboundContext, resolveTtsEngine, type InboundContext, type PromptTurnContext } from '../assembler.js';
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
import { createLogger } from '../../logger.js';

const logger = createLogger('prompt-registry');
// A section that throws throws on every turn, so the first failure of a given
// entry id per process is the one line worth having; the rest would be spam.
const warnedRenderFailures = new Set<string>();

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
  const inbound: InboundContext = isPrimary
    ? resolveInboundContext(agentId)
    : { inboundChannel: null, smsFromNumber: null, phoneFromNumber: null, replyDestination: null, lastContent: '' };
  // 3.5: the route this turn's reply takes comes from the turn's ADDRESS (computed once in
  // preflight from the trigger's counterparty), never from the newest row of whichever
  // conversation wrote last. No address (a non-turn caller) or a non-person address
  // (A2A, engine, notification) means there is no human reply tag.
  const address = turnContext?.address;
  if (isPrimary && address) {
    const person = address.kind === 'person';
    inbound.inboundChannel = person ? address.boundChannel : null;
    inbound.smsFromNumber = person ? (address.inboundContext?.smsFromNumber ?? null) : null;
    inbound.phoneFromNumber = person ? (address.inboundContext?.phoneFromNumber ?? null) : null;
    inbound.replyDestination = person ? address.deliveryChannel : null;
  }
  return {
    agentId,
    modelId,
    turnContext,
    db: getDb(),
    isPrimary,
    isPM: isPMAgent(agentId),
    capabilities,
    contextWindow: agentTurnWindow(agentId, modelId),
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
    pendingSteer: turnState?.pendingSteer ?? null,
  };
}

export interface RegistrySystemResult {
  text: string;
  /** Entry id per emitted part (null = produced by the legacy fallback). */
  entryIds: (string | null)[];
}

/**
 * Produce the system prompt from the registry. Entry-only walk: every system
 * slot is a registered entry, so there is no legacy fallback. getSystemEntries()
 * returns them slot-sorted (canonical order). A render that throws is contained
 * (skipped) so one bad entry can't fail the whole assembly, matching the legacy
 * per-block try/catch. (FA-PT3: the raw-append weak-hint path was deleted; the
 * weak technique hint is a message entry, msg.technique-weak, not a system
 * append, so there is no longer a rawAppend branch to skip.)
 */
export function assembleSystemFromRegistry(ctx: AssemblyContext): RegistrySystemResult {
  const outParts: string[] = [];
  const outIds: (string | null)[] = [];
  for (const entry of getSystemEntries()) {
    let r: string | string[] | null = null;
    try {
      r = (entry.when?.(ctx) ?? true) ? entry.render(ctx) : null;
    } catch (err) {
      r = null;
      // Contained, but not silent: an entry missing from the prompt with no
      // trace looks like an agent that lost an instruction. Warn once per id.
      if (!warnedRenderFailures.has(entry.id)) {
        warnedRenderFailures.add(entry.id);
        logger.warn('a system prompt section failed to render and was left out of the prompt', {
          entryId: entry.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
  // F23: the registry path already knows the entry id, so every registered injection is
  // tagged with its REAL id (`msg.turn-context`, `msg.tool-note`, …) for free.
  return pushEngineMessage(messages, msg.content, id);
}
