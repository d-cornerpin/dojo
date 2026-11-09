// The Google sign-in asks for every scope a registered tool's API call needs (the twin of the Microsoft Teams incident).
// Every registered Gmail, Calendar, Drive, Docs, Sheets, Slides and Forms tool runs against a recording fetch; each call
// maps by API to the scope Google's OAuth scope reference names, and the scopes the sign-in URL asks for must hold them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { insertGoogleAccount } from '../accounts.js';
import { buildAuthUrl } from '../auth.js';
import { googleReadToolDefinitions, executeGoogleReadTool } from '../tools-read.js';
import { googleWriteToolDefinitions, executeGoogleWriteTool } from '../tools-write.js';
import { slidesToolDefinitions, executeGoogleSlidesTool } from '../tools-slides.js';
import { formsToolDefinitions, executeGoogleFormsTool } from '../tools-forms.js';

const G = 'https://www.googleapis.com/auth/';
type Call = { method: string; url: string };
const RULES: Array<{ test: (c: Call) => boolean; scopes: string[] }> = [
  { test: (c) => /^https:\/\/gmail\.googleapis\.com\/.*\/messages\/send/.test(c.url), scopes: [`${G}gmail.send`] },
  { test: (c) => /^https:\/\/gmail\.googleapis\.com\/.*\/drafts/.test(c.url), scopes: [`${G}gmail.compose`] },
  { test: (c) => /^https:\/\/gmail\.googleapis\.com\/.*(\/modify|\/batchModify|\/trash)$/.test(c.url), scopes: [`${G}gmail.modify`] },
  { test: (c) => /^https:\/\/gmail\.googleapis\.com\/.*\/labels/.test(c.url) && c.method !== 'GET', scopes: [`${G}gmail.modify`] },
  { test: (c) => c.url.startsWith('https://gmail.googleapis.com/'), scopes: [`${G}gmail.readonly`] },
  { test: (c) => c.url.startsWith('https://www.googleapis.com/calendar/'), scopes: [`${G}calendar`] },
  { test: (c) => /^https:\/\/www\.googleapis\.com\/(upload\/)?drive\//.test(c.url), scopes: [`${G}drive`] },
  { test: (c) => c.url.startsWith('https://docs.googleapis.com/'), scopes: [`${G}documents`] },
  { test: (c) => c.url.startsWith('https://sheets.googleapis.com/'), scopes: [`${G}spreadsheets`] },
  { test: (c) => c.url.startsWith('https://slides.googleapis.com/'), scopes: [`${G}presentations`] },
  { test: (c) => /^https:\/\/forms\.googleapis\.com\/.*\/responses/.test(c.url), scopes: [`${G}forms.responses.readonly`] },
  { test: (c) => c.url.startsWith('https://forms.googleapis.com/'), scopes: [`${G}forms.body`] },
  { test: (c) => /^https:\/\/(www|oauth2)\.googleapis\.com\/oauth2\//.test(c.url), scopes: ['email'] },
];

/** Plausible arguments from a tool's own schema, so it gets as far as its API call. */
function argsFor(schema: { properties?: Record<string, { type?: string; enum?: unknown[] }> } | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema?.properties ?? {}).filter(([k]) => !/^(account|file_path|local_path|paths?|preset|style)$/.test(k)).map(([k, p]) => [k,
    p.enum ? p.enum[0] : p.type === 'number' || p.type === 'integer' ? 1 : p.type === 'boolean' ? false : p.type === 'array' ? [] : p.type === 'object' ? {}
      : /email|^to$|^cc$|recipient|attendee/.test(k) ? 'someone@example.com' : /time|date|^start|^end/.test(k) ? '2026-01-01T10:00:00Z' : 'x1']));
}

let calls: Call[] = [];
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES ('a-1', 'Helper', 'idle')").run();
  for (const kind of ['agent', 'user'] as const) {
    insertGoogleAccount({ id: kind, position: 1, kind, email: `${kind}@example.com`, connected: true, accessToken: 'at', refreshToken: 'rt', tokenExpiresAt: Date.now() + 3_600_000, sendEmail: true });
  }
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (/googleapis\.com\//.test(url)) calls.push({ method: init?.method ?? 'GET', url: url.replace(/\?.*$/, '') });
    return new Response(JSON.stringify({ id: 'id1', items: [], files: [], messages: [], labels: [], replies: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('the Google sign-in asks for every scope a tool uses', () => {
  it('every API call of every registered tool is covered by the scopes the sign-in asks for', async () => {
    const scopes = new Set((new URL(buildAuthUrl('http://localhost/cb', { kind: 'agent' }).authUrl).searchParams.get('scope') ?? '').split(' '));
    const tables = [[googleReadToolDefinitions, executeGoogleReadTool], [googleWriteToolDefinitions, executeGoogleWriteTool],
      [slidesToolDefinitions, executeGoogleSlidesTool], [formsToolDefinitions, executeGoogleFormsTool]] as const;
    for (const [defs, run] of tables) {
      for (const d of defs) {
        try { await (run as (n: string, a: Record<string, unknown>, id: string, name: string) => Promise<unknown>)(d.name, argsFor(d.input_schema as Parameters<typeof argsFor>[0]), 'a-1', 'Helper'); } catch { /* a refusal is fine; its calls so far count */ }
      }
    }
    expect(calls.length).toBeGreaterThan(60);
    const unmapped = calls.filter((c) => !RULES.some((r) => r.test(c))).map((c) => `${c.method} ${c.url}`);
    expect(unmapped, 'a Google API call with no scope row').toEqual([]);
    const missing = calls.flatMap((c) => RULES.find((r) => r.test(c))!.scopes).filter((s) => !scopes.has(s));
    expect([...new Set(missing)], 'scopes a tool needs that the sign-in does not ask for').toEqual([]);
    for (const api of ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'slides', 'forms']) expect(calls.some((c) => c.url.includes(api)), api).toBe(true);
  });
});
