// OR-ENGINE-LABELLED (owner, 2026-10-31): where the agent cannot act, the engine may still message a person,
// but it must plainly be the Dojo speaking (never "I", never the agent's voice), and the agent must always be
// told exactly what was sent. This module is the one place both halves live.

import { postAgentNotice } from './agent-notice.js';

/** The label every engine-spoken message to a person starts with. */
export const DOJO_VOICE_PREFIX = 'Dojo:';

/** The text as the Dojo speaking: starts with "Dojo:" (added once, never doubled). */
export function dojoVoice(text: string): string {
  const t = text.trim();
  return t.startsWith(DOJO_VOICE_PREFIX) ? t : `${DOJO_VOICE_PREFIX} ${t}`;
}

/**
 * Tell an agent, on its next turn, what the Dojo sent on its behalf: the exact text and the recipient. Call it only AFTER the send; pass `sent: false` when it failed.
 * Best effort; never throws. A rider: it never starts a turn of its own.
 * @param why one short plain phrase for why the engine spoke instead of the agent
 */
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

/** The Dojo posted `caption` with the agent's file(s) because the agent's turn ended early; tell the agent exactly that. */
export function tellAgentFilesPostedByDojo(agentId: string, files: ReadonlyArray<{ filename?: string }>, caption: string): void {
  try {
    postAgentNotice({
      toAgentId: agentId, fromName: 'Dojo message sent', selfIntro: false,
      brief: `The Dojo itself (not you) posted this in the dashboard with your file(s) ${files.map((a) => a.filename ?? 'file').join(', ')}, because your turn ended early: "${caption}". Do not claim it as your own words; say anything more in your own words.`,
    });
  } catch { /* awareness note is best-effort */ }
}
