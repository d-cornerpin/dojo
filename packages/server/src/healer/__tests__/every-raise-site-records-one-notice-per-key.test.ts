// Raise sites reach the one writer: triggering each site's own raise in one box leaves exactly one notices-table row per
// key, in the site's words, and the dashboard's reload list is those rows. Covered here: memory low, an expired Google
// sign-in, a failing watcher, a broken agent, rate-limit retries exhausted, the import card, the budget stop. Covered by
// their own suites: the stall card (the-owner-hears-by-one-card-a-day), no fit (t148, t149), the budget crossing (t167),
// paused, balance, the Healer's cases, Ollama (the upkeep suites),
// the embedding switch and an unchecked fit (their suites).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => [] as Array<{ type?: string; cardKey?: string; severity?: string }>);
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: { type?: string }) => { frames.push(f); }, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../services/imessage-bridge.js', () => ({ sendAlert: async () => undefined }));

import { runMigrations } from '../../db/migrations.js';
import { noteCriticalMemory } from '../../services/memory-low-notice.js';
import { noteSignInExpired } from '../../services/account-owner-cards.js';
import { insertGoogleAccount } from '../../google/accounts.js';
import { getValidAccessTokenForAccount } from '../../google/auth.js';
import { maybeAlertOnFailure } from '../../services/watcher-status.js';
import { onAgentInjured } from '../injury-recovery.js';
import { noteBackupStuck, clearImportCard } from '../../migration/import-recovery.js';
import { budgetStopToTell } from '../../costs/budget-cards.js';
import { servedOwnerNotices, standingOwnerNotices } from '../owner-notice-kinds.js';

const db = (): Database.Database => mockDb.current!;
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  frames.length = 0;
  db().prepare("INSERT INTO agents (id, name, status) VALUES ('a-1', 'Helper', 'rate_limited'), ('a-2', 'Second', 'idle'), ('a-3', 'Parked', 'paused')").run();
  db().prepare("UPDATE agents SET last_error = '[budget_stop] waiting' WHERE id = 'a-3'").run();
  db().prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-1', 'user', 0, 'owner@example.com', 0)").run();
  db().prepare("INSERT INTO google_accounts (id, kind, position, email, connected, enabled, watch_email) VALUES ('g-2', 'agent', 1, 'agent@example.com', 1, 1, 1)").run();
});
afterEach(() => { clearImportCard(); mockDb.current?.close(); mockDb.current = null; });

describe('every raise site records one notice per key', () => {
  it('each site leaves one row in its words, and the reload list is exactly those rows', async () => {
    const failing = { name: 'gmail' as const, accountId: 'g-2', consecutiveFailures: 10, firstFailureAt: new Date(Date.now() - 3_600_000).toISOString(), lastError: 'boom', alreadyAlerted: false };
    noteCriticalMemory(100);
    const acc = insertGoogleAccount({ kind: 'agent', email: 'helper@example.com', connected: true, accessToken: 'at-old', refreshToken: 'rt-1', tokenExpiresAt: Date.now() - 1000 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));
    await getValidAccessTokenForAccount(acc.id);
    vi.unstubAllGlobals();
    maybeAlertOnFailure(failing);
    onAgentInjured('a-2', '[auth_invalid] the key was refused');
    noteBackupStuck('/tmp/example-backup');
    budgetStopToTell(null, () => undefined);
    // the same raise twice records nothing more and pushes nothing more
    const pushes = frames.length;
    noteCriticalMemory(100);
    maybeAlertOnFailure(failing);
    expect(frames.length).toBe(pushes);

    const rows = db().prepare("SELECT key, value FROM healer_state WHERE scope = 'owner_told' ORDER BY key").all() as Array<{ key: string; value: string }>;
    expect(rows.map((r) => r.key)).toEqual([
      'broken:a-2', 'budgetstop:global_daily', 'import-failed-not-running', 'memory-low', `signin:google:${acc.id}`, 'watcher:gmail:g-2',
    ]);
    for (const r of rows) expect(r.value, r.key).not.toBe('');
    expect(standingOwnerNotices().map((c) => c.cardKey).sort()).toEqual(rows.map((r) => r.key));
    for (const key of rows.map((r) => r.key)) expect(frames.filter((f) => f.type === 'chat:error' && f.cardKey === key && f.severity !== 'info'), key).toHaveLength(1);
  });

  it('a row whose condition has ended is off the reload list, and a dashboard load removes it', () => {
    noteSignInExpired('google_accounts', 'g-1', 'The Google account needs signing in again.');
    db().prepare("UPDATE google_accounts SET connected = 1 WHERE id = 'g-1'").run();
    expect(standingOwnerNotices()).toEqual([]);
    expect(servedOwnerNotices()).toEqual([]);
    expect(db().prepare("SELECT 1 FROM healer_state WHERE key = 'signin:google:g-1'").get()).toBeUndefined();
  });
});
