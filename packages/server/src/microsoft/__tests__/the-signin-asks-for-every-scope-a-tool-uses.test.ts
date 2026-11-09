// The Microsoft sign-in asks for every scope a registered tool's Graph call needs (the Teams incident: the Teams tools
// shipped calling endpoints whose permissions the sign-in never requested). Every registered read, write and Office tool runs
// against a recording fetch; each Graph endpoint it calls maps to its scope through the table below, which cites the
// permission Microsoft's Graph reference names, and the scopes the sign-in sends must hold them all.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { insertMicrosoftAccount } from '../accounts.js';
import { getValidAccessTokenForAccount } from '../auth.js';
import { microsoftReadToolDefinitions, executeMicrosoftReadTool } from '../tools-read.js';
import { microsoftWriteToolDefinitions, executeMicrosoftWriteTool } from '../tools-write.js';
import { officeToolDefinitions, executeOfficeTool } from '../tools-office.js';

const GRAPH = 'https://graph.microsoft.com/v1.0/';
type Call = { method: string; shape: string };
const RULES: Array<{ test: (c: Call) => boolean; scopes: string[] }> = [
  { test: (c) => /^me\/messages\/\*\/microsoft\.graph\.calendarSharingMessage\/accept$/.test(c.shape), scopes: ['Calendars.ReadWrite'] },
  { test: (c) => /^me\/sendMail$|^me\/messages\/\*\/(reply|replyAll|forward|send)$/.test(c.shape), scopes: ['Mail.Send'] },
  { test: (c) => /^me\/(messages|mailFolders)(\/|$)/.test(c.shape), scopes: ['Mail.ReadWrite'] },
  { test: (c) => /^me\/(calendars?|events|calendarView)(\/|$)|^users\/\*\/calendar/.test(c.shape), scopes: ['Calendars.ReadWrite', 'Calendars.ReadWrite.Shared'] },
  { test: (c) => /^me\/drives?(\/|$)|^drives\/|^shares\//.test(c.shape), scopes: ['Files.ReadWrite', 'Files.ReadWrite.All'] },
  { test: (c) => /^sites(\/|$)/.test(c.shape), scopes: ['Sites.ReadWrite.All'] },
  { test: (c) => c.shape === 'me/joinedTeams', scopes: ['Team.ReadBasic.All'] },
  { test: (c) => /^teams\/\*\/channels$/.test(c.shape), scopes: ['Channel.ReadBasic.All'] },
  { test: (c) => /^teams\/\*\/channels\/\*\/messages$/.test(c.shape) && c.method === 'GET', scopes: ['ChannelMessage.Read.All'] },
  { test: (c) => /^teams\/\*\/channels\/\*\/messages$/.test(c.shape) && c.method !== 'GET', scopes: ['ChannelMessage.Send'] },
  { test: (c) => /^(me\/)?chats(\/|$)/.test(c.shape), scopes: ['Chat.ReadWrite'] },
  { test: (c) => c.shape === 'me', scopes: ['User.Read'] },
  { test: (c) => /^me\/onlineMeetings(\/|$)/.test(c.shape), scopes: ['OnlineMeetings.ReadWrite'] },
  { test: (c) => /^me\/todo\/lists(\/|$)/.test(c.shape), scopes: ['Tasks.ReadWrite'] },
  { test: (c) => /^me\/contacts(\/|$)/.test(c.shape), scopes: ['Contacts.ReadWrite'] },
  { test: (c) => /^me\/onenote(\/|$)/.test(c.shape), scopes: ['Notes.ReadWrite'] },
];

/** Plausible arguments from a tool's own schema, so it gets as far as its Graph call. */
function argsFor(schema: { properties?: Record<string, { type?: string; enum?: unknown[] }> } | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema?.properties ?? {}).filter(([k]) => !/^(account|file_path|local_path|paths?)$/.test(k)).map(([k, p]) => [k,
    p.enum ? p.enum[0] : p.type === 'number' || p.type === 'integer' ? 1 : p.type === 'boolean' ? false : p.type === 'array' ? [] : p.type === 'object' ? {}
      : /email|^to$|^cc$|recipient|attendee/.test(k) ? 'someone@example.com' : /time|date|^start|^end/.test(k) ? '2026-01-01T10:00:00Z' : 'x1']));
}

let calls: Call[] = [];
let requested = '';
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES ('a-1', 'Helper', 'idle')").run();
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://login.microsoftonline.com/')) {
      requested = new URLSearchParams(String(init?.body)).get('scope') ?? '';
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
    }
    if (url.startsWith(GRAPH)) calls.push({ method: init?.method ?? 'GET', shape: url.slice(GRAPH.length).replace(/\?.*$/, '').replace(/\b(x1|id1)\b/g, '*') });
    return new Response(JSON.stringify({ value: [], id: 'id1', webUrl: 'https://example.com/x' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('the Microsoft sign-in asks for every scope a tool uses', () => {
  it('every Graph call of every registered tool is covered by the scopes the sign-in sends', async () => {
    const expired = insertMicrosoftAccount({ kind: 'agent', email: 'old@example.com', connected: true, refreshToken: 'rt', tokenExpiresAt: 0 });
    await getValidAccessTokenForAccount(expired.id);
    const scopes = new Set(requested.split(' '));
    mockDb.current!.prepare('DELETE FROM microsoft_accounts').run();
    for (const kind of ['agent', 'user'] as const) {
      insertMicrosoftAccount({ kind, email: `${kind}@example.com`, connected: true, accessToken: 'at', refreshToken: 'rt', tokenExpiresAt: Date.now() + 3_600_000, sendEmail: true });
    }
    for (const [defs, run] of [[microsoftReadToolDefinitions, executeMicrosoftReadTool], [microsoftWriteToolDefinitions, executeMicrosoftWriteTool], [officeToolDefinitions, executeOfficeTool]] as const) {
      const before = calls.length;
      for (const d of defs) {
        try { await run(d.name, argsFor(d.input_schema as Parameters<typeof argsFor>[0]), 'a-1', 'Helper'); } catch { /* a refusal is fine; its calls so far count */ }
      }
      expect(calls.length, 'every tool table reaches Graph').toBeGreaterThan(before);
    }
    expect(calls.length).toBeGreaterThan(80);
    const unmapped = calls.filter((c) => !RULES.some((r) => r.test(c))).map((c) => `${c.method} ${c.shape}`);
    expect(unmapped, 'a Graph endpoint with no scope row').toEqual([]);
    const missing = calls.flatMap((c) => RULES.find((r) => r.test(c))!.scopes).filter((s) => !scopes.has(s));
    expect([...new Set(missing)], 'scopes a tool needs that the sign-in does not ask for').toEqual([]);
    for (const s of ['Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All', 'ChannelMessage.Send']) {
      expect(calls.some((c) => RULES.find((r) => r.test(c))!.scopes.includes(s)), s).toBe(true);
    }
  });
});
