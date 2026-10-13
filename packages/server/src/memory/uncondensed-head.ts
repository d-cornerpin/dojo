// ════════════════════════════════════════════════════════════════════════════════════════
// t140 rounds 3–4 — THE NOT-YET-CONDENSED NOTE ITSELF: its head, its text, and the rule that a real
// summary always wins over it.
//
// A leaf module (the DB, the message store, the estimator — nothing from the compactor), so the
// condenser can recognise a note and the leaf fold can supersede one without importing the
// placeholder machinery in `uncondensed-placeholder.ts`.
//
//   · THE HEAD marks a placeholder row. Condensation never merges one: it would bury the note where
//     its replacement cannot find it.
//   · THE TEXT is built from stored columns only — a count, a fixed channel/lane word, a UTC range —
//     so nothing a sender wrote or was called reaches it.
//   · ONE NOTE PER ROW (round 4, re-review 3 F1). Whenever a REAL leaf summary is written over rows
//     a placeholder covers, those rows leave the placeholder (it is rewritten for the rows it still
//     covers, or deleted when none are left). The other direction is the placeholder writer's: it
//     only ever covers rows nothing covers.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { getMessagesByIds } from './store.js';
import { estimateTokens } from './budget.js';
import type { Message } from '@dojo/shared';

export const UNCONDENSED_PLACEHOLDER_HEAD = '[Not yet condensed]';
export const isUncondensedPlaceholder = (content: string): boolean => content.startsWith(UNCONDENSED_PLACEHOLDER_HEAD);

/** The ONLY words a note uses to say where its messages came from. Own-property lookups only. */
const CHANNEL_WORDS: Readonly<Record<string, string>> = {
  dashboard: 'the dashboard conversation', voice: 'a voice conversation', phone: 'a phone call',
  imessage: 'an iMessage conversation', sms: 'a text-message conversation', email: 'an email conversation',
  telegram: 'a Telegram conversation', slack: 'a Slack conversation', a2a: 'an agent thread',
};
const LANE_WORDS: Readonly<Record<string, string>> = {
  owner: "the owner's conversation", a2a: 'an agent thread', events: 'engine notices',
};
const wordFor = (table: Readonly<Record<string, string>>, key: string | null | undefined): string | undefined =>
  key && Object.hasOwn(table, key) ? table[key] : undefined;

function whereFrom(rows: readonly Message[]): string {
  const channelOf = getDb().prepare('SELECT channel FROM conversations WHERE id = ?');
  const words = new Set<string>();
  for (const m of rows) {
    const conv = (m as { conversationId?: string | null }).conversationId;
    const channel = conv ? (channelOf.get(conv) as { channel?: string } | undefined)?.channel : undefined;
    words.add(wordFor(CHANNEL_WORDS, channel) ?? wordFor(LANE_WORDS, (m as { lane?: string | null }).lane) ?? "this agent's own work");
  }
  const list = [...words];
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.length} conversations`;
}

function stamp(at: unknown): string {
  const d = new Date(typeof at === 'number' ? at : String(at));
  return Number.isNaN(d.getTime()) ? 'an unrecorded time' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The note, from stored columns only. */
export function placeholderText(rows: readonly Message[]): string {
  const n = rows.length;
  const first = stamp(rows[0]?.createdAt);
  const last = stamp(rows[n - 1]?.createdAt);
  return `${UNCONDENSED_PLACEHOLDER_HEAD} ${n} message${n === 1 ? '' : 's'} from ${whereFrom(rows)}, `
    + `${first}${last !== first ? ` – ${last}` : ''}, not yet condensed — the originals are kept and searchable.`;
}

/**
 * A REAL leaf summary now covers `messageIds`: take those rows out of every placeholder of this
 * agent. A placeholder left with rows is rewritten for exactly them; one left with none is deleted.
 * Synchronous; the caller rebuilds the context items as it already does after a leaf write.
 */
export function supersedeUncondensedPlaceholders(agentId: string, messageIds: readonly string[]): number {
  if (messageIds.length === 0) return 0;
  const db = getDb();
  const ids = [...messageIds];
  const marks = ids.map(() => '?').join(',');
  const notes = (db.prepare(
    `SELECT DISTINCT sm.summary_id AS id FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id
      WHERE s.agent_id = ? AND substr(s.content, 1, length(?)) = ? AND sm.message_id IN (${marks})`,
  ).all(agentId, UNCONDENSED_PLACEHOLDER_HEAD, UNCONDENSED_PLACEHOLDER_HEAD, ...ids) as Array<{ id: string }>).map((r) => r.id);
  for (const id of notes) {
    db.transaction(() => {
      db.prepare(`DELETE FROM summary_messages WHERE summary_id = ? AND message_id IN (${marks})`).run(id, ...ids);
      const left = (db.prepare('SELECT message_id AS m FROM summary_messages WHERE summary_id = ?').all(id) as Array<{ m: string }>).map((r) => r.m);
      if (left.length === 0) {
        db.prepare('DELETE FROM summary_parents WHERE summary_id = ? OR parent_id = ?').run(id, id);
        db.prepare('DELETE FROM context_items WHERE item_id = ?').run(id);
        db.prepare('DELETE FROM summaries WHERE id = ?').run(id);
        return;
      }
      const rows = getMessagesByIds(left);
      const text = placeholderText(rows);
      db.prepare('UPDATE summaries SET content = ?, token_count = ?, earliest_at = ?, latest_at = ?, descendant_count = ? WHERE id = ?')
        .run(text, estimateTokens(text), rows[0]?.createdAt ?? '', rows[rows.length - 1]?.createdAt ?? '', rows.length, id);
    })();
  }
  return notes.length;
}
