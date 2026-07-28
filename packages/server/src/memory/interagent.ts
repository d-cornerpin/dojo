// ════════════════════════════════════════
// Inter-agent physical store (D-A). Write path + row mapper.
// ════════════════════════════════════════
//
// Backs migration 098_inter_agent_messages.sql. Owner decision D-A: peer A2A
// inbound traffic lives in its OWN physical table (`inter_agent_messages`), not in
// the primary's `messages` chat table, so no forgetful downstream filter can leak
// it into human chat. This module owns the write into that table and the mapping
// from a raw store row back into the shared `Message` shape.
//
// The columns mirror the A2A-relevant columns of `messages` exactly, so the SAME
// rowToMessage + deriveOrigin projection used for `messages` also applies here and
// the merged model tail (memory/store.ts) comes out byte-identical to the legacy
// single-table tail. That byte-identity is the whole point: it protects the
// correctness floor (the weakest model must act on an ASSIGN identically whether it
// was sourced from `messages` or the store).
//
// ── PHASE-1 T4 (2026-07-27): THIS IS NOW A SHIM. T10 DELETES IT. ───────────────
//
// The three INSERTs below no longer write `inter_agent_messages`. They call the single
// writer, which lands the same rows in the unified `messages` table on the lane that
// says what they are: peer inbound and own output on `lane='a2a'`, engine notices on
// `lane='events'`. STRIP; requirement preserved: one INSERT owner, and the physical
// separation D-A bought is now a CHECK-constrained column instead of a second table.
//
// What replaced the separation, because the separation IS the protection and it does
// not survive on trust:
//   * `chat_messages` (migration 127) is `WHERE lane='owner' AND retired_at IS NULL`.
//     The human-facing reads were re-pointed at it in this same commit — the chat
//     history route, the dashboard message feed and the voice last-assistant probe.
//     Before T4 those three read `messages` unfiltered and were kept honest ONLY by
//     the fact that agent traffic physically lived elsewhere.
//   * the module writes the legacy `origin_kind`/`source` values derived from `lane`,
//     so the ~19 anti-join dedups and the pre-D-A `origin_kind != 'engine'` /
//     `source != 'a2a'` filters that never went away keep excluding these rows from
//     the human waiting set exactly as they did before D-A. T5/T6 re-point them onto
//     `lane`; T10 drops the columns.
//   * NO_INTERAGENT_LEAK (dojo-test-kit) was reformulated in the same commit: it now
//     asserts on what the chat ROUTE returns and on what is broadcast, which is the
//     leak's actual surface, instead of scanning for rows in a table they now
//     legitimately live in.
//
// `inter_agent_messages` still EXISTS (R5 — renaming it at T3 killed every assembled turn).
// PHASE-1 T5 deleted the MEMORY layer's readers of it: the merged tail loaders, recall,
// history_get and the vault's store arm. What is left reading it is the raw-SQL long tail
// T6 owns (a2a-transport, a2a-replies, counterparty, loop, the chat route, the boot sweep,
// the Threads lane feed) — re-derive with
// `git grep -nP '(^|[^_[:alnum:]])inter_agent_messages\b' -- packages/`. T10 drops the table
// and this file with it once that list is empty.

import { resolveOrCreateConversation } from './conversations.js';
import type { Message } from '@dojo/shared';
import { insertMessage, insertMessageIfAbsent, tagTurnOutputConvKey } from './message-store.js';

/**
 * Persist one peer A2A inbound row on the A2A lane.
 *
 * Mirrors the exact column set + values deliverA2AMessage used to write into
 * `messages` (role hardcoded 'user', created_at = datetime('now')). Uses
 * INSERT OR IGNORE and returns the raw `changes` so the caller can keep the FA-C4
 * PERSIST_SKIPPED drop check unchanged: the persisted row is the sole delivery
 * vehicle (runtime.handleMessage re-reads it), so a 0-change insert means the
 * message never landed and must NOT be reported as delivered.
 */
export function insertInterAgentMessage(params: {
  id: string;
  agentId: string;                    // recipient
  content: string;
  sourceAgentId: string | null;
  a2aThreadId: string | null;
  a2aIntent: string | null;
  a2aRequiresResponse: number;        // 0 | 1
  attachments: string | null;        // JSON array string, or null
  originKind: string | null;
  originIntent: string | null;
}): { changes: number } {
  // P5: a peer A2A thread is a conversation like any other; identity keyed on
  // the full thread id. Engine-origin rows (no thread) stay conversation-less.
  const conversationId = params.a2aThreadId
    ? resolveOrCreateConversation(params.agentId, {
        channel: 'a2a', provider: null, counterpartyId: params.sourceAgentId, threadRoot: params.a2aThreadId,
      })
    : null;
  // T4: `originKind` was the caller's way of saying "this is engine coordination, not a
  // peer talking" — that IS the lane, so it becomes one and stops being a column the
  // caller stamps. Every other value is passed through unchanged.
  const persisted = insertMessageIfAbsent({
    id: params.id,
    agentId: params.agentId,
    role: 'user',
    lane: params.originKind === 'engine' ? 'events' : 'a2a',
    content: params.content,
    sourceAgentId: params.sourceAgentId,
    a2aThreadId: params.a2aThreadId,
    a2aIntent: params.a2aIntent,
    a2aRequiresResponse: params.a2aRequiresResponse === 1,
    attachments: params.attachments,
    originIntent: params.originIntent,
    conversationId,
  });
  return { changes: persisted ? 1 : 0 };
}

/**
 * Persist one ENGINE-ORIGIN notice/event row on the EVENTS lane
 * (D-A step 4). This is the store home for what the engine-notice writers used to
 * INSERT into `messages`: agent notices (conv_key='engine-notice'), tracker
 * assignments (conv_key NULL), scheduler fires (conv_key NULL), healer-denied
 * notices (conv_key NULL), and the thrash-gate steer (conv_key='engine-steer').
 *
 * Unlike the peer-A2A insert above, an engine row carries a conv_key sentinel
 * and/or a turn_number and NO a2a_* fields, so this takes those columns and leaves
 * the a2a_* columns NULL. origin_kind is hardcoded 'engine' (the whole point: the
 * merged loaders/assembler classify it into the EVENTS lane exactly as the old
 * `messages` row did). The three lifecycle columns (swept_at/delivery_attempts/
 * next_attempt_at, migration 099) are left to their defaults (NULL/0/NULL = never
 * attempted, eligible now), matching a fresh engine row in `messages`.
 *
 * `orIgnore` defaults true (the store idiom + FA-C4 collision-degrades-to-drop
 * rationale). The tracker-assignment writer passes false to PRESERVE its FA-T6
 * reason: with a fresh uuid a constraint collision is impossible, so a plain INSERT
 * only changes behavior for a genuine DB fault, which it lets THROW so the caller's
 * catch reports ok:false honestly instead of a silent skip.
 */
export function insertInterAgentEngineRow(params: {
  id: string;
  agentId: string;                    // recipient
  content: string;
  sourceAgentId: string | null;      // creator/sender, or null for pure-subsystem notices
  originIntent: string | null;
  convKey: string | null;
  turnNumber?: number | null;
  orIgnore?: boolean;
  // P1 lineage spine (migration 112): the WORK this engine row is about, as
  // COLUMNS the serve boundary can read (until now the task/run reference
  // lived only as prose inside content). REQUIRED so every writer states its
  // referent deliberately: pass `work: null` for rows about no specific work
  // (steers, awareness notices, floors); pass real ids for scheduler fires,
  // assignment notices, and anything else a premise check must be able to
  // retire when the referent is spent.
  work: { taskId: string | null; runId: string | null; rootKind: string | null; rootId: string | null } | null;
}): { changes: number } {
  // T4: the hardcoded origin_kind='engine' IS `lane:'events'` (T3-0b §1 maps them
  // value for value). The interpolated VERB — the one write form no literal grep
  // matched, and the reason the conformance walk keys on the TABLE — collapses into
  // the writer module's two named functions, which say the same thing in the type
  // system: `insertMessage` throws, `insertMessageIfAbsent` is a designed no-op.
  // FA-T6 is preserved exactly: the tracker-assignment writer passes orIgnore:false so
  // a genuine DB fault THROWS and its caller reports ok:false instead of a silent skip.
  const row = {
    id: params.id,
    agentId: params.agentId,
    role: 'user' as const,
    lane: 'events' as const,
    content: params.content,
    sourceAgentId: params.sourceAgentId,
    originIntent: params.originIntent,
    convKey: params.convKey,
    turnNumber: params.turnNumber ?? null,
    taskId: params.work?.taskId ?? null,
    runId: params.work?.runId ?? null,
    rootKind: params.work?.rootKind ?? null,
    rootId: params.work?.rootId ?? null,
  };
  if (params.orIgnore === false) {
    insertMessage(row);
    return { changes: 1 };
  }
  return { changes: insertMessageIfAbsent(row) ? 1 : 0 };
}

/**
 * Persist the agent's OWN inter-agent-turn output (role 'assistant' or 'tool')
 * on the A2A lane (D-A step 8). On a turn the persistence
 * classifier marks inter-agent (the six-way interAgentTurn union in agent/v2/
 * loop.ts), the turn's assistant tool_use rows and its tool_result rows belong
 * in the store, NOT in the primary's `messages` chat table, so a coordination
 * burst can never bury (or leak into) the owner's conversation. This is the WRITE
 * twin of the messages own-output INSERTs; the row id is caller-supplied and
 * STABLE (other tables reference message ids) and the content is byte-identical.
 *
 * The row carries the AUTHOR as agent_id (it is the agent's OWN history, not an
 * inbound message), so source_agent_id / a2a_* / origin_kind stay NULL and the
 * DIRECTION ("own output") is derived from `role` (assistant/tool = own output,
 * user = inbound) rather than a new column. conv_key defaults NULL here and is
 * stamped at turn teardown (see tagInterAgentOwnOutputConvKey), exactly mirroring
 * how the messages own-output rows are tagged. The store deliberately omits the
 * display/accounting columns (token_count/model_id/cost/latency_ms/
 * reasoning_content/source); the merged tail loaders NULL-pad them just as they do
 * for peer-A2A rows, so the model view (role/content/order/attachments/
 * turn_number) comes back byte-identical to the legacy single-table tail
 * (reasoning_content round-trips as the established DeepSeek empty-string fallback,
 * which is correctness-neutral for a completed prior turn). INSERT OR IGNORE keeps
 * the store idiom (a colliding id degrades to a drop, never a duplicate).
 */
export function insertInterAgentOwnOutput(params: {
  id: string;
  agentId: string;                    // the author (its own history)
  role: 'assistant' | 'tool';
  content: string;
  attachments?: string | null;        // JSON array string, or null
  turnNumber: number | null;
}): { changes: number } {
  // T4: own output keeps source_agent_id / a2a_* NULL and carries its DIRECTION in
  // `role`, exactly as documented above — which is why migration 127's a2a CHECK had to
  // be amended to `lane <> 'a2a' OR role IN ('assistant','tool') OR source_agent_id IS
  // NOT NULL` (T3-0b §3). Without that amendment every row this function writes would
  // throw at the DB.
  const persisted = insertMessageIfAbsent({
    id: params.id,
    agentId: params.agentId,
    role: params.role,
    lane: 'a2a',
    content: params.content,
    attachments: params.attachments ?? null,
    turnNumber: params.turnNumber ?? null,
  });
  return { changes: persisted ? 1 : 0 };
}

/**
 * Teardown twin of the `messages` conv_key tagging (D-A step 8). The loop tags
 * this turn's own assistant/tool rows with the served conversation's conv_key so
 * one counterparty's work can't bleed into another's turn (content isolation).
 * Since a turn's own output can now live in EITHER table (a mixed human+
 * coordination turn splits its rows by per-phase classification), the tag must
 * reach both homes. This mirrors the messages UPDATE against the store, scoped to
 * this turn's own-output rows only. A no-op (0 rows) on a pure human turn (no
 * store rows for that turn_number). Returns the number of rows tagged.
 */
export function tagInterAgentOwnOutputConvKey(agentId: string, turnNumber: number, convKey: string): number {
  // T4: the turn's a2a own output now lives in `messages` on lane='a2a', so this tags
  // there. The lane argument is what keeps the two taggers from colliding: the loop's
  // own-output tagger is scoped to lane='owner', this one to lane='a2a', which
  // reproduces the pre-T4 split (two tables, two statements) inside one table.
  return tagTurnOutputConvKey({ agentId, turnNumber, convKey, lane: 'a2a' });
}
