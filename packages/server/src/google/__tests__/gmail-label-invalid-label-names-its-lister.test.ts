// ════════════════════════════════════════════════════════════════════════════
// T80 FIX-WAVE ITEM 4 (live-test finding) — AN INVALID LABEL VALUE GETS A DOOR,
// NOT A DEAD END.
//
// A live agent, mid-run on this very branch's tool-NAME fixes, found
// `user_gmail_label` unaided — the name fix worked. It then tried to move a
// message to spam, guessed the Outlook-ism "Junk E-mail" as the label value,
// and the Gmail API 400'd. The executor handed back the bare provider text:
//
//     Error modifying labels: Invalid label: Junk E-mail
//
// No remedy. Same decision-moment principle as the tool-name fixes on this
// branch, one layer down at label VALUES instead of tool NAMES: the failure
// text is the one place the agent is guaranteed to be looking, and it said
// nothing about what a real label looks like on this account or how to find
// one.
//
// R5 NOTE (owner-required, recorded per fix-wave instructions): `tools/name-
// help.ts`'s R5 ("generic across every tool, no family branches") governs the
// GENERIC tool-name-failure machinery — it does not forbid a domain-specific
// executor (this file) from writing domain-specific remedial text for a
// domain-specific value failure. Gmail labels are a Gmail concept; the fix
// belongs in the Gmail write executor, not in a generic leaf.
//
// FIX: on an "Invalid label" failure from the Gmail API, the door text now
// (a) states the label does not exist on THIS account, (b) names the lister
// tool with the SAME prefix as the tool that was actually called — derived
// from `name`, never hardcoded, so a `user_gmail_label` failure points at
// `user_gmail_list_labels` and an unprefixed call points at
// `gmail_list_labels` — (c) gives the two standard idioms (archive =
// remove_labels: ["INBOX"]; junk/spam = the system label "SPAM"), and (d)
// names the same-prefix `gmail_create_label` for a genuinely new custom
// label.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  googleRead: vi.fn(),
  googleWrite: vi.fn(),
}));

vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForTool: vi.fn(() => ({
    account: {
      id: 'agent', kind: 'agent', position: 1, email: 'agent@example.com',
      enabled: true, connected: true, accessToken: null, refreshToken: null,
      tokenExpiresAt: null, grantedScopes: null, enabledServices: null,
      watchEmail: false, sendEmail: true, lastVerifiedAt: null,
    },
  })),
}));

import { googleWrite } from '../client.js';
import { executeGoogleWriteTool } from '../tools-write.js';

function mockInvalidLabelFailure(labelName: string): void {
  vi.mocked(googleWrite).mockResolvedValue({
    ok: false,
    data: null,
    error: `Invalid label: ${labelName}`,
    apiEndpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify',
  });
}

beforeEach(() => {
  vi.mocked(googleWrite).mockReset();
});

describe('gmail_label — an invalid label VALUE gets a door, not a dead end (RED-first: the mocked failure reproduces the live incident)', () => {
  it('THE INCIDENT, reproduced: the bare provider text alone is what the live agent actually saw', async () => {
    mockInvalidLabelFailure('Junk E-mail');
    const out = await executeGoogleWriteTool('gmail_label', { message_id: 'm1', add_labels: ['Junk E-mail'] }, 'agent-1', 'Agent One');
    // The bare fact is still present — the fix must not hide the underlying error.
    expect(out).toContain('Invalid label: Junk E-mail');
  });

  it('(a) says the label does not exist on THIS account', async () => {
    mockInvalidLabelFailure('Junk E-mail');
    const out = await executeGoogleWriteTool('gmail_label', { message_id: 'm1', add_labels: ['Junk E-mail'] }, 'agent-1', 'Agent One');
    expect(out).toMatch(/does not exist on this (gmail )?account/i);
  });

  it('(b) unprefixed gmail_label points at the unprefixed lister, gmail_list_labels', async () => {
    mockInvalidLabelFailure('Junk E-mail');
    const out = await executeGoogleWriteTool('gmail_label', { message_id: 'm1', add_labels: ['Junk E-mail'] }, 'agent-1', 'Agent One');
    expect(out).toContain('gmail_list_labels');
    expect(out).not.toContain('user_gmail_list_labels');
  });

  it('(b) user_gmail_label points at the SAME-PREFIX lister, user_gmail_list_labels — derived from the call, not hardcoded', async () => {
    mockInvalidLabelFailure('Junk E-mail');
    const out = await executeGoogleWriteTool('user_gmail_label', { message_id: 'm1', add_labels: ['Junk E-mail'] }, 'agent-1', 'Agent One');
    expect(out).toContain('user_gmail_list_labels');
  });

  it('(c) names both standard idioms: archive via remove_labels ["INBOX"], and the system SPAM label for junk', async () => {
    mockInvalidLabelFailure('Junk E-mail');
    const out = await executeGoogleWriteTool('gmail_label', { message_id: 'm1', add_labels: ['Junk E-mail'] }, 'agent-1', 'Agent One');
    expect(out).toMatch(/remove_labels.*\["?INBOX"?\]/);
    expect(out).toContain('SPAM');
  });

  it('(d) names the same-prefix gmail_create_label for a genuinely new custom label', async () => {
    mockInvalidLabelFailure('Project Phoenix');
    const out = await executeGoogleWriteTool('gmail_label', { message_id: 'm1', add_labels: ['Project Phoenix'] }, 'agent-1', 'Agent One');
    expect(out).toContain('gmail_create_label');
  });

  it('(d) the user_ variant is told about the same-prefix creator, user_gmail_create_label', async () => {
    mockInvalidLabelFailure('Project Phoenix');
    const out = await executeGoogleWriteTool('user_gmail_label', { message_id: 'm1', add_labels: ['Project Phoenix'] }, 'agent-1', 'Agent One');
    expect(out).toContain('user_gmail_create_label');
    expect(out).not.toMatch(/[^_]gmail_create_label/); // never the bare/wrong-prefix form
  });

  it('CONTROL: a non-label-related Google API failure is untouched — no lister/idiom text injected', async () => {
    vi.mocked(googleWrite).mockResolvedValue({
      ok: false, data: null, error: 'Requested entity was not found.',
      apiEndpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify',
    });
    const out = await executeGoogleWriteTool('gmail_label', { message_id: 'm1', add_labels: ['STARRED'] }, 'agent-1', 'Agent One');
    expect(out).toBe('Error modifying labels: Requested entity was not found.');
    expect(out).not.toContain('gmail_list_labels');
  });

  it('CONTROL: a successful modify is untouched', async () => {
    vi.mocked(googleWrite).mockResolvedValue({
      ok: true, data: {}, apiEndpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify',
    });
    const out = await executeGoogleWriteTool('gmail_label', { message_id: 'm1', add_labels: ['STARRED'] }, 'agent-1', 'Agent One');
    expect(out).toBe('Labels updated on message m1');
  });
});
