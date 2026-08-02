// ════════════════════════════════════════
// C26: Verified action receipts (engine-written)
// ════════════════════════════════════════
//
// The SOLE writer of tool_receipts rows. A consequential, side-effecting tool
// (send / calendar / file) calls writeToolReceipt AFTER its provider call
// returns, handing over the machine id the provider issued. The engine, not
// the model, captures and persists it, so a weak model can never fabricate a
// "sent it." The tracker complete gate then demands a verified receipt for any
// turn that ran a send-class tool (see tracker/tools.ts).
//
// Two rows are written per receipt, atomically: the tool_receipts row itself
// and a uniform audit_log `tool_call` row that points back at it (restoring a
// provenance join, since a successful gmail_send writes no audit_log row today).
// The receipt id is also registered in the per-turn in-memory register
// (turn-state.ts) which is the gate's primary, same-process discovery path.
//
// HARD RULES: engine-written only (no model input reaches here); `detail` holds
// status / anomaly JSON ONLY, never message bodies, never secrets.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { withUnit } from '../db/unit.js';
import { createLogger } from '../logger.js';
import { getCurrentToolCallId, currentTurnRoot, noteTurnReceipt, currentTurnConvKey, currentTurnNumber } from '../agent/turn-state.js';
import { noteReceiptForOutbound } from '../agent/v2/outbound.js';

// RC-12: bound the sent_text copy. The full body already lives in the messages
// tool_use args; the receipt only needs enough to quote the agent's own recent
// message back to it (the pending-question header caps display at 300). Storing a
// little more than the display cap keeps the column bounded without truncating a
// short message.
const SENT_TEXT_MAX_CHARS = 500;

const logger = createLogger('receipts');

export type ReceiptTier = 1 | 2 | 3;
export type ReceiptBasis = 'provider-id' | 'refetch' | 'http-status' | 'exit-code';

// C26: the side-effecting tools that produce a receipt, mapped to their tier.
// Tier 1 = provider id already in hand; tier 2 = read-only re-fetch (Graph
// sendMail 202 no-body); tier 3 = honestly unverifiable (iMessage exit code).
// Used by the dev harness intercept to pick the tier for a synthetic
// receipt, and available to any caller that needs the canonical tier.
//
// HAND-PICKED, NOT DERIVABLE: the VALUE is a verification TIER (how the send can
// be confirmed), which is a per-provider fact no effect/channel classifier
// knows, gmail_send hands back a message id (tier 1) but outlook_send returns a
// bodiless 202 that needs a re-fetch (tier 2) and imessage_send can only read an
// exit code (tier 3). Production receipts are written by each tool executor
// calling writeToolReceipt with an explicit tier (this map does not gate them),
// so drift here weakens only dev-harness coverage, not the live gate. The tool-
// list conformance tripwire asserts every KEY here is a real registered tool so
// a rename cannot rot the map unnoticed.
export const RECEIPT_TOOLS: Record<string, ReceiptTier> = {
  gmail_send: 1, gmail_reply: 1, gmail_forward: 1,
  calendar_create: 1, calendar_update: 1,
  sms_send: 1, voice_call: 1,
  teams_send_message: 1, teams_send_channel_message: 1,
  outlook_send: 2, outlook_reply: 2, outlook_forward: 2,
  imessage_send: 3,
  // PHASE-2 T5 (research 03's registry drift, re-derived on this box): the live
  // `tool_receipts` table shows 8 distinct tools, two of which — `send_to_agent` (993 rows)
  // and `broadcast_to_group` — have been WRITING receipts for months while absent from the
  // map that documents how each send is verified. The map was never the gate (executors pass
  // an explicit tier), so the drift cost nothing at runtime and everything in truthfulness:
  // the one place that answers "how do we know this send happened" did not mention the
  // busiest send in the product. Tier 1 — the A2A transport hands back the persisted peer
  // message id, which is a provider-issued identifier in exactly the sense the tier means.
  send_to_agent: 1, broadcast_to_group: 1,
};

/**
 * NOT-APPLICABLE ledger for the RECEIPT exhaustiveness check (anti-omission,
 * 2026-07-08). The conformance test + release gate account for the WHOLE
 * comms-to-people surface (every member of sensei-policy SEND_TO_PEOPLE): each
 * must either carry a tier in RECEIPT_TOOLS above OR be matched here with a
 * reason. A new comms send added to SEND_TO_PEOPLE with neither fails the build,
 * naming the tool, so a send can never ship without a delivery-verification
 * decision (the failure mode the receipt machinery exists to prevent). Keys are
 * exact tool names or family-prefix globs (trailing `*`).
 *
 * Coupling the domain to SEND_TO_PEOPLE (not just channelOfSendTool) is
 * deliberate: it makes "reaches a person" and "has a receipt decision" the same
 * gate, so a whole new comms channel can't be added on the security side while
 * silently skipping delivery verification.
 */
export const RECEIPT_EXEMPT: Readonly<Record<string, string>> = {
  // user-slot sends run the BASE tool's executor and write their receipt under
  // the base tool name (already tiered above, e.g. user_gmail_send -> gmail_send
  // tier 1), so a separate tier here would be dead. See writeToolReceipt callers
  // in google/tools-write.ts + microsoft/tools-write.ts (they hardcode the base
  // tool name).
  'user_*': 'user-slot send shares the base tool executor + writes its receipt under the base name',
  // non-send members of the comms surface: no delivery to verify.
  'imessage_list_contacts': 'contact read, not a send',
  'voice_call_end': 'call lifecycle, not a message delivery',
  'voice_call_status': 'call status read, not a message delivery',
};

export interface WriteReceiptParams {
  agentId: string;
  tool: string;                 // canonical tool name
  tier: ReceiptTier;
  verified: boolean;
  basis: ReceiptBasis;
  providerId?: string | null;   // Gmail message id, Twilio SID, Graph/event id, ...
  threadId?: string | null;
  recipient?: string | null;
  // RC-12: a bounded copy of WHAT was sent (imessage/sms: the body; email:
  // subject + first 300 chars of body). Used by the pending-question header +
  // delivery-claim guard. The engine passes it; NEVER a secret / credential.
  sentText?: string | null;
  // Status / anomaly data only. NEVER message bodies, NEVER secrets.
  detail?: Record<string, unknown> | null;
  sim?: boolean;
  // When the caller already writes its own audit_log row (e.g. imessage_send
  // keeps a richer over-share audit line), set this to skip the writer's paired
  // row and avoid a double-write. The receipt row + turn register still happen.
  skipAudit?: boolean;
}

export interface ToolReceiptRow {
  id: string;
  agent_id: string;
  tool: string;
  tier: number;
  verified: number;
  basis: string;
  provider_id: string | null;
  thread_id: string | null;
  recipient: string | null;
  detail: string | null;
  audit_id: string | null;
  task_id: string | null;
  sim: number;
  // RC-12 (migration 106): conversation + turn + sent-text context. Nullable
  // for legacy rows and receipts written outside a turn.
  conv_key: string | null;
  turn_number: number | null;
  sent_text: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Persist an engine-written receipt for a side-effecting tool call, write the
 * paired audit_log row, and register the id in the current turn. Returns the
 * new receipt id. On DB failure it logs and returns the id without registering
 * it (so the gate does not count a receipt that was never stored).
 */
export function writeToolReceipt(params: WriteReceiptParams): string {
  const {
    agentId, tool, tier, verified, basis,
    providerId = null, threadId = null, recipient = null,
    sentText = null, detail = null, sim = false, skipAudit = false,
  } = params;

  const receiptId = uuidv4();
  const auditId = skipAudit ? null : uuidv4();
  const detailJson = detail ? JSON.stringify(detail) : null;
  // RC-12: attribute the receipt to the turn that produced it. Resolved from the
  // live turn state (engine facts, never model input), so send executors don't
  // have to thread conv_key / turn_number through every call. A missing entry
  // (receipt written outside a turn) leaves the column NULL.
  const convKey = currentTurnConvKey.get(agentId) ?? null;
  const turnNumber = currentTurnNumber.get(agentId) ?? null;
  const boundedSentText = sentText != null && sentText.length > 0
    ? sentText.slice(0, SENT_TEXT_MAX_CHARS)
    : null;

  try {
    const db = getDb();
    // T2: the audit row and the receipt row are ONE unit. `tool_receipts.audit_id`
    // POINTS at the audit row, so a half-applied pair is a receipt naming an audit
    // entry that does not exist — the receipt tier's own provenance, broken.
    withUnit(() => {
    // Paired audit_log row (uniform tool_call provenance). detail points at the
    // receipt id only (no bodies, no secrets). Skipped when the caller already
    // wrote its own audit row for this send.
    if (auditId) {
      db.prepare(`
        INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at)
        VALUES (?, ?, 'tool_call', ?, 'success', ?, datetime('now'))
      `).run(auditId, agentId, tool, `receipt=${receiptId}`);
    }

    // P6a: the receipt binds to the EXACT tool_use call and the root the turn
    // serves (live turn state, same pattern as conv_key/turn_number).
    const liveCallId = getCurrentToolCallId(agentId);
    const liveRoot = currentTurnRoot.get(agentId) ?? null;
    db.prepare(`
      INSERT INTO tool_receipts (
        id, agent_id, tool, tier, verified, basis,
        provider_id, thread_id, recipient, detail, audit_id, sim,
        conv_key, turn_number, sent_text, call_id, root_kind, root_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      receiptId, agentId, tool, tier, verified ? 1 : 0, basis,
      providerId, threadId, recipient, detailJson, auditId, sim ? 1 : 0,
      convKey, turnNumber, boundedSentText, liveCallId, liveRoot?.kind ?? null, liveRoot?.id ?? null,
    );
    });

    noteTurnReceipt(agentId, receiptId);
    // PHASE-2 T5 (Phase-1 §7 debt): the delivery this receipt proves. `deliveries.receipt_id`
    // was in the INSERT column list and never given a value — 44 rows, 0 populated — and the
    // join it replaces guessed at the link from agent + turn + tool. The two SOLE WRITERS
    // establish it between themselves, inside the outbound scope the send opened, so there is
    // nothing left to reconstruct. A no-op outside a scope.
    noteReceiptForOutbound(receiptId);

    logger.info('tool receipt written', {
      tool, tier, verified, basis,
      providerId: providerId ?? null,
      sim: sim ? 1 : 0,
      receiptId,
    }, agentId);
  } catch (err) {
    logger.error('Failed to write tool receipt', {
      tool, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  return receiptId;
}

/** Load the tool_receipts rows for a set of ids (gate consumption). */
export function getReceiptsByIds(ids: string[]): ToolReceiptRow[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM tool_receipts WHERE id IN (${placeholders})`
  ).all(...ids) as ToolReceiptRow[];
}

/**
 * Stamp task_id (+ updated_at) on receipts consumed as evidence by the gate.
 * Only rows not yet attached to a task are stamped (task_id IS NULL), so when
 * two tasks complete in the same turn each receipt attaches to exactly one
 * task (first complete wins) instead of the last complete overwriting all.
 */
export function stampReceiptsTask(ids: string[], taskId: string): void {
  if (ids.length === 0) return;
  try {
    const db = getDb();
    const stmt = db.prepare(
      `UPDATE tool_receipts SET task_id = ?, updated_at = datetime('now') WHERE id = ? AND task_id IS NULL`
    );
    const tx = db.transaction((rows: string[]) => {
      for (const id of rows) stmt.run(taskId, id);
    });
    tx(ids);
  } catch (err) {
    logger.warn('Failed to stamp task on receipts (non-fatal)', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Receipts for a task, plus (optionally) recent rows for an assignee. PM read. */
export function getReceiptsForTask(taskId: string): ToolReceiptRow[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM tool_receipts WHERE task_id = ? ORDER BY created_at DESC`
  ).all(taskId) as ToolReceiptRow[];
}
