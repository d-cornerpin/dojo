// How each kind of proof item resolves, for `work/done/proof.ts`. Every item is a reference to a row
// the engine itself wrote; it is real only when that row exists, was made by the worker, and was made
// at or after the task was opened. Prose never resolves: a remainder is the one named item, and only
// for "can't be done". What the row holds is copied into the item's facts, so a later reader shows
// the proof as it stood when it was checked.
import { getDb } from '../../db/connection.js';
import { measureReadsZero } from '../measure-close-gate.js';
import { ENGINE_SENT_TOOLS, ENGINE_JOIN_RELAY_TOOLS, NON_ANSWERING_DISPLAY_KINDS } from '../ask-settlement.js';
import { START_ACK_ORIGIN_INTENT } from '../../memory/origin-intents.js';
import { askerOf, deliveredToAsker, type Asker } from './asker.js';
import { requestsTakenUpBy, servedBy } from '../task-turns.js';
import { occurrenceOwesDeliverable } from '../deliverable-declaration.js';
import { fileFacts } from './file-facts.js';

export type HandInOutcome = 'finished' | 'cant_be_done';
export type ProofKind = 'file' | 'delivery' | 'command' | 'receipt' | 'measure' | 'remainder' | 'failure';
type Facts = Record<string, string | number>;

/** A proof item as the worker names it: a kind, a reference the engine resolves, and for a remainder its `reason`. */
export interface ProofItemInput { kind: ProofKind; ref: string; facts?: { reason?: string } }
/** A proof item as the engine resolved it: what it found at the reference. */
export interface ResolvedItem { kind: ProofKind; ref: string; label: string; facts: Facts }

/** `ask`: the request the task exists for, when it has one, with the delivery its settlement recorded (the
 *  engine's own reading of which line answered it). */
export interface ProofTask { id: string; title: string | null; openedAt: number; ask: { id: string; receipt: string | null } | null }
/** `byEngine`: the engine files this hand-in for its worker. The delivery it cites may then go to whoever
 *  the work serves (a scheduled run's line to a third party), and may be the engine's own join relay of
 *  the work; every other engine line stays refused. */
export interface ProofContext { task: ProofTask; asker: Asker; workerId: string; outcome: HandInOutcome; byEngine?: boolean }
export type Resolution = { ok: true; item: ResolvedItem } | { ok: false; why: string };

/** The label every reader shows for each kind. A delivery is the worker's own message, never "the answer". */
export const PROOF_LABELS: Record<ProofKind, string> = {
  file: 'a file the worker wrote during the task',
  delivery: "the worker's own message to the asker",
  command: 'a command the worker ran',
  receipt: "an outside action's receipt",
  measure: "the task's measure",
  remainder: 'what was left undone, and why',
  failure: 'a failed attempt',
};
const CANT_BE_DONE_ONLY: ReadonlySet<ProofKind> = new Set(['remainder', 'failure']);
/** The shortest reason a remainder may give. */
export const MIN_REASON = 15;

/** Words a bare status claim is made of. Anything else (and the task's own title and ids) is content. */
const STATUS_WORDS = new Set([
  'done', 'finished', 'finish', 'complete', 'completed', 'completion', 'closed', 'close', 'closing', 'wrapped', 'wrap',
  'up', 'all', 'set', 'ok', 'okay', 'ready', 'review', 'validation', 'validate', 'validated', 'verify', 'verified',
  'please', 'pls', 'task', 'tasks', 'job', 'work', 'step', 'item', 'it', 'its', 'this', 'that', 'the', 'a', 'an', 'is',
  'was', 'has', 'have', 'had', 'been', 'are', 'now', 'i', 'im', 'ive', 'we', 'me', 'my', 'our', 'as', 'for', 'to',
  'of', 'on', 'with', 'and', 'so', 'just', 'marked', 'mark', 'handled', 'sorted', 'taken', 'care', 'fixed',
  'resolved', 'delivered', 'sent', 'submitted', 'filed', 'status', 'update', 'thanks', 'thank', 'you', 'request',
  'requested', 'confirm', 'confirmed', 'success', 'successfully', 'successful', 'good', 'go', 'your', 'pm', 'hey',
  'hi', 'hello', 'fyi', 'note', 'over', 'back', 'here', 'there', 'yours', 'awaiting', 'waiting', 'key', 'id',
  'today', 'already', 'should', 'be', 'can', 'will', 'out', 'off', 'per', 'via', 'from', 'by', 'at', 'in',
  'answer', 'deliverable', 'reply', 'replied', 'answered', 'everything', 'left', 'more',
  'kind', 'reason', 'result', 'results', 'outcome', 'state', 'progress', 'percent', 'fully', 'totally', 'really',
]);

/** Is this text nothing but a status claim about the task ("done", "task abc12345 is complete, please
 *  validate")? Empty text is one too. A number, or any word outside the status words, is content. */
export function isStatusClaimOnly(text: string, task: { id: string; title?: string | null } | null = null): boolean {
  const norm = (x: string): string => x.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9-]+/g, ' ').trim();
  let t = ` ${norm(text.replace(/^(?:\s*\[[^\]]*\])+/, '')).replace(/\b[0-9a-f]{8}[0-9a-f-]*\b/g, ' ')} `;
  const title = norm(task?.title ?? '');
  if (title) t = t.split(` ${title} `).join(' ');
  return (t.match(/[a-z0-9]+/g) ?? []).every((w) => !/[0-9]/.test(w) && STATUS_WORDS.has(w));
}

/** Does a message to another agent with this A2A intent hand over the work? Only ANSWER, DELIVERABLE and
 *  COMPLETE do; FYI, STATUS, QUESTION, ASSIGN, BLOCK and FAIL never. */
export const handsOverWork = (intent: string | null | undefined): boolean => ['ANSWER', 'DELIVERABLE', 'COMPLETE'].includes((intent ?? '').toUpperCase());
/** The A2A intent a stored line or delivery detail carries ("[A2A:ANSWER ...", "A2A ANSWER"). */
const intentOf = (text: string | null): string | null => /^\s*\[?A2A[:\s]([A-Z]+)/.exec(text ?? '')?.[1] ?? null;

/** `datetime('now')` text (UTC, whole seconds) to epoch ms; NaN when it does not parse. */
export function sqlTimeMs(text: string): number {
  return /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(text) ? Date.parse(`${text.replace(' ', 'T')}Z`) : Date.parse(text);
}
/** The second the task was opened in: second-resolution rows written in that second count as after it. */
export const openedFloor = (task: ProofTask): number => Math.floor(task.openedAt / 1000) * 1000;
/** `datetime('now')` text for an instant, floored to its second: how the rows below stamp their time. */
export const sqlFloor = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('T', ' ').slice(0, 19);

type Addressed = { channel: string; recipient_id: string | null; conversation_id: string | null };
/** Is the record of `agentId`'s turn `turn` tied to the task: `yes` when that turn served the task, one of its runs or
 *  its request; `ambiguous` when a delivery `to` the asker also reaches the asker of another task whose open run the
 *  turn served and which owes a message; else `no`. */
function tieOf(ctx: ProofContext, agentId: string, turn: number | null, to?: Addressed): 'yes' | 'no' | 'ambiguous' {
  const served = turn === null ? [] : servedBy(agentId, turn);
  if (!served.some((s) => s.id === ctx.task.id || s.id === ctx.task.ask?.id)) return 'no';
  const other = (runId: string): string | null => { const o = occurrenceOwesDeliverable(runId); return o.owes && o.taskId !== ctx.task.id ? o.taskId : null; };
  return to && served.some((s) => { const t = s.kind === 'occurrence' ? other(s.id) : null; return !!t && deliveredToAsker(askerOf(t), to); }) ? 'ambiguous' : 'yes';
}
const excerpt = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
const claim = (ctx: ProofContext, text: string): boolean => isStatusClaimOnly(text, { id: ctx.task.id, title: ctx.task.title });

function ownRow(ctx: ProofContext, agentId: string, atMs: number): string | null {
  if (agentId !== ctx.workerId) return 'was not made by the worker';
  if (!(atMs >= openedFloor(ctx.task))) return 'was made before the task was opened';
  return null;
}

type Resolver = (ctx: ProofContext, ref: string, input: ProofItemInput) => Facts | string;

function delivery(ctx: ProofContext, ref: string): Facts | string {
  const d = getDb().prepare(
    `SELECT d.agent_id, d.tool, d.channel, d.recipient_id, d.recipient_display, d.conversation_id, d.outcome, d.created_at, d.detail,
            d.turn_number, d.message_id, m.display_kind, m.origin_intent, COALESCE(m.content, r.sent_text) AS text
       FROM deliveries d LEFT JOIN messages m ON m.id = d.message_id LEFT JOIN tool_receipts r ON r.id = d.receipt_id
      WHERE d.id = ?`,
  ).get(ref) as { agent_id: string; tool: string; channel: string; recipient_id: string | null; detail: string | null;
    turn_number: number | null; message_id: string | null;
    display_kind: string | null; origin_intent: string | null; recipient_display: string | null; conversation_id: string | null;
    outcome: string; created_at: string; text: string | null } | undefined;
  if (!d) return '';
  if (d.outcome !== 'delivered') return `was not delivered (its outcome is ${d.outcome})`;
  if (d.origin_intent === START_ACK_ORIGIN_INTENT || (isEngineTool(d.tool) && !(ctx.byEngine && ENGINE_JOIN_RELAY_TOOLS.has(d.tool)))) {
    return "is the engine's own line or acknowledgement, not the worker's message";
  }
  if ((NON_ANSWERING_DISPLAY_KINDS as readonly string[]).includes(d.display_kind ?? '')) return 'is a tool chip or working note, not a message';
  const own = ownRow(ctx, d.agent_id, sqlTimeMs(d.created_at));
  if (own) return own;
  if ((!ctx.byEngine || (ctx.asker.kind === 'person' && !ctx.asker.owner)) && !deliveredToAsker(ctx.asker, d)) return 'was not addressed to the asker (it went to someone else)';
  if (d.channel === 'a2a' && !handsOverWork(intentOf(d.detail) ?? intentOf(d.text))) return 'does not hand over the work (its intent is not an answer or a deliverable)';
  if (d.text === null) return 'carries no text on record, so it shows no work';
  if (claim(ctx, d.text)) return 'is only a status claim, which is never proof';
  if (startLineOfItsTurn(ctx, ref, d)) return 'is the start line of its turn, not the answer';
  return { channel: d.channel, recipient: d.recipient_display ?? d.recipient_id ?? 'the owner', at: d.created_at,
    message: d.message_id ?? '', excerpt: excerpt(d.text), tied: tieOf(ctx, d.agent_id, d.turn_number, d) };
}

const isEngineTool = (tool: string): boolean => ENGINE_SENT_TOOLS.has(tool) || tool.endsWith('-door');

/** Is this delivery the start line of its turn: only in a turn that took up the task's request, and never the line
 *  that request settled on; then the worker's first line to the asker in that turn when another line to the asker
 *  follows, or, once the turn has ended, a lone line when the request settled on some other line? Keyed to the
 *  delivery's own turn record, never to what the worker does afterwards. */
function startLineOfItsTurn(ctx: ProofContext, ref: string, d: { agent_id: string; turn_number: number | null }): boolean {
  const ask = ctx.task.ask;
  if (d.turn_number === null || !ask || ref === ask.receipt
    || !requestsTakenUpBy(d.agent_id, d.turn_number).includes(ask.id)) return false;
  const db = getDb();
  // The worker's own lines to the asker only: never the engine's, never a tool chip or working note.
  const lines = (db.prepare(
    `SELECT d.id, d.tool, d.channel, d.recipient_id, d.conversation_id FROM deliveries d LEFT JOIN messages m ON m.id = d.message_id
      WHERE d.agent_id = ? AND d.turn_number = ? AND d.outcome = 'delivered'
        AND (m.display_kind IS NULL OR m.display_kind NOT IN (${NON_ANSWERING_DISPLAY_KINDS.map(() => '?').join(', ')}))
      ORDER BY d.created_at, d.rowid`,
  ).all(d.agent_id, d.turn_number, ...NON_ANSWERING_DISPLAY_KINDS) as
    Array<{ id: string; tool: string; channel: string; recipient_id: string | null; conversation_id: string | null }>)
    .filter((r) => !isEngineTool(r.tool) && deliveredToAsker(ctx.asker, r)).map((r) => r.id);
  if (lines[0] !== ref) return false;
  if (lines.length > 1) return true;
  const ended = db.prepare('SELECT ended_at FROM turns WHERE agent_id = ? AND turn_number = ?').get(d.agent_id, d.turn_number) as { ended_at: string | null } | undefined;
  return !!ended?.ended_at && !!ask.receipt;
}

/** The exit status an exec audit row records: 0, the code, or the reason it stopped. */
function exitOf(result: string, detail: string | null): number | string {
  if (result === 'success') return 0;
  const code = /^exit (\d+)/.exec(detail ?? '');
  return code ? Number(code[1]) : result === 'denied' ? 'refused before it ran' : (detail ?? 'failed').split(' | ')[0];
}

/** The worker's newest run of the command as it ran it: the shell script, or the exec argv joined by spaces. */
function command(ctx: ProofContext, ref: string): Facts | string {
  const a = getDb().prepare(
    `SELECT target, result, detail, created_at, turn_number FROM audit_log a
      WHERE action_type = 'exec' AND agent_id = ? AND target = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(ctx.workerId, ref) as
    { target: string | null; result: string; detail: string | null; created_at: string; turn_number: number | null } | undefined;
  if (!a) return 'is not a command the worker ran';
  if (!(sqlTimeMs(a.created_at) >= openedFloor(ctx.task))) return 'was run before the task was opened';
  const exit = exitOf(a.result, a.detail);
  if (ctx.outcome === 'finished' && exit !== 0) return `did not succeed (exit ${exit}), so it cannot prove a finished task`;
  return { command: a.target ?? '', exit, output: excerpt(a.detail), at: a.created_at, tied: tieOf(ctx, ctx.workerId, a.turn_number) };
}

interface ReceiptRow {
  agent_id: string; tool: string; verified: number; basis: string; recipient: string | null; detail: string | null; created_at: string; turn_number: number | null; task_id: string | null;
}
const receiptRow = (ref: string): ReceiptRow | undefined => getDb().prepare(
  'SELECT agent_id, tool, verified, basis, recipient, detail, created_at, turn_number, task_id FROM tool_receipts WHERE id = ?',
).get(ref) as ReceiptRow | undefined;

/** The error a receipt's detail JSON carries, or ''. */
function receiptError(detail: string | null): string {
  try {
    const e = (JSON.parse(detail ?? '{}') as { error?: unknown }).error;
    return e === undefined || e === null || e === '' || e === false ? '' : excerpt(typeof e === 'string' ? e : JSON.stringify(e));
  } catch { return ''; }
}

/** Messages to other agents are judged as deliveries (to the asker, handing over the work), never as receipts. */
const AGENT_SEND_TOOLS: ReadonlySet<string> = new Set(['send_to_agent', 'broadcast_to_group']);

function receipt(ctx: ProofContext, ref: string): Facts | string {
  const r = receiptRow(ref);
  if (!r) return '';
  if (AGENT_SEND_TOOLS.has(r.tool)) return 'is a message to another agent, which proves the work only as a delivery to the asker';
  const own = ownRow(ctx, r.agent_id, sqlTimeMs(r.created_at));
  if (own) return own;
  if (ctx.outcome === 'finished' && r.verified !== 1) return 'was not confirmed by the provider, so it cannot prove a finished task';
  const error = receiptError(r.detail);
  return { tool: r.tool, verified: r.verified, basis: r.basis, recipient: r.recipient ?? '', at: r.created_at,
    tied: r.task_id === ctx.task.id ? 'yes' : tieOf(ctx, r.agent_id, r.turn_number), ...(error ? { error } : {}) };
}

function measure(ctx: ProofContext, ref: string): Facts | string {
  if (!/^\d+$/.test(ref)) return '';
  const db = getDb();
  const ev = db.prepare("SELECT id, created_at FROM work_events WHERE id = ? AND work_id = ? AND kind = 'measured'")
    .get(Number(ref), ctx.task.id) as { id: number; created_at: number } | undefined;
  if (!ev) return '';
  const newest = db.prepare("SELECT MAX(id) AS id FROM work_events WHERE work_id = ? AND kind = 'measured'").get(ctx.task.id) as { id: number };
  if (newest.id !== ev.id) return `is not the task's newest reading (that is ${newest.id})`;
  if (ev.created_at < ctx.task.openedAt) return 'was made before the task was opened';
  const w = db.prepare('SELECT measure_json, measure_initial, measure_remaining FROM work WHERE id = ?').get(ctx.task.id) as
    { measure_json: string | null; measure_initial: number | null; measure_remaining: number | null };
  let unit = 'items';
  try { unit = String((JSON.parse(w.measure_json ?? '{}') as { unit?: string }).unit ?? 'items'); } catch { /* the count is the fact */ }
  if (ctx.outcome === 'finished' && !measureReadsZero(ctx.task.id)) {
    return `does not read 0 (${w.measure_remaining ?? 'no reading'} ${unit} left, from ${w.measure_initial ?? 'no reading'})`;
  }
  return { unit, left: w.measure_remaining ?? -1, initial: w.measure_initial ?? -1, at: ev.created_at };
}

function remainder(ctx: ProofContext, ref: string, input: ProofItemInput): Facts | string {
  const reason = (input.facts?.reason ?? '').trim();
  if (claim(ctx, ref)) return 'does not name what was left undone';
  if (reason.length < MIN_REASON || claim(ctx, reason)) return `needs a reason of at least ${MIN_REASON} characters saying why it was left`;
  return { reason };
}

function failure(ctx: ProofContext, ref: string): Facts | string {
  const r = receiptRow(ref);
  if (!r) return '';
  const error = receiptError(r.detail);
  if (!error) return 'carries no error';
  return ownRow(ctx, r.agent_id, sqlTimeMs(r.created_at)) ?? { source: 'receipt', action: r.tool, target: r.recipient ?? '', error, at: r.created_at };
}

function file(ctx: ProofContext, ref: string): Facts | string {
  const writes = getDb().prepare(
    `SELECT created_at AS at, turn_number FROM audit_log WHERE action_type = 'file_write' AND result = 'success' AND agent_id = ? AND target = ?
      ORDER BY created_at DESC`,
  ).all(ctx.workerId, ref) as Array<{ at: string; turn_number: number | null }>;
  if (writes.length === 0) return 'is a file the worker never wrote';
  if (!(sqlTimeMs(writes[0]!.at) >= openedFloor(ctx.task))) return 'was written before the task was opened';
  const f = fileFacts(ctx.workerId, ref);
  const tied = writes.some((w) => w.at >= sqlFloor(ctx.task.openedAt) && tieOf(ctx, ctx.workerId, w.turn_number) === 'yes') ? 'yes' : 'no';
  return f.ok ? { ...f.facts, tied } : f.why;
}

const RESOLVERS: Record<ProofKind, Resolver> = { file, delivery, command, receipt, measure, remainder, failure };

/** Resolve one item against its row, or say plainly why it does not resolve. */
export function resolveItem(ctx: ProofContext, input: ProofItemInput): Resolution {
  const ref = (input.ref ?? '').trim();
  if (!Object.hasOwn(RESOLVERS, input.kind)) return { ok: false, why: 'is not a kind of proof the Dojo knows' };
  if (CANT_BE_DONE_ONLY.has(input.kind) && ctx.outcome !== 'cant_be_done') return { ok: false, why: "is only for a can't be done hand-in" };
  if (!ref) return { ok: false, why: 'names nothing' };
  const out = RESOLVERS[input.kind](ctx, ref, input);
  if (out === '') {
    return { ok: false, why: /\s/.test(ref)
      ? 'is free text, not a record: a status claim or a description is never proof'
      : `does not resolve to any ${input.kind} record` };
  }
  return typeof out === 'string' ? { ok: false, why: out } : { ok: true, item: { kind: input.kind, ref, label: PROOF_LABELS[input.kind], facts: out } };
}
