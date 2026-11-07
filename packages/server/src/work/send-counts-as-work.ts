// ════════════════════════════════════════
// WHEN A SEND TO ANOTHER AGENT IS WORK ON A TASK'S RECORD (v3.5 field fix 3, the C4 loophole).
//
// The owner's ruling this enforces: the PM verifies so that a worker cannot close a job on its own
// say-so. C4 let a verified send to another agent count as work on the record, and that made the
// record satisfiable by telling the PM "I'm done". A send is work only when it DELIVERS THE WORK to
// the party the task serves. So, by the engine's own rows and never by the model's account:
//
//   * a send to the PM, to the task's validator (the PM, and any agent that has ruled on the task),
//     or to any service agent (`config/platform.ts` `isSystemServiceAgent`) is never work, UNLESS
//     the record shows that agent asked for this work (it is the task's requester, or it sent the
//     message the task exists for). When the PM asked a question, the answer belongs to the PM and
//     the PM judges it; a name in the title never makes the PM a requester, and a status claim to the
//     PM never counts (the next rule);
//   * a send whose intent does not deliver (only ANSWER, DELIVERABLE and COMPLETE do; FYI, STATUS,
//     QUESTION, ASSIGN, BLOCK and FAIL never) is never work;
//   * a send whose only content is a status claim about the task ("done", "task abc12345 is
//     complete, please validate") is never work;
//   * otherwise it is work only when every recipient is a party the task serves: its requester (the
//     agent that asked for it, or that sent the message it exists for), or an agent the task's own
//     title or goal names.
//
// Read by every reader that credits a send: the ledger charge (`work/ledger-store.ts`), the answer
// pointer (`tracker/delivery-evidence.ts`) and the names a PM read binds to (`tracker/looked-at.ts`).
// A leaf: the database and the platform config only.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { getPMAgentId, isSystemServiceAgent } from '../config/platform.js';

/** The A2A intents that hand the receiver the work itself. */
const DELIVERING_INTENTS = new Set(['ANSWER', 'DELIVERABLE', 'COMPLETE']);

/** Words a bare status claim is made of. Anything outside this set (and the task's own title and
 *  ids) is content, and the send is judged on its recipient instead. */
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

/** A message's leading engine tags ("[A2A:ANSWER thread:ffd47263 from:Main]"), never content. */
const stripTags = (text: string): string => text.replace(/^(?:\s*\[[^\]]*\])+/, '');

/** Is this text nothing but a status claim about the task (header)? Empty text is one too. */
export function isStatusClaimOnly(text: string, task: { id: string; title?: string | null } | null = null): boolean {
  const norm = (x: string): string => x.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9-]+/g, ' ').trim();
  // The task's own id (full, or any 8+ character prefix) names the task; it adds no content.
  let t = ` ${norm(stripTags(text)).replace(/\b[0-9a-f]{8}[0-9a-f-]*\b/g, ' ')} `;
  // So does its title, quoted whole ("Finished: <title>"). Words of the title used in a sentence are
  // content: "the export holds 412 rows" answers "how many rows the export holds".
  const title = norm(task?.title ?? '');
  if (title) t = t.split(` ${title} `).join(' ');
  // A number is content. Every other word must be a status word for the text to be only a claim.
  return (t.match(/[a-z0-9]+/g) ?? []).every((w) => !/[0-9]/.test(w) && STATUS_WORDS.has(w));
}

/** The A2A intent a stored line or delivery detail carries ("[A2A:ANSWER ...", "A2A ANSWER"). */
export function intentOf(text: string | null | undefined): string | null {
  const m = /^\s*\[?A2A[:\s]([A-Z]+)/.exec(text ?? '');
  return m ? m[1] : null;
}

/** An agent reference (id or name, as `send_to_agent` takes it) to the agent's id, or null. */
function agentIdOf(ref: string): string | null {
  const r = getDb().prepare('SELECT id FROM agents WHERE id = ? OR name = ? COLLATE NOCASE ORDER BY (id = ?) DESC LIMIT 1')
    .get(ref, ref, ref) as { id: string } | undefined;
  return r?.id ?? null;
}

/** The agents a send to which is never work on this task: the PM, the task's validator, every service agent. */
function neverWorkRecipient(taskId: string, agentId: string): boolean {
  if (agentId === getPMAgentId() || isSystemServiceAgent(agentId)) return true;
  // The task's validator: the PM rules on every task (`tracker/pm-agent.ts` runPMReview), and any agent
  // that has recorded a verdict on this one is its validator too.
  return !!getDb().prepare('SELECT 1 FROM adjudications WHERE work_id = ? AND by_agent = ? LIMIT 1').get(taskId, agentId);
}

/** The agents this task serves: its requester, the sender of the message it (or its project) exists
 *  for, and any agent its title or goal names. Never its own worker. */
export function servedAgentsOf(taskId: string): Set<string> {
  return servedSets(taskId).served;
}

/** The served set, and the subset the RECORD says asked for the work (requester rows and the sender
 *  of the source message, never a name in the title). */
function servedSets(taskId: string): { served: Set<string>; askedByRecord: Set<string> } {
  const db = getDb();
  const out = new Set<string>();
  const byRecord = new Set<string>();
  const w = db.prepare(
    `SELECT w.agent_id, w.assignee_agent, w.requester, w.requester_id, w.source_message_id, w.title, w.goal,
            p.requester AS p_requester, p.requester_id AS p_requester_id, p.source_message_id AS p_source_message_id
       FROM work w LEFT JOIN work p ON p.id = w.parent_id WHERE w.id = ?`,
  ).get(taskId) as {
    agent_id: string; assignee_agent: string | null; requester: string; requester_id: string | null;
    source_message_id: string | null; title: string | null; goal: string | null;
    p_requester: string | null; p_requester_id: string | null; p_source_message_id: string | null;
  } | undefined;
  if (!w) return { served: out, askedByRecord: byRecord };
  if (w.requester === 'agent' && w.requester_id) out.add(w.requester_id);
  if (w.p_requester === 'agent' && w.p_requester_id) out.add(w.p_requester_id);
  for (const m of [w.source_message_id, w.p_source_message_id]) {
    if (!m) continue;
    const ask = db.prepare(`SELECT requester_id FROM work WHERE id = ? AND kind = 'ask'`).get(`ask:${m}`) as { requester_id: string | null } | undefined;
    if (ask?.requester_id) out.add(ask.requester_id);
    const msg = db.prepare('SELECT source_agent_id FROM messages WHERE id = ?').get(m) as { source_agent_id: string | null } | undefined;
    if (msg?.source_agent_id) out.add(msg.source_agent_id);
  }
  for (const r of out) byRecord.add(r);
  // The recipient the task names: an agent named, as a whole word, in its title or goal.
  const named = `${w.title ?? ''}\n${w.goal ?? ''}`.toLowerCase();
  if (named.trim()) {
    for (const a of db.prepare('SELECT id, name FROM agents').all() as Array<{ id: string; name: string | null }>) {
      const nm = (a.name ?? '').trim().toLowerCase();
      const esc = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if ((nm.length >= 2 && new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(named)) || named.includes(a.id.toLowerCase())) out.add(a.id);
    }
  }
  // Ids, never names, from here: a requester recorded by name resolves to its agent.
  const ids = new Set<string>();
  for (const r of out) ids.add(agentIdOf(r) ?? r);
  ids.delete(w.agent_id);
  if (w.assignee_agent) ids.delete(w.assignee_agent);
  const asked = new Set<string>();
  for (const r of byRecord) { const id = agentIdOf(r) ?? r; if (ids.has(id)) asked.add(id); }
  return { served: ids, askedByRecord: asked };
}

/** Does this send to other agent(s) deliver the task's work to the party it serves (header)? */
export function agentSendCountsAsWork(
  taskId: string,
  send: { recipients: readonly string[]; intent: string | null; text: string | null },
): boolean {
  try {
    if (send.recipients.length === 0) return false;
    if (!send.intent || !DELIVERING_INTENTS.has(send.intent.toUpperCase())) return false;
    const task = getDb().prepare('SELECT id, title FROM work WHERE id = ?').get(taskId) as { id: string; title: string | null } | undefined;
    if (!task || isStatusClaimOnly(send.text ?? '', task)) return false;
    const { served, askedByRecord } = servedSets(taskId);
    return send.recipients.every((ref) => {
      const id = agentIdOf(ref);
      if (!id || !served.has(id)) return false;
      return !neverWorkRecipient(taskId, id) || askedByRecord.has(id);
    });
  } catch {
    return false;   // a send the record cannot place is never counted
  }
}

/** The agent send a delivery row is, or null when it is not one (a channel send to a person). */
export function agentSendOfDelivery(deliveryId: string): { recipients: string[]; intent: string | null; text: string | null } | null {
  const d = getDb().prepare(
    `SELECT d.channel, d.tool, d.recipient_id, d.detail, m.content FROM deliveries d LEFT JOIN messages m ON m.id = d.message_id WHERE d.id = ?`,
  ).get(deliveryId) as { channel: string | null; tool: string | null; recipient_id: string | null; detail: string | null; content: string | null } | undefined;
  if (!d || (d.channel !== 'a2a' && d.tool !== 'send_to_agent' && d.tool !== 'broadcast_to_group')) return null;
  return { recipients: d.recipient_id ? [d.recipient_id] : [], intent: intentOf(d.detail) ?? intentOf(d.content), text: d.content };
}

/** A message the worker sent to another agent that is NOT work on this task (header): the delivery
 *  that carried it, or the recipient's own inbound copy of it. False for anything that is not such a send. */
export function isNonWorkAgentSendMessage(taskId: string, worker: string, messageId: string): boolean {
  const db = getDb();
  const carried = db.prepare(
    `SELECT id FROM deliveries WHERE message_id = ? AND agent_id = ? AND outcome = 'delivered' AND (channel = 'a2a' OR tool IN ('send_to_agent', 'broadcast_to_group')) ORDER BY rowid DESC LIMIT 1`,
  ).get(messageId, worker) as { id: string } | undefined;
  if (carried) {
    const s = agentSendOfDelivery(carried.id);
    return !!s && !agentSendCountsAsWork(taskId, s);
  }
  const m = db.prepare('SELECT agent_id, source_agent_id, content FROM messages WHERE id = ?')
    .get(messageId) as { agent_id: string; source_agent_id: string | null; content: string | null } | undefined;
  if (m && m.source_agent_id === worker && m.agent_id !== worker) {
    return !agentSendCountsAsWork(taskId, { recipients: [m.agent_id], intent: intentOf(m.content), text: m.content });
  }
  return false;
}
