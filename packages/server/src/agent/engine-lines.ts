// Every owner-facing engine line goes through `dojoVoice`, so it reads as the engine speaking
// and not the agent. They live here so one test holds them all; senders also tell the agent.

import { dojoVoice } from './dojo-voice-label.js';

export function healerApprovalText(shortId: string): string {
  return dojoVoice(
    'The self-healing helper needs your OK before it makes a change on this Mac that could delete or '
    + 'overwrite something. Nothing has changed yet.\n\n'
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
