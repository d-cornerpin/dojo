// ════════════════════════════════════════
// The audit and receipt excerpts a closeout-miss request puts in front of the PM (moved out of
// `pm-agent.ts` unchanged in what it prints), and, for K35, the STRUCTURED count of the receipts it
// shows per task. That count is what a PM verdict later reports as "receipts shown": it is taken
// from the rows that were printed, never recovered by reading the printed text back.
//
// Only the receipts filed against the task itself are counted. The assignee's recent unstamped
// receipts are printed too (a turn that did not close through the gate leaves them unstamped) but
// they belong to no task, so they are not evidence the PM was shown FOR it.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { listTaskLog } from './task-log.js';

const logger = createLogger('closeout-receipts');

interface ReceiptRow { tool: string; verified: number; basis: string; provider_id: string | null; created_at: string }

const fmtReceipt = (vr: ReceiptRow): string =>
  `    [${vr.created_at}] ${vr.tool} ${vr.verified ? 'VERIFIED' : 'unverified'} (${vr.basis})${vr.provider_id ? `, id ${vr.provider_id}` : ''}`;

export interface CloseoutReceipts {
  /** The block for the request body ('' when there is nothing to show). */
  block: string;
  /** task id -> how many engine receipts filed against that task the block printed. */
  shown: Record<string, number>;
}

/** v2.10.2: the PM sees the audit rows and engine receipts in the same message as the question. */
export function closeoutReceipts(rows: Array<{ id: string }>, assigneeId: string): CloseoutReceipts {
  const shown: Record<string, number> = {};
  try {
    const db = getDb();
    const lines: string[] = [];
    for (const r of rows) {
      // PHASE-2 T10G: reads the trail through its own seam now that the table is gone.
      // `tool_use` is not one of the declared trail kinds and no writer has ever emitted it.
      const auditRows = listTaskLog(r.id, { limit: 6, kinds: ['transition', 'observation'] });
      if (auditRows.length === 0) continue;
      lines.push(`  ${r.id.slice(0, 8)} recent audit (newest first):`);
      for (const a of auditRows) {
        const action = a.actionTaken ?? '(no action recorded)';
        const detail = [a.reason, a.note].filter(Boolean).join(' / ').slice(0, 180);
        lines.push(`    [${a.createdAt}] ${action}${detail ? `, ${detail}` : ''}`);
      }
    }
    // C26: engine-written verification receipts: machine facts (the provider's own id / a read-only
    // re-fetch), so the PM can tell a real send from an invented "sent it". Read-only.
    for (const r of rows) {
      const taskReceipts = db.prepare(`
        SELECT tool, verified, basis, provider_id, created_at
        FROM tool_receipts WHERE task_id = ?
        ORDER BY created_at DESC LIMIT 10
      `).all(r.id) as ReceiptRow[];
      if (taskReceipts.length === 0) continue;
      lines.push(`  ${r.id.slice(0, 8)} engine receipts:`);
      for (const vr of taskReceipts) lines.push(fmtReceipt(vr));
      shown[r.id] = taskReceipts.length;
    }
    const assigneeReceipts = db.prepare(`
      SELECT tool, verified, basis, provider_id, created_at
      FROM tool_receipts
      WHERE agent_id = ? AND task_id IS NULL AND created_at >= datetime('now', '-2 hours')
      ORDER BY created_at DESC LIMIT 10
    `).all(assigneeId) as ReceiptRow[];
    if (assigneeReceipts.length > 0) {
      lines.push(`  ${assigneeId} recent engine receipts (unstamped, last 2h):`);
      for (const vr of assigneeReceipts) lines.push(fmtReceipt(vr));
    }
    const block = lines.length > 0 ? `Audit log excerpts (the actual receipts, read these BEFORE deciding):\n${lines.join('\n')}\n\n` : '';
    return { block, shown };
  } catch (err) {
    logger.warn('Failed to assemble audit-log receipts for closeout-miss A2A (non-fatal)', {
      error: err instanceof Error ? err.message : String(err), taskCount: rows.length,
    });
    return { block: '', shown: {} };
  }
}
