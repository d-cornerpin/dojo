// ════════════════════════════════════════════════════════════════════════════
// ENGINE LINES THAT REACH THE OWNER (v3.5 field fix 3, audit round #6).
//
// OR-ENGINE-LABELLED, the owner (2026-10-31, verbatim): "it should probably be clear it is the dojo
// engine speaking and not the agent AND the agent should be made aware of any messages the engine
// sends." Each of these was written in the first person ("so I change", "I switched them", "I can't
// reach", "so I let it go/expire") or unlabelled. Their words live here, each through `dojoVoice`,
// so a test can hold all of them; the sites that send them also tell the agent (`tellAgentWhatDojoSent`).
// ════════════════════════════════════════════════════════════════════════════

import { dojoVoice } from './dojo-voice-label.js';

/** The Healer's approval request, texted to the owner. */
export function healerApprovalText(shortId: string): string {
  return dojoVoice(
    'The self-healing helper needs your OK before it makes a change on this Mac that could delete or '
    + 'overwrite something. Nothing has changed yet.\n\n'
    + `Reply "yes ${shortId}" to approve or "no ${shortId}" to decline. The code in the reply tells the Dojo which change it is.`,
  );
}

/** The dashboard card when an agent's model no longer existed and the Dojo set it to auto-routing. */
export function orphanedModelRepairText(agentName: string): string {
  return dojoVoice(`${agentName} was set to a model that no longer exists, so the Dojo switched it to auto-routing and it keeps working. A specific model can be picked on the agent's page.`);
}

/** The dashboard card when the Plaud login expired. */
export function plaudExpiredText(): string {
  return dojoVoice('The Plaud login has expired, so the recordings cannot be read until it is reconnected in Settings → Integrations → Plaud.');
}

/** Vitals note: a quietly queued consent (a held destructive call) the owner never decided. */
export const HELD_CONSENT_EXPIRY_NOTE_TEXT = dojoVoice('This request sat for two weeks without a decision, so the Dojo let it go. Nothing was changed or deleted.');

/** Vitals note: an urgent approval nobody answered. */
export const URGENT_APPROVAL_EXPIRY_NOTE = dojoVoice('This urgent approval went unanswered for over an hour, so the Dojo let it expire. Nothing was changed or deleted.');
