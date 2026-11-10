// Both halves of the labelled-engine rule live here: the label, and telling the agent what the Dojo sent.
// Call only AFTER the send, pass sent:false when it failed; best effort, never throws, never starts a turn.
// The label lives in leaf dojo-voice-label.ts: it imports nothing, so words-only modules can label text.

import { postAgentNotice } from './agent-notice.js';
import { getPrimaryAgentId } from '../config/platform.js';

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

// The Dojo posted the caption with the agent's files as its turn ended early; tell the agent exactly that.
export function tellAgentFilesPostedByDojo(agentId: string, files: ReadonlyArray<{ filename?: string }>, caption: string, why = 'because your turn ended early'): void {
  try {
    postAgentNotice({
      toAgentId: agentId, fromName: 'Dojo message sent', selfIntro: false,
      brief: `The Dojo itself (not you) posted this in the dashboard with your file(s) ${files.map((a) => a.filename ?? 'file').join(', ')}, ${why}: "${caption}". Do not claim it as your own words; say anything more in your own words.`,
    });
  } catch { /* awareness note is best-effort */ }
}
