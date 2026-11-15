// Every owner-facing engine line goes through `dojoVoice`, so it reads as the engine speaking
// and not the agent. They live here so one test holds them all; senders also tell the agent.

import { dojoVoice } from './dojo-voice-label.js';

/** The card and the text share this body: what the paused change would do, and that declining is safe. */
export function healerApprovalBody(what: string): string {
  return `The self-healing helper paused before a change on this Mac that could delete or overwrite something. It would: ${what} `
    + 'Nothing has changed yet. If this is not something you asked for, or you are not sure, it is safe to decline: everything stays exactly as it is.';
}

export function healerApprovalText(shortId: string, what: string): string {
  return dojoVoice(
    `${healerApprovalBody(what)}\n\n`
    + `Reply "yes ${shortId}" to approve or "no ${shortId}" to decline. The code in the reply tells the Dojo which change it is.`,
  );
}

export function orphanedModelRepairText(agentName: string): string {
  return dojoVoice(`${agentName} was set to a model that no longer exists, so the Dojo switched it to auto-routing and it keeps working. A specific model can be picked on the agent's page.`);
}

export function plaudExpiredText(): string {
  return dojoVoice('The Plaud login has expired, so the recordings cannot be read until it is reconnected in Settings → Integrations → Plaud.');
}

export const HELD_CONSENT_EXPIRY_NOTE_TEXT = dojoVoice('This request sat for two weeks without a decision, so the Dojo let it go. Nothing was changed or deleted.');

export const URGENT_APPROVAL_EXPIRY_NOTE = dojoVoice('This urgent approval went unanswered for over an hour, so the Dojo let it expire. Nothing was changed or deleted.');
