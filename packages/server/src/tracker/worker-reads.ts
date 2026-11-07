// ════════════════════════════════════════
// C4 (v3.5 field fix 3 evidence round): WHAT THE WORKER READ WHILE WORKING A TASK, that the PM can
// read again itself.
//
// On the owner's box a read-only job (look the rows up, answer the PM) reached no record: reads are
// never ledger items (`tools/item-keys.ts`), so the PM's door read "nothing on record" and the close
// went round the check through the override door. A read is real work, but a record that counted a
// read as done would let a worker close a job by opening one file. So a read counts the one way the
// validator can verify it: it NAMES what the PM can open itself (`rowReadNames` in `looked-at.ts`),
// and the PM's own read of the same file, message or vault entry is then bound to the row and backs
// the close. A read the PM cannot repeat (a web page, a database query) is shown and never counted.
//
// Built from the engine's own records, never the worker's words: the turns recorded against the task
// (`claim_turn`, `work/task-turns.ts`), the worker's persisted tool calls in those turns, and only the
// calls whose stored result succeeded. A leaf (the database only): the validation request reads it.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';

export interface WorkerReads {
  /** Files and folders it opened (`file_read` / `file_list`). */
  files: string[];
  /** Messages it read by id (`history_get`). */
  messages: string[];
  /** Vault entries it read by id (`vault_get`). */
  vault: string[];
}

/** The newest turns recorded against a task that are read (a long task's oldest turns are not). */
const TURNS_READ = 50;

interface Block { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: unknown }

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The reads the task's worker made, while working it, that the PM can make again (header). */
export function workerReadsOf(workId: string): WorkerReads {
  const out: WorkerReads = { files: [], messages: [], vault: [] };
  try {
    const db = getDb();
    const w = db.prepare('SELECT COALESCE(assignee_agent, agent_id) AS who FROM work WHERE id = ?').get(workId) as { who: string } | undefined;
    if (!w) return out;
    const turns = (db.prepare(
      `SELECT DISTINCT CAST(json_extract(payload, '$.turn_number') AS INTEGER) AS t FROM work_events
        WHERE work_id = ? AND kind = 'claim_turn' ORDER BY t DESC LIMIT ${TURNS_READ}`,
    ).all(workId) as Array<{ t: number | null }>).map((r) => r.t).filter((t): t is number => typeof t === 'number');
    if (turns.length === 0) return out;
    const rows = db.prepare(
      `SELECT content FROM messages WHERE agent_id = ? AND turn_number IN (${turns.map(() => '?').join(',')})
         AND role IN ('assistant', 'tool') AND content LIKE '[{%' ORDER BY created_at, rowid`,
    ).all(w.who, ...turns) as Array<{ content: string }>;
    const calls: Block[] = [];
    const ok = new Map<string, boolean>();
    for (const r of rows) {
      try {
        for (const b of JSON.parse(r.content) as Block[]) {
          if (b?.type === 'tool_use' && b.name && b.id) calls.push(b);
          else if (b?.type === 'tool_result' && b.tool_use_id) ok.set(b.tool_use_id, !b.is_error);
        }
      } catch { /* not a block array */ }
    }
    const add = (into: string[], v: unknown): void => { const s = str(v); if (s && !into.includes(s)) into.push(s); };
    for (const c of calls) {
      if (ok.get(c.id!) !== true) continue;   // a failed read, or one with no stored result, read nothing
      const a = c.input ?? {};
      if (c.name === 'file_read' || c.name === 'file_list') add(out.files, a.path);
      else if (c.name === 'history_get') add(out.messages, a.id);
      else if (c.name === 'vault_get') add(out.vault, a.entry_id);
    }
  } catch { /* an unreadable record names nothing */ }
  return out;
}
