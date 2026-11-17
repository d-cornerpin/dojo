// Both halves of the labelled-engine rule live here: the label, and telling the agent what the Dojo sent.
// Call only AFTER the send, pass sent:false when it failed; best effort, never throws, never starts a turn.
// The label lives in leaf dojo-voice-label.ts: it imports nothing, so words-only modules can label text.

import { postAgentNotice } from './agent-notice.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { getDb } from '../db/connection.js';
import { NON_ANSWERING_DELIVERY_TOOLS } from '../work/ask-settlement.js';
import { TOLD, ownerConditionCleared, ownerToldOf, tellOwner } from '../healer/owner-notices.js';
import { renderInstant } from '../memory/message-stamp.js';

export { DOJO_VOICE_PREFIX, dojoVoice } from './dojo-voice-label.js';

export function tellAgentWhatDojoSent(opts: { agentId: string; recipient: string; text: string; why: string; sent?: boolean }): void {
  try {
    postAgentNotice({
      toAgentId: opts.agentId,
      fromName: 'Dojo message sent',
      brief: opts.sent === false
        ? `The Dojo itself (not you) tried to text ${opts.recipient} this, ${opts.why}, but the send FAILED and they did NOT get it: "${opts.text}". ` +
          `If they need to know, tell them in your own words.`
        : `The Dojo itself (not you) sent ${opts.recipient} this text, ${opts.why}: "${opts.text}". ` +
        `It was labelled as the Dojo. Do not repeat it or claim it as your own words; if the person needs more, follow up in your own words.`,
      intent: 'dojo_message_sent',
      selfIntro: false,
    });
  } catch { /* awareness note is best-effort */ }
}

export function tellAgentOwnerAlertSent(aboutAgentId: string | undefined, text: string, sent: boolean): boolean {
  const agentId = aboutAgentId ?? getPrimaryAgentId();
  if (agentId) tellAgentWhatDojoSent({ agentId, recipient: 'the owner (by iMessage)', text, sent, why: aboutAgentId ? 'because it was about you and you could not say it yourself' : 'as a platform notice' });
  return sent;
}

// Why a reply did not go, in plain words beside its label ("iMessage to Ann"): the sender's refusal, else the
// channel's own failure after its last try.
const PLAIN_WHY = {
  'not-approved': 'they are no longer on the approved list',
  'no-grant': 'this agent is not allowed to use that channel',
  'no-from-number': 'there is no number to send the text from',
  'agent-ended': 'the agent was ended',
  'imessage-off': 'iMessage is switched off in Settings',
  imessage: 'Messages could not send it',
  sms: 'the text service did not take it',
  email: 'the mail service refused it',
  teams: 'Teams refused it',
};
export type RefusalKind = keyof typeof PLAIN_WHY;
export const plainWhy = (refusal: RefusalKind | undefined, channel: string | undefined): string =>
  PLAIN_WHY[refusal ?? channel as RefusalKind] ?? 'the channel did not take it';

// A reply ended failed for good: the owner's one card per agent counts the failed replies since he last dismissed
// it, and the agent is told it did not arrive. A start line is not an answer and is not told.
export function tellOfUndeliveredReply(rowId: string, label: string, reason: string): void {
  const db = getDb();
  const row = db.prepare('SELECT agent_id, tool, channel, attempts FROM deliveries WHERE id = ?')
    .get(rowId) as { agent_id: string; tool: string; channel: string; attempts: number } | undefined;
  if (!row || NON_ANSWERING_DELIVERY_TOOLS.has(row.tool)) return;
  const key = `undelivered:${row.agent_id}`;
  if (!ownerToldOf(key)) ownerConditionCleared(key);   // dismissed or never raised: this failure starts a new count
  const since = (db.prepare('SELECT at_ms FROM healer_state WHERE scope = ? AND key = ?').get(TOLD, key) as { at_ms: number } | undefined)?.at_ms ?? Date.now();
  // The row that raised the card ended just before it was told, so the count reaches back one second.
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = ? AND outcome = 'failed' AND payload_json IS NOT NULL
    AND tool NOT IN (${[...NON_ANSWERING_DELIVERY_TOOLS].map(() => '?').join(', ')}) AND (id = ? OR updated_at >= datetime(? / 1000 - 1, 'unixepoch'))`)
    .get(row.agent_id, ...NON_ANSWERING_DELIVERY_TOOLS, rowId, since) as { n: number };
  tellOwner(key, `${n} ${n === 1 ? 'reply' : 'replies'} could not be delivered since ${renderInstant(since)}. `
    + `Latest: ${label} (${reason}). ${n === 1 ? 'It is' : 'They are'} in the chat.`);
  postAgentNotice({
    toAgentId: row.agent_id, fromName: 'Dojo delivery', selfIntro: false,
    brief: `Your reply (${label}) did NOT reach them after ${row.attempts} ${row.attempts === 1 ? 'try' : 'tries'}: ${reason}. It will not be sent later. `
      + 'Do not say it arrived; if they must hear it, reach them another way in your own words.',
  });
}

// The Dojo posted the caption with the agent's files as its turn ended early; tell the agent exactly that.
export function tellAgentFilesPostedByDojo(agentId: string, files: ReadonlyArray<{ filename?: string }>, caption: string, why = 'because your turn ended early'): void {
  try {
    postAgentNotice({
      toAgentId: agentId, fromName: 'Dojo message sent', selfIntro: false,
      brief: `The Dojo itself (not you) posted this in the dashboard with your file(s) ${files.map((a) => a.filename ?? 'file').join(', ')}, ${why}: "${caption}". Do not claim it as your own words; say anything more in your own words.`,
    });
  } catch { /* awareness note is best-effort */ }
}
