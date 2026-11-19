// THE HAND-BACK FACTS: what a dead turn left behind, recorded on the ask as one `audit` event per hand-back.
// They render at serve time into a steer on the turn serving it (`agent/v2/steps/assemble/hand-back-steer.ts`),
// ordered: what already happened (a send the run died inside included), the message and its age, then the
// instruction. Never an events-lane notice: that lane gists rows to 400 chars (`memory/lanes.ts`) and is in
// view on every human turn.
import { getDb } from '../db/connection.js';
import { appendWorkEvent } from './store.js';
import { formatTimeForAgent } from '../services/format-time.js';
import { isEffectfulTool } from '../agent/v2/steps/execute/effectful-call.js';
import { outboundChannelForTool } from '../agent/v2/outbound.js';
import { redactDeclaredSecretArgs } from '../credentials/secret-fields.js';

/** The `audit` marker one hand-back writes on the ask it hands back. */
export const HAND_BACK_MARKER = 'orphan_hand_back';

/** "3 days", "2 hours", "5 minutes", "40 seconds": the age as a person would say it. */
export function ageInWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const [n, unit] = s >= 86_400 ? [Math.floor(s / 86_400), 'day'] : s >= 3_600 ? [Math.floor(s / 3_600), 'hour']
    : s >= 60 ? [Math.floor(s / 60), 'minute'] : [s, 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** One effectful call the dead turn made, read back from its own stored tool rows. */
interface DeadTurnEffect { name: string; input: unknown; finished: boolean }

/** What the dead turn already DID, from its stored tool rows (same rule as `turns.effectful_calls`); a call with no
 *  result is the one the process died inside, so it may or may not have happened. */
function effectsOf(agentId: string, turnNumber: number | null): DeadTurnEffect[] {
  if (turnNumber == null) return [];
  const rows = getDb().prepare(
    `SELECT role, content FROM messages
      WHERE agent_id = ? AND turn_number = ? AND role IN ('assistant', 'tool') AND content LIKE '[%'
      ORDER BY seq`,
  ).all(agentId, turnNumber) as Array<{ role: string; content: string }>;
  const calls: Array<{ id: string; name: string; input: unknown }> = [];
  const results = new Map<string, boolean>();          // tool_use_id -> is_error
  for (const r of rows) {
    let blocks: unknown;
    try { blocks = JSON.parse(r.content); } catch { continue; }
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        calls.push({ id: b.id, name: b.name, input: b.input });
      } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        results.set(b.tool_use_id, b.is_error === true);
      }
    }
  }
  return calls
    .filter((c) => isEffectfulTool(c.name) && results.get(c.id) !== true)
    .map((c) => ({ name: c.name, input: c.input, finished: results.has(c.id) }));
}

function describeEffect(e: DeadTurnEffect): string {
  const args = e.input && typeof e.input === 'object'
    ? redactDeclaredSecretArgs(e.name, e.input as Record<string, unknown>) : e.input;
  const shown = JSON.stringify(args ?? {}).slice(0, 200);
  if (e.finished) return `${e.name} ${shown}`;
  // A send leaves no row until it ends, so nothing says whether it went: answering twice is the lesser harm.
  // A second phone call is worse than a second text, so an unfinished call is checked, never redialed blindly.
  const unknown = e.name === 'voice_call' ? 'the call may not have been placed. Check before calling again.'
    : outboundChannelForTool(e.name) !== null ? 'it may not have gone. If you cannot tell, send it again; a duplicate is the lesser harm.'
    : 'the run stopped inside it, so it may or may not have happened: check';
  return `${e.name} ${shown} (no result was recorded: ${unknown})`;
}

/** What one hand-back records: read from the ledger at the moment the turn is judged dead. */
interface HandBackRecord {
  marker: typeof HAND_BACK_MARKER; turn: number | null; by: string;
  effects: string[]; unnamedEffectful: number;
}

/** Record, on the ask itself, what its dead turn left behind. */
export function recordHandBack(o: { id: string; agent_id: string; turn_number: number | null; effectful_calls: number }, by: string): void {
  const effects = effectsOf(o.agent_id, o.turn_number);
  const rec: HandBackRecord = {
    marker: HAND_BACK_MARKER, turn: o.turn_number, by,
    effects: effects.map(describeEffect),
    // The count is the durable fact: a model whose calls left no structured rows (text-only tool fallback,
    // an aliased name) still made them, and the agent must hear that much.
    unnamedEffectful: Math.max(0, o.effectful_calls - effects.filter((e) => e.finished).length),
  };
  appendWorkEvent(o.id, 'audit', 'orphaned-claims', rec);
}

/** The facts for the turn serving `workId`, or null if it was never handed back; rendered now so the age is current.
 *  Every hand-back is listed, so a repeating death shows as a pattern. */
export function handBackFactsFor(workId: string): string | null {
  const db = getDb();
  const recs = (db.prepare(
    `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit'
       AND json_extract(payload, '$.marker') = ? ORDER BY id`,
  ).all(workId, HAND_BACK_MARKER) as Array<{ payload: string }>).map((r) => JSON.parse(r.payload) as HandBackRecord);
  if (recs.length === 0) return null;
  const msg = db.prepare(
    `SELECT m.content AS content, m.created_at AS received_at FROM work w
       LEFT JOIN messages m ON m.id = w.root_id AND m.agent_id = w.agent_id WHERE w.id = ?`,
  ).get(workId) as { content: string | null; received_at: number | null } | undefined;
  const last = recs[recs.length - 1];
  const parts: string[] = [
    `THIS MESSAGE WAS HANDED BACK TO YOU. Your turn ${last.turn ?? '(unrecorded)'} was serving it and stopped before it `
    + 'answered (the Dojo restarted or that run stopped responding).',
  ];
  if (recs.length > 1) {
    const before = recs.slice(0, -1).map((r) => r.turn ?? '?');
    parts.push(`It was handed back before, ${before.length} time(s): the run serving it on turn${before.length === 1 ? '' : 's'} `
      + `${before.join(', ')} stopped the same way, and the run stopped again. `
      + 'If something in the message itself stops the run, do the part you can and say plainly what you could not do.');
  }
  // What already happened comes first.
  const effects = recs.flatMap((r) => r.effects);
  if (effects.length > 0) {
    parts.push(`What that turn did, on the record: ${effects.map((e, i) => `(${i + 1}) ${e}`).join('; ')}. `
      + 'Do not repeat what finished: finish only what is left, and tell the person what was already done.');
  }
  const unnamed = recs.reduce((n, r) => n + r.unnamedEffectful, 0);
  if (unnamed > 0) {
    parts.push(`${unnamed} action${unnamed === 1 ? ' was' : 's were'} taken that could not be identified, so check what was done before acting.`);
  }
  const snippet = (msg?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const when = msg?.received_at != null
    ? `received ${formatTimeForAgent(msg.received_at)} (${ageInWords(Date.now() - msg.received_at)} ago)`
    : 'received at a time that was not recorded';
  parts.push(`The message: "${snippet}", ${when}.`);
  parts.push('Answer it now. If it is old, judge whether it still matters and say what has changed rather than acting on it blindly.');
  return parts.join('\n');
}
