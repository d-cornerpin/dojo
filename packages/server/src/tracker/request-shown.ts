// v3.5 field fix 3, review M1: WHAT THE LAST VALIDATION REQUEST SHOWED OF A ROW'S LEDGER.
//
// The request lays the ledger out in the PM's room (`tracker/job-loop-facts.ts`), so it shows a page of
// a long ledger and counts the rest. The verdict record (`tracker/looked-at.ts`) records exactly that
// page: "what the request showed", bounded the same way, instead of re-reading the whole ledger into
// `adjudications.evidence_ref`. A leaf (no imports): the verdict record is read on the spine.
//
// Process memory on purpose: it is the request this process put in front of the PM. A verdict with no
// request shown since the process started records the counts only. The entry is replaced by the next
// request for the row and dropped when the row is no longer awaiting a verdict (`keepLedgerShownFor`).

export interface LedgerShown {
  files: string[];
  /** Audit #5: the sends the page listed (the recipient, or null when the tool derives it). */
  sends?: Array<{ tool: string; to: string | null }>;
  commandsRun: Array<{ command: string; status: string | null }>;
  /** Entries the room could not list. */
  notListed: number;
}

const shown = new Map<string, LedgerShown>();
/** Audit #5: the delivered answer (its delivery id) whose excerpt the last request for the row printed. */
const answers = new Map<string, string>();

export function noteLedgerShown(taskId: string, page: LedgerShown): void { shown.set(taskId, page); }
export function ledgerShownFor(taskId: string): LedgerShown | undefined { return shown.get(taskId); }
/** The review's request printed this answer's excerpt (pm-agent's DELIVERED ANSWER line). */
export function noteAnswerShown(taskId: string, deliveryId: string): void { answers.set(taskId, deliveryId); }
export function answerShownFor(taskId: string): string | undefined { return answers.get(taskId); }
/** Drop every row not in `pending` (the rows still awaiting a verdict). */
export function keepLedgerShownFor(pending: ReadonlySet<string>): void {
  for (const id of [...shown.keys()]) if (!pending.has(id)) shown.delete(id);
  for (const id of [...answers.keys()]) if (!pending.has(id)) answers.delete(id);
}
