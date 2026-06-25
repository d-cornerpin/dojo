// ════════════════════════════════════════
// Message Origin — the single source of truth for "who is this message from".
//
// Every message an agent stores or sees resolves to exactly one MessageOrigin:
// a human (the owner, a known contact, or an unknown third party) on some
// channel, another agent over A2A, the engine itself, or this agent's own
// output. Today that attribution is scattered across structured columns
// (source, source_agent_id, a2a_*, inbound_meta) AND ~30 ad-hoc text markers
// ([SOURCE: ...], [A2A: ...], [System: ...]). deriveOrigin() consolidates all
// of it into one structured descriptor.
//
// Two callers, by design:
//   • Writers (the future): persist structured fields, origin falls out for free.
//   • Readers (now): store.ts maps every row through deriveOrigin so the engine
//     and dashboard finally SEE the attribution instead of re-parsing prose.
//
// The legacy-marker parsing here is the read-shim for rows written before the
// structured columns existed; once a historical backfill runs it can be deleted
// (Phase 7). Nothing about behavior changes when this lands (Phase 1) — it only
// stops throwing the attribution away at the read seam.
// ════════════════════════════════════════
import type { ChannelKind, InboundMeta } from './visibility.js';
import { parseInboundChannel } from './visibility.js';

/** Every channel a message can physically arrive on, plus the two non-channel origins. */
export type Channel = ChannelKind | 'dashboard' | 'voice' | 'a2a' | 'engine';

/** What KIND of entity produced this message. */
export type OriginKind =
  | 'user'   // a human on some channel (owner / contact / stranger)
  | 'agent'  // another agent, over A2A
  | 'engine' // the platform itself (tracker / scheduler / healer / system notices)
  | 'self';  // THIS agent's own prior output (assistant text, tool calls/results)

/** The sender's relationship to the owner — drives trust + how the model frames them. */
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
  senderName: string | null; // "David", "Kelly", "+1555…", or null
  senderId: string | null;   // agent id / address / safe-sender id
  threadId: string | null;   // a2a thread, email message id, teams chat id
  intent: string | null;     // a2a intent (QUESTION/ASSIGN/…) or engine event type (scheduler/tracker/…)
  authorized: boolean;       // may the agent act/reply on this sender's behalf
}

/** The raw fields deriveOrigin needs — a subset of a messages-table row. */
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

const A2A_MARKER_RE = /^\[A2A:([A-Z]+)\s+thread:([0-9a-fA-F]+)\s+from:([^\]]+)\]/;
const LEGACY_AGENT_RE = /^\[SOURCE: AGENT MESSAGE FROM ([^\]]+)\]/i;

function safeParseMeta(raw: string): InboundMeta | null {
  try {
    const m = JSON.parse(raw) as InboundMeta;
    return m && typeof m === 'object' && m.channel ? m : null;
  } catch {
    return null;
  }
}

/** Relation from structured inbound_meta. Producers stamp `relation` directly
 *  when they know it (e.g. the iMessage bridge knows is_primary → owner vs a
 *  friend → known_contact). The heuristic is the fallback for producers that
 *  haven't stamped it yet. */
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

const ENGINE_PREFIXES = ['[SOURCE:', '[System:', '[SYSTEM', '[Engine', '[CONTINUITY BRIEF', '[Context note'];

/**
 * Resolve a message's origin from its (structured columns first, text markers
 * as a shim) fields. Pure — no DB, no side effects. Structured signals always
 * win over prose; prose is only consulted for rows that predate the columns.
 */
export function deriveOrigin(f: OriginFields): MessageOrigin {
  const content = f.content ?? '';
  const trimmed = content.replace(/^\s+/, '');

  // ── Structured engine origin (write side, mig 075) ──
  // When a writer stamped origin_kind='engine', the attribution is known
  // structurally and we DON'T parse the prose. This is what lets a new engine
  // event type be recognized without adding its marker to the read-shim — the
  // robustness the redesign is for. The [SOURCE: …] text may still be in
  // content (the agent reads it); it is no longer how we classify.
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

  // 1. Another agent (structured A2A columns, or legacy A2A / agent-message marker).
  const a2a = A2A_MARKER_RE.exec(trimmed);
  const legacyAgent = LEGACY_AGENT_RE.exec(trimmed);
  if (f.sourceAgentId || f.a2aThreadId || a2a || legacyAgent) {
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

  // 3. Structured inbound_meta — the reliable channel path.
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
  if (ENGINE_PREFIXES.some((p) => trimmed.startsWith(p))) {
    return engineOrigin(trimmed);
  }

  // 6. Plain text = the owner on dashboard chat.
  return {
    kind: 'user', relation: 'owner', channel: 'dashboard',
    senderName: null, senderId: null, threadId: null, intent: null, authorized: true,
  };
}
