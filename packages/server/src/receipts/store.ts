// Engine-written receipts: the SOLE writer of tool_receipts rows. A side-effecting tool calls
// writeToolReceipt AFTER its provider call returns, so a model cannot fabricate a "sent it."
// HARD RULES: engine-written only; `detail` holds status/anomaly JSON, never bodies or secrets.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { withUnit } from '../db/unit.js';
import { createLogger } from '../logger.js';
import { getCurrentToolCallId } from '../agent/turn-state.js';
import { turnStamp } from '../agent/turn-context.js';
import { noteReceiptForOutbound } from '../agent/v2/outbound.js';

// Bounds the sent_text copy (the pending-question header displays 300 chars).
export const SENT_TEXT_MAX_CHARS = 500;

const logger = createLogger('receipts');

export type ReceiptTier = 1 | 2 | 3;
export type ReceiptBasis = 'provider-id' | 'refetch' | 'http-status' | 'exit-code';

// Receipt tiers: 1 provider id in hand, 2 read-only re-fetch (bodiless 202), 3 unverifiable.
// Hand-picked per provider; executors pass an explicit tier, so this map gates nothing live.
export const RECEIPT_TOOLS: Record<string, ReceiptTier> = {
  gmail_send: 1, gmail_reply: 1, gmail_forward: 1,
  calendar_create: 1, calendar_update: 1,
  sms_send: 1, voice_call: 1,
  teams_send_message: 1, teams_send_channel_message: 1,
  outlook_send: 2, outlook_reply: 2, outlook_forward: 2,
  imessage_send: 3,
  send_to_agent: 1, broadcast_to_group: 1,
};

/**
 * Comms-to-people tools (sensei-policy SEND_TO_PEOPLE) that need no tier. Every member must be in
 * RECEIPT_TOOLS or here with a reason. Keys are exact tool names or trailing-`*` prefix globs.
 */
export const RECEIPT_EXEMPT: Readonly<Record<string, string>> = {
  // User-slot sends write their receipt under the base tool name (google/ and microsoft/ tools-write).
  'user_*': 'user-slot send shares the base tool executor + writes its receipt under the base name',
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
  taskId?: string | null;
  // Bounded copy of WHAT was sent; never a secret.
  sentText?: string | null;
  // Status / anomaly data only, never bodies or secrets.
  detail?: Record<string, unknown> | null;
  sim?: boolean;
  // Skip the paired audit_log row when the caller writes its own.
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
  // Null for receipts written outside a turn.
  conv_key: string | null;
  turn_number: number | null;
  sent_text: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Persist a receipt, write the paired audit_log row, and register the id in the current turn.
 * On DB failure it logs and returns the id unregistered, so the gate never counts it.
 */
export function writeToolReceipt(params: WriteReceiptParams): string {
  const {
    agentId, tool, tier, verified, basis,
    providerId = null, threadId = null, recipient = null, taskId = null,
    sentText = null, detail = null, sim = false, skipAudit = false,
  } = params;

  const receiptId = uuidv4();
  const auditId = skipAudit ? null : uuidv4();
  const detailJson = detail ? JSON.stringify(detail) : null;
  // Attributed to the declared or live turn; NULL outside one.
  const { convKey, turnNumber, root } = turnStamp(agentId);
  const boundedSentText = sentText != null && sentText.length > 0
    ? sentText.slice(0, SENT_TEXT_MAX_CHARS)
    : null;

  try {
    const db = getDb();
    // The audit row and receipt row are ONE unit: tool_receipts.audit_id points at the audit row.
    withUnit(() => {
    if (auditId) {
      db.prepare(`
        INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at)
        VALUES (?, ?, 'tool_call', ?, 'success', ?, datetime('now'))
      `).run(auditId, agentId, tool, `receipt=${receiptId}`);
    }

    const liveCallId = getCurrentToolCallId(agentId);
    db.prepare(`
      INSERT INTO tool_receipts (
        id, agent_id, tool, tier, verified, basis,
        provider_id, thread_id, recipient, task_id, detail, audit_id, sim,
        conv_key, turn_number, sent_text, call_id, root_kind, root_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      receiptId, agentId, tool, tier, verified ? 1 : 0, basis,
      providerId, threadId, recipient, taskId, detailJson, auditId, sim ? 1 : 0,
      convKey, turnNumber, boundedSentText, liveCallId, root?.kind ?? null, root?.id ?? null,
    );
    });

    // Link the delivery this receipt proves; a no-op outside an outbound scope.
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

export function getReceiptsForTask(taskId: string): ToolReceiptRow[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM tool_receipts WHERE task_id = ? ORDER BY created_at DESC`
  ).all(taskId) as ToolReceiptRow[];
}
