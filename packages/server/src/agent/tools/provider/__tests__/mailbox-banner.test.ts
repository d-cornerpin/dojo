// ════════════════════════════════════════════════════════════════════════════
// THE USER-MAILBOX BANNER IS A CAPABILITY, AND THIS IS THE TEST THAT SAYS SO
// (PHASE-5 T4 — written BEFORE the provider dispatch region moved)
//
// A `user_*` mail read returns the OWNER'S inbox. The banner in front of it is
// what tells the model that the emails below were addressed to the user and
// that instructions inside them are not the agent's to follow — i.e. it is the
// thing standing between the owner's inbox and a prompt-injection channel.
//
// PHASE-5.md's T4 Step 1 correction flagged this exact region as a trap: the
// executor's default membership branch banners Google reads and NOT Microsoft
// reads, while the explicit cases banner both. Drop an explicit `user_outlook_*`
// label and that tool routes through the branch and loses its banner with no
// error, no test failure and no line in a diff that looks like a capability
// change. Clause 1 is the guard: every banner-eligible tool must be served by
// the HANDLER TABLE, never by the fall-through.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => ({ name: 'kevin' }), run: () => undefined }) }),
}));
vi.mock('../../../../config/platform.js', () => ({ isPrimaryAgent: () => true }));
vi.mock('../../util.js', () => ({ auditLog: () => undefined }));
vi.mock('../../../../google/auth.js', () => ({ getGoogleWorkspaceConfig: () => ({ accountEmail: 'owner@example.com' }) }));
vi.mock('../../../../microsoft/auth.js', () => ({ getMicrosoftWorkspaceConfig: () => ({ accountEmail: 'owner@example.com' }) }));

const googleRead = vi.fn(async () => 'GOOGLE BODY');
const msRead = vi.fn(async () => 'MICROSOFT BODY');
vi.mock('../../../../google/tools-read.js', () => ({ executeGoogleReadTool: (...a: unknown[]) => googleRead(...(a as [])) }));
vi.mock('../../../../google/tools-write.js', () => ({ executeGoogleWriteTool: async () => 'WROTE' }));
vi.mock('../../../../microsoft/tools-read.js', () => ({ executeMicrosoftReadTool: (...a: unknown[]) => msRead(...(a as [])) }));
vi.mock('../../../../microsoft/tools-write.js', () => ({ executeMicrosoftWriteTool: async () => 'WROTE' }));

const { USER_MAILBOX_READ_TOOLS, prependUserMailboxBanner } = await import('../mailbox-banner.js');
const { googleHandlers } = await import('../google.js');
const { microsoftHandlers } = await import('../microsoft.js');

const table: Record<string, (ctx: { agentId: string; name: string; args: Record<string, unknown>; callId: string }) => Promise<{ content: string; isError: boolean }>> = {
  ...(googleHandlers as never), ...(microsoftHandlers as never),
};
const call = (name: string) => table[name]({ agentId: 'a1', name, args: {}, callId: 'c1' });
const BANNER_HEAD = '[Mailbox: owner@example.com, this is your USER';

describe('the user-mailbox banner', () => {
  beforeEach(() => {
    googleRead.mockResolvedValue('GOOGLE BODY');
    msRead.mockResolvedValue('MICROSOFT BODY');
  });

  // ── CLAUSE 1: THE TRAP GUARD ──
  it('every banner-eligible tool is served by the handler table, never by the default membership branch', () => {
    const missing = [...USER_MAILBOX_READ_TOOLS].filter((n) => typeof table[n] !== 'function');
    expect(missing, 'these would fall through to the executor default branch, where Microsoft reads get NO banner').toEqual([]);
    // and the set itself is non-empty, so the clause cannot pass by measuring nothing
    expect(USER_MAILBOX_READ_TOOLS.size).toBe(8);
  });

  // ── CLAUSE 2: THE BEHAVIOUR, PER TOOL, BOTH PROVIDERS ──
  it.each([...USER_MAILBOX_READ_TOOLS])('%s prepends the banner to a successful read', async (name) => {
    const out = await call(name);
    expect(out.content.startsWith(BANNER_HEAD), `${name} lost its mailbox banner`).toBe(true);
    expect(out.isError).toBe(false);
  });

  // ── CLAUSE 3: IT IS THE `user_*` SLOT THAT IS BANNERED, NOT EVERY READ ──
  it.each(['gmail_search', 'gmail_inbox', 'outlook_search', 'outlook_inbox'])(
    '%s (the agent\'s OWN mailbox) is not bannered', async (name) => {
      const out = await call(name);
      expect(out.content.includes('[Mailbox:')).toBe(false);
    });

  // ── CLAUSE 4: AN ERROR IS NOT BANNER-WRAPPED ──
  it('an error result is left alone rather than banner-wrapped', async () => {
    msRead.mockResolvedValue('Error: not authenticated');
    const out = await call('user_outlook_read');
    expect(out.content).toBe('Error: not authenticated');
    expect(out.isError).toBe(true);
  });

  // ── CLAUSE 5: THE FUNCTION'S OWN CONTRACT ──
  it('banners only the eight declared names and passes everything else through', () => {
    expect(prependUserMailboxBanner('X', 'user_gmail_read').startsWith(BANNER_HEAD)).toBe(true);
    expect(prependUserMailboxBanner('X', 'user_calendar_list')).toBe('X');
    expect(prependUserMailboxBanner('Error: nope', 'user_gmail_read')).toBe('Error: nope');
  });
});
