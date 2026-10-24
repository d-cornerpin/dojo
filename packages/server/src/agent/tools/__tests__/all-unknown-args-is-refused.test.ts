// ════════════════════════════════════════════════════════════════════════════════════════
// B11 (GitHub #22) — A CALL WHOSE ARGUMENTS ARE ALL UNKNOWN IS REFUSED, NOT RUN EMPTY.
//
// The incident: a worker agent called the Gmail label tool with an argument the tool does not
// have. The engine prepended "arg(s) not in its schema … silently ignored" and then RAN the
// call with nothing in it; the model read past the warning to the next line, "Labels updated".
// Nothing had been done.
//
// A typical owner's expectation: when every argument an agent sent is one the tool does not
// have, the tool must not run at all, and the refusal must say what the tool does take and
// which name was probably meant. When SOME declared argument is present, today's warning stays
// (the per-tool empty-change guards own "ids but no action").
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-b11-test', 'dojo.db'),
  };
});
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../../google/client.js', () => ({
  googleRead: vi.fn(),
  googleWrite: vi.fn(async () => ({ ok: true, data: { id: 'm1', messages: [] }, error: null, apiEndpoint: 'x' })),
}));
vi.mock('../../../google/accounts.js', () => ({
  resolveGoogleAccountForTool: vi.fn(() => ({
    account: {
      id: 'agent', kind: 'agent', position: 1, email: 'agent@example.com',
      enabled: true, connected: true, accessToken: null, refreshToken: null,
      tokenExpiresAt: null, grantedScopes: null, enabledServices: null,
      watchEmail: false, sendEmail: true, lastVerifiedAt: null,
    },
  })),
}));

import { runMigrations } from '../../../db/migrations.js';
import { clearPlatformConfigCache } from '../../../config/platform.js';
import { executeTool } from '../index.js';
import { toolResultOf } from '../../tool-outcome.js';
import { googleWrite } from '../../../google/client.js';
import { suggestArgNames } from '../../../tools/name-help.js';

const AGENT = 'agent-b11';

let migratedImage: Buffer | null = null;
function migratedDb(): Database.Database {
  if (migratedImage === null) {
    const seed = new Database(':memory:');
    mockDb.current = seed;
    runMigrations();
    migratedImage = seed.serialize();
    seed.close();
  }
  const db = new Database(migratedImage);
  db.pragma('foreign_keys = ON');
  return db;
}

beforeEach(() => {
  mockDb.current = migratedDb();
  mockDb.current.prepare(
    "INSERT INTO agents (id, name, status, config) VALUES (?, 'Main', 'idle', '{}')",
  ).run(AGENT);
  mockDb.current.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(AGENT);
  clearPlatformConfigCache();
  vi.mocked(googleWrite).mockClear();
});

async function call(name: string, args: Record<string, unknown>) {
  return toolResultOf(await executeTool(AGENT, { id: 'tc-1', name, arguments: args }));
}

describe('B11 — a call made only of unknown arguments is refused', () => {
  it('refuses, runs nothing, names the declared arguments and the one it meant', async () => {
    const r = await call('gmail_label', { labels: ['X'] });
    expect(r.isError).toBe(true);
    expect(r.errorCode).toBe('UNKNOWN_ARGS');
    expect(r.content).toContain('Refused: none of the arguments you passed exist on "gmail_label"');
    expect(r.content).toContain('"labels"');
    expect(r.content).toContain('Declared arguments: ');
    expect(r.content).toContain('add_labels');
    expect(r.content).toContain('Did you mean: labels → add_labels');
    expect(r.content).toContain('load_tool_docs(tools=["gmail_label"])');
    expect(r.content).toContain('Nothing was done.');
    expect(googleWrite).not.toHaveBeenCalled();
  });

  it('when SOME declared argument is present, today\'s warning stays and the call runs', async () => {
    const r = await call('gmail_label', { message_id: 'm1', add_labels: ['X'], foo: 1 });
    expect(r.errorCode).toBeUndefined();
    expect(r.content).toContain('[Engine warning: "gmail_label" was called with arg(s) not in its schema, "foo"');
    expect(r.content).toContain('Labels updated on');
    expect(googleWrite).toHaveBeenCalledTimes(1);
  });

  it('a call with no arguments at all is not "unknown arguments" (the required-field door owns it)', async () => {
    const r = await call('gmail_label', {});
    expect(r.errorCode).not.toBe('UNKNOWN_ARGS');
  });

  it('a tool that declares no arguments at all is never refused for a stray one (it runs the same either way)', async () => {
    const r = await call('get_current_time', { foo: 1 });
    expect(r.errorCode).not.toBe('UNKNOWN_ARGS');
    expect(r.content).toContain('[Engine warning: "get_current_time" was called with arg(s) not in its schema');
  });

  it('a refusal with nothing close to suggest still refuses, without a "Did you mean"', async () => {
    const r = await call('gmail_label', { zzzqqq: 1 });
    expect(r.errorCode).toBe('UNKNOWN_ARGS');
    expect(r.content).not.toContain('Did you mean');
    expect(googleWrite).not.toHaveBeenCalled();
  });
});

describe('B11 — suggestArgNames', () => {
  const declared = ['message_id', 'thread_id', 'this_message_only', 'add_labels', 'remove_labels'];

  it('a shared stem is a suggestion ("labels" is the tail of "add_labels")', () => {
    const s = suggestArgNames(['labels'], declared);
    expect(s.map((x) => x.meant)).toContain('add_labels');
    expect(s.every((x) => x.given === 'labels')).toBe(true);
  });

  it('an edit distance of two or less is a suggestion', () => {
    expect(suggestArgNames(['mesage_id'], declared)).toEqual([{ given: 'mesage_id', meant: 'message_id' }]);
  });

  it('nothing close, nothing suggested', () => {
    expect(suggestArgNames(['zzzqqq'], declared)).toEqual([]);
  });

  it('a generic one-word overlap ("id") is not a stem', () => {
    expect(suggestArgNames(['id'], declared)).toEqual([]);
  });
});
