// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR / T77b — THE WRITE GRANT SAYS WHAT IT BUYS, AND WHAT IT DOES NOT (RED-first).
//
// "Read & write" on a mail account is the widest word on that control, and an owner who
// picks it reasonably reads it as "it can send mail now". It cannot. Sending is a HUMAN
// CHANNEL, governed by "Can talk to people" → Email, and a write grant with that switch off
// buys reading, filing, labelling — and, since this task, DRAFTING: `gmail_draft` /
// `outlook_draft` put a finished message in the Drafts folder and send nothing. The panel
// said none of that, so the grant looked broken.
//
// THIS IS THE A3 TREATMENT POINTED THE OTHER WAY. `inertChannels` warns at the grant that
// looks set and does nothing (a channel), naming the fix somewhere else (a tool group). Same
// shape here: the warning sits at the WRITE LEVEL, in "What it can reach", and names the
// channel switch below it. It is deliberately NOT in "Who it can talk to" — an owner who
// never opens that row is exactly the owner who needs the sentence.
//
// ── THE THREE PROPERTIES, each a case below ──
//  1. It fires on a WRITE grant only. Read is not a promise to send and gets no warning.
//  2. It distinguishes the TWO ways the path is shut, because the fix differs: the master is
//     off (turn it on, then pick Email) versus Email alone is off (turn Email on).
//  3. A HELPER AGENT IS NEVER WARNED. `master === null` means this agent has no switch of its
//     own — it talks through the main agent — so there is nothing on screen to point at, and
//     the panel already says so in its own words.
//
// A CORRECTION TO THE BRIEF, recorded so it is not re-derived: the task named the master
// "Allowed to talk to humans". That was its A5 label; A6's language pass renamed it to
// "Can talk to people" (`AccessPanel.tsx:309`, pinned by `the-access-panel.test.ts:383`).
// The warning uses the words ON SCREEN — a sentence that points at a control by a name the
// control does not carry is worse than no sentence.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACCESS_CHANNELS, MOST_RESTRICTIVE_GRANTS, cloneGrants } from '@dojo/shared';
import type { AccessGrants } from '@dojo/shared';
import { mailWriteWithoutSend } from '../../../../../dashboard/src/lib/access-edits.js';

const DASH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'dashboard', 'src',
);
const readDash = (rel: string): string => fs.readFileSync(path.join(DASH, rel), 'utf8');

/** A grant with the mail channel fully open and nothing granted on the account side. */
const base = (): AccessGrants => {
  const g = cloneGrants(MOST_RESTRICTIVE_GRANTS);
  g.channels.master = true;
  for (const c of ACCESS_CHANNELS) g.channels[c] = 'owner';
  return g;
};

describe('T77b — a write grant with no send channel says drafts still work', () => {
  it('⚠ THE ACCEPTANCE CASE — account write, human channels off: it warns, and names the master', () => {
    const g = base();
    g.integrations.google.user = 'full';
    g.channels.master = false;

    expect(mailWriteWithoutSend(g)).toEqual([{ provider: 'google', missing: 'master' }]);
  });

  it('the master on but Email off is a DIFFERENT sentence, because it is a different fix', () => {
    const g = base();
    g.integrations.microsoft.agent = 'full';
    g.channels.email = 'none';

    expect(mailWriteWithoutSend(g)).toEqual([{ provider: 'microsoft', missing: 'email' }]);
  });

  it('both providers granted write warn independently, in panel order', () => {
    const g = base();
    g.integrations.google.agent = 'full';
    g.integrations.microsoft.user = 'full';
    g.channels.master = false;

    expect(mailWriteWithoutSend(g).map((w) => w.provider)).toEqual(['google', 'microsoft']);
  });

  it('a per-account override to write is a write grant, however the kind level reads', () => {
    const g = base();
    g.integrations.google.accounts = { 'acct-1': 'full' };
    g.channels.master = false;

    expect(mailWriteWithoutSend(g)).toEqual([{ provider: 'google', missing: 'master' }]);
  });

  // ── CONTROLS ──

  it('CONTROL — READ is not a promise to send, and is never warned about', () => {
    const g = base();
    g.integrations.google.user = 'read';
    g.integrations.microsoft.agent = 'read';
    g.channels.master = false;

    expect(mailWriteWithoutSend(g)).toEqual([]);
  });

  it('CONTROL — write WITH the channel open is the working case, and stays silent', () => {
    const g = base();
    g.integrations.google.user = 'full';
    g.integrations.microsoft.agent = 'full';

    expect(mailWriteWithoutSend(g)).toEqual([]);
  });

  it('CONTROL — a helper agent has no switch of its own, so it is never warned', () => {
    const g = base();
    g.integrations.google.user = 'full';
    g.channels.master = null;
    g.channels.email = 'none';

    expect(mailWriteWithoutSend(g)).toEqual([]);
  });

  it('CONTROL — no integration granted at all warns about nothing', () => {
    const g = base();
    g.channels.master = false;

    expect(mailWriteWithoutSend(g)).toEqual([]);
  });

  it('CONTROL — `inertChannels` is untouched by this: it still answers only about channels', async () => {
    const { inertChannels } = await import('../../../../../dashboard/src/lib/access-edits.js');
    const g = base();
    g.integrations.google.user = 'full';
    expect(inertChannels(g, { email: ['Gmail'] })).toEqual([{ channel: 'email', groups: ['Gmail'] }]);
  });
});

describe('T77b — and the panel renders it where the grant is', () => {
  const panel = (): string => readDash('components/AccessPanel.tsx');

  it('⚠ the warning is in "What it can reach", beside the account rows', () => {
    const src = panel();
    expect(src).toContain('mailWriteWithoutSend');

    // Row 2 opens at `question="What it can reach"` and Row 3 at `question="Who it can talk to"`.
    const reach = src.indexOf('question="What it can reach"');
    const talk = src.indexOf('question="Who it can talk to"');
    const warn = src.indexOf('mailWriteWithoutSend(draft)');
    expect(reach).toBeGreaterThan(-1);
    expect(warn).toBeGreaterThan(reach);
    expect(warn).toBeLessThan(talk);
  });

  it('⚠ it uses the ESTABLISHED warning treatment, not a new one', () => {
    const src = panel();
    // `note--warn` is the one warning class on this card (A3's iMessage/Communication
    // pattern and the helper-agent note both use it); this must not invent a second.
    const classes = [...src.matchAll(/className="(note--[a-z-]+)"/g)].map((m) => m[1]);
    expect(new Set(classes)).toEqual(new Set(['note--warn']));
    expect(classes.length).toBe(3); // A3's inert-channel row, the helper-agent note, and this
  });

  it('⚠ it says drafts work, names the Drafts folder, and points at the real control', () => {
    const src = panel();
    expect(src).toMatch(/drafts still work/i);
    expect(src).toMatch(/Drafts folder/);
    expect(src).toContain('“Can talk to people” → Email');
    // and it never names a tool at the owner: this card speaks no internal language.
    expect(src).not.toContain('gmail_draft');
    expect(src).not.toContain('outlook_draft');
  });
});
