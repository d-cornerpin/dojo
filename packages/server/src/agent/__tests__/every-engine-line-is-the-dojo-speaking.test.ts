// v3.5 field fix 3, audit round (#6). OR-ENGINE-LABELLED, the owner (2026-10-31, verbatim): "it should
// probably be clear it is the dojo engine speaking and not the agent AND the agent should be made aware
// of any messages the engine sends." These engine lines spoke in the first person ("so I change",
// "I switched them", "I can't reach", "so I let it go/expire") or unlabelled, and the agent was not
// told. Each is now labelled "Dojo:", never "I", and the agent is told what was sent.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const told: Array<{ agentId: string; recipient: string; text: string }> = [];
vi.mock('../dojo-voice.js', async (orig) => ({
  ...(await orig<typeof import('../dojo-voice.js')>()),
  tellAgentWhatDojoSent: (o: { agentId: string; recipient: string; text: string }) => { told.push(o); },
}));

import {
  healerApprovalText, orphanedModelRepairText, plaudExpiredText, HELD_CONSENT_EXPIRY_NOTE_TEXT, URGENT_APPROVAL_EXPIRY_NOTE,
} from '../engine-lines.js';

const FIRST_PERSON = /\b(I|I'm|I've|I'll|me|my)\b|\bI can't\b/;

beforeEach(() => { told.length = 0; });

describe('every engine line is the Dojo speaking', () => {
  it('the Healer approval iMessage is labelled and never "I"', () => {
    const t = healerApprovalText('ab12cd34', 'Delete the folder /tmp/old and everything inside.');
    expect(t.startsWith('Dojo:')).toBe(true);
    expect(t).not.toMatch(FIRST_PERSON);
    expect(t).toContain('yes ab12cd34');
  });

  it('the orphaned-model repair card is labelled and never "I"', () => {
    const t = orphanedModelRepairText('Helper');
    expect(t.startsWith('Dojo:')).toBe(true);
    expect(t).not.toMatch(FIRST_PERSON);
  });

  it('the Plaud card is labelled and never "I"', () => {
    const t = plaudExpiredText();
    expect(t.startsWith('Dojo:')).toBe(true);
    expect(t).not.toMatch(FIRST_PERSON);
  });

  it('the two Vitals expiry notes are labelled and never "I"', () => {
    for (const t of [HELD_CONSENT_EXPIRY_NOTE_TEXT, URGENT_APPROVAL_EXPIRY_NOTE]) {
      expect(t.startsWith('Dojo:'), t).toBe(true);
      expect(t, t).not.toMatch(FIRST_PERSON);
    }
  });
});
