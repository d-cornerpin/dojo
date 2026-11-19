// Prompt-assembly registry walker and context builder: walks the canonical slot order and returns the
// joined system prompt plus the entry id that produced each part (for the receipt).

import { getDb } from '../../db/connection.js';
import { isPrimaryAgent, isPMAgent, getOwnerName } from '../../config/platform.js';
import { getModelCapabilities } from '../../services/capabilities.js';
import { agentTurnWindow } from '../../router/router-window.js';
import { resolveInboundContext, type InboundContext, type PromptTurnContext } from '../assembler.js';
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

/** Build the context bundle threaded to every entry; shared values are computed once. */
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
  // Inbound-channel resolution runs once, primary only; non-primary agents have no front-three.
  const inbound: InboundContext = isPrimary
    ? resolveInboundContext(agentId)
    : { inboundChannel: null, smsFromNumber: null, phoneFromNumber: null, replyDestination: null, lastContent: '' };
  // The reply route comes from the turn ADDRESS (set once in preflight), never from the newest row of
  // whichever conversation wrote last; a non-person address (A2A, engine, notification) has no reply tag.
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
    // The reply goes to THIS turn's counterparty, falling back to the owner for proactive/dashboard turns.
    replyRecipientName: turnContext?.counterparty?.name ?? getOwnerName(),
    lastUserContent: inbound.lastContent,
    inboundChannel: inbound.inboundChannel,
    smsFromNumber: inbound.smsFromNumber,
    phoneFromNumber: inbound.phoneFromNumber,
    replyDestination: inbound.replyDestination,
    loopCount: turnState?.loopCount ?? 1,
    turnNumber: turnState?.turnNumber ?? 0,
    lastUserMessageContent: turnState?.lastUserMessageContent ?? '',
    pendingSteer: turnState?.pendingSteer ?? null,
  };
}

export interface RegistrySystemResult {
  text: string;
  entryIds: (string | null)[];
}

/** Build the system prompt from slot-sorted entries; a render that throws is skipped, not fatal. */
export function assembleSystemFromRegistry(ctx: AssemblyContext): RegistrySystemResult {
  const outParts: string[] = [];
  const outIds: (string | null)[] = [];
  for (const entry of getSystemEntries()) {
    let r: string | string[] | null = null;
    try {
      r = (entry.when?.(ctx) ?? true) ? entry.render(ctx) : null;
    } catch (err) {
      r = null;
      // Contained but not silent: an entry missing from the prompt with no trace looks like a lost
      // instruction. Warn once per id.
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

export function renderMessageEntry(id: string, ctx: AssemblyContext): EngineMessage | null {
  const entry = getMessageEntries().find((e) => e.id === id);
  if (!entry) return null;
  if (entry.when && !entry.when(ctx)) return null;
  const r = entry.render(ctx);
  if (r == null) return null;
  return Array.isArray(r) ? (r[0] ?? null) : r;
}

/** Render a message entry by id and inject it via the single engine-message channel. */
export function injectRegistryMessage(id: string, messages: EngineMessage[], ctx: AssemblyContext): boolean {
  const msg = renderMessageEntry(id, ctx);
  if (!msg || typeof msg.content !== 'string') return false;
  // The entry id is known here, so every registered injection is tagged with its real id.
  return pushEngineMessage(messages, msg.content, id);
}
