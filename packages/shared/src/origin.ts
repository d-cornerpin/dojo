// Message origin: deriveOrigin() resolves every message to exactly one MessageOrigin (a human on a channel,
// another agent over A2A, the engine, or this agent's own output). Structured columns always win; the
// legacy text-marker parsing is a read shim for rows that predate them.
import type { ChannelKind, InboundMeta } from './visibility.js';
import { parseInboundChannel } from './visibility.js';
// Marker shapes have one owner, ./markers.js: the A2A envelope takes named thread ids, the legacy source
// matcher takes all three forms, and the engine-scaffold matcher is case-insensitive.
import {
  A2A_ENVELOPE_RE,
  A2A_LEGACY_SOURCE_RE,
  ENGINE_SCAFFOLD_RE,
  SOURCE_ENVELOPE_OPENER,
} from './markers.js';

export type Channel = ChannelKind | 'dashboard' | 'voice' | 'a2a' | 'engine';

export type OriginKind =
  | 'user'   // a human on some channel (owner / contact / stranger)
  | 'agent'  // another agent, over A2A
  | 'engine' // the platform itself (tracker / scheduler / healer / system notices)
  | 'self';  // THIS agent's own prior output (assistant text, tool calls/results)

export type Relation =
  | 'owner'         // the primary user themselves
  | 'known_contact' // a safe-sender (friend/colleague on an allowlist)
  | 'third_party'   // an unknown/unauthorized sender
  | 'agent'         // another agent (or this agent, for kind='self')
  | 'engine';       // the platform

export interface MessageOrigin {
  kind: OriginKind;
  relation: Relation;
  channel: Channel | null;
  senderName: string | null; // e.g. "the owner", "the PM agent", "+1555…", or null
  senderId: string | null;   // agent id / address / safe-sender id
  threadId: string | null;   // a2a thread, email message id, teams chat id
  intent: string | null;     // a2a intent (QUESTION/ASSIGN/…) or engine event type (scheduler/tracker/…)
  authorized: boolean;       // may the agent act/reply on this sender's behalf
}

export interface OriginFields {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  source?: string | null;          // 'voice' | 'a2a' | null
  sourceAgentId?: string | null;
  a2aThreadId?: string | null;
  a2aIntent?: string | null;
  a2aRequiresResponse?: number | null;
  inboundMeta?: string | null;     // raw JSON
  originKind?: string | null;      // structured engine-origin (mig 075): 'engine' | null
  originIntent?: string | null;    // engine event type ('tracker' | 'scheduler' | …)
}

// Projects the legacy `source` and `originKind` inputs from the stamped `lane` and `channel`, in one place so
// no reader re-derives the mapping.
export function legacyOriginInputs(
  lane: string | null | undefined,
  channel: string | null | undefined,
): { source: 'voice' | 'a2a' | null; originKind: 'engine' | null } {
  return {
    source: lane === 'a2a' ? 'a2a' : channel === 'voice' ? 'voice' : null,
    originKind: lane === 'events' ? 'engine' : null,
  };
}

function safeParseMeta(raw: string): InboundMeta | null {
  try {
    const m = JSON.parse(raw) as InboundMeta;
    return m && typeof m === 'object' && m.channel ? m : null;
  } catch {
    return null;
  }
}

// Producers stamp `relation` when they know it (the iMessage bridge knows is_primary); else a heuristic.
function relationFromMeta(meta: InboundMeta): Relation {
  if (meta.relation) return meta.relation;
  if (meta.channel === 'dashboard' || meta.channel === 'voice') return 'owner';
  if (meta.authorized === false) return 'third_party';
  return 'known_contact';
}

/** Pull a coarse engine event type out of a legacy `[SOURCE: …]` / `[System: …]` marker. */
function engineIntent(trimmed: string): string {
  const m = /^\[(?:SOURCE:\s*)?([A-Za-z][A-Za-z -]+?)[\]:—(]/.exec(trimmed);
  return m ? m[1].trim().toLowerCase().replace(/\s+/g, '_') : 'system';
}

function engineOrigin(trimmed: string): MessageOrigin {
  return {
    kind: 'engine', relation: 'engine', channel: 'engine',
    senderName: null, senderId: null, threadId: null,
    intent: engineIntent(trimmed), authorized: false,
  };
}

// Structured columns first, text markers only for rows that predate them. Pure: no DB, no side effects.
export function deriveOrigin(f: OriginFields): MessageOrigin {
  const content = f.content ?? '';
  const trimmed = content.replace(/^\s+/, '');

  // Structured engine origin: when a writer stamped origin_kind='engine' the prose is not parsed, so a new
  // engine event type needs no marker here.
  if (f.originKind === 'engine') {
    return {
      kind: 'engine', relation: 'engine', channel: 'engine',
      senderName: null, senderId: null, threadId: null,
      intent: f.originIntent ?? engineIntent(trimmed), authorized: false,
    };
  }

  // This agent's own output (assistant text, tool calls, tool results).
  if (f.role === 'assistant' || f.role === 'tool') {
    return {
      kind: 'self', relation: 'agent',
      channel: f.source === 'a2a' ? 'a2a' : null,
      senderName: null, senderId: null,
      threadId: f.a2aThreadId ?? null, intent: null, authorized: true,
    };
  }

  // Persisted system messages are always engine coordination.
  if (f.role === 'system') return engineOrigin(trimmed);

  // ── role === 'user' (the interesting case: could be a human, an agent, or engine) ──

  // 1. Another agent. The structured columns are authoritative, but prose markers yield to structured
  // inbound_meta: a channel message that merely contains A2A-looking text (a pasted transcript) is
  // classified by its channel.
  const a2a = A2A_ENVELOPE_RE.exec(trimmed);
  const legacyAgent = A2A_LEGACY_SOURCE_RE.exec(trimmed);
  if (f.sourceAgentId || f.a2aThreadId || ((a2a || legacyAgent) && !f.inboundMeta)) {
    return {
      kind: 'agent', relation: 'agent', channel: 'a2a',
      senderName: (a2a?.[3] ?? legacyAgent?.[1])?.trim() ?? null,
      senderId: f.sourceAgentId ?? null,
      threadId: f.a2aThreadId ?? a2a?.[2] ?? null,
      intent: f.a2aIntent ?? a2a?.[1] ?? null,
      authorized: true,
    };
  }

  // 2. In-person speech (dashboard voice).
  if (f.source === 'voice') {
    return {
      kind: 'user', relation: 'owner', channel: 'voice',
      senderName: null, senderId: null, threadId: null, intent: null, authorized: true,
    };
  }

  // 3. Structured inbound_meta, the reliable channel path.
  if (f.inboundMeta) {
    const meta = safeParseMeta(f.inboundMeta);
    if (meta) {
      return {
        kind: 'user', relation: relationFromMeta(meta), channel: meta.channel,
        senderName: meta.sender ?? null, senderId: meta.sender ?? null,
        threadId: meta.chatId ?? meta.emailMessageId ?? null,
        intent: null, authorized: meta.authorized !== false,
      };
    }
  }

  // 4. Legacy channel marker in content (iMessage/Teams/email/SMS/phone).
  const ch = parseInboundChannel(trimmed);
  if (ch) {
    return {
      kind: 'user', relation: 'known_contact', channel: ch.channel,
      senderName: ch.sender, senderId: ch.sender, threadId: null,
      intent: null, authorized: true,
    };
  }

  // 5. Engine coordination wearing role='user' (scheduler/tracker/healer/system…).
  if (ENGINE_SCAFFOLD_RE.test(trimmed) || trimmed.startsWith(SOURCE_ENVELOPE_OPENER)) {
    return engineOrigin(trimmed);
  }

  // 6. Plain text = the owner on dashboard chat.
  return {
    kind: 'user', relation: 'owner', channel: 'dashboard',
    senderName: null, senderId: null, threadId: null, intent: null, authorized: true,
  };
}
