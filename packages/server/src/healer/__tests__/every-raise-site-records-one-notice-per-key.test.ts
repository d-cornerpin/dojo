// Every site that tells the owner something reaches the one writer: triggering each site's own raise in one box leaves
// exactly one notices-table row per key, in the site's words, and the dashboard's reload list is those rows.
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
import { recordFailureTold } from '../../services/watcher-owner-cards.js';
import { noteNoticeOnce, noteRateLimitExhausted } from '../../agent/agent-owner-cards.js';
import { noteBackupStuck, clearImportCard } from '../../migration/import-recovery.js';
import { budgetStopToTell } from '../../costs/budget-cards.js';
import { stallKey, tellOwnerOncePerWindow, wordsOf } from '../owner-notices.js';
import { standingOwnerNotices } from '../owner-notice-kinds.js';

const db = (): Database.Database => mockDb.current!;
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  frames.length = 0;
  db().prepare("INSERT INTO agents (id, name, status) VALUES ('a-1', 'Helper', 'rate_limited'), ('a-2', 'Second', 'idle'), ('a-3', 'Parked', 'paused')").run();
  db().prepare("UPDATE agents SET last_error = '[budget_stop] waiting' WHERE id = 'a-3'").run();
  db().prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-1', 'user', 0, 'owner@example.com', 0)").run();
  db().prepare("INSERT INTO google_accounts (id, kind, position, email, connected, enabled, watch_email) VALUES ('g-2', 'agent', 1, 'agent@example.com', 1, 1, 1)").run();
  db().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
    VALUES ('w-1', 'task', 'a-2', 'owner', 'tracker', 'w-1', 'claimed', 'tracker', 0, 0, 'A stuck task', ?, ?)`).run(Date.now() - 86_400_000, Date.now());
});
afterEach(() => { clearImportCard(); mockDb.current?.close(); mockDb.current = null; });

describe('every raise site records one notice per key', () => {
  it('each site leaves one row in its words, and the reload list is exactly those rows', () => {
    noteCriticalMemory(100);
    noteSignInExpired('google_accounts', 'g-1', 'The Google account needs signing in again.');
    recordFailureTold('gmail', 'g-2', 'Gmail watching has been failing for 12 minutes.');
    noteNoticeOnce('a-2', 'broken_notice', 'Second has stopped: the key was refused.');
    noteRateLimitExhausted('a-1', 'Helper has been rate-limited for 6 hours.');
    noteBackupStuck('/tmp/example-backup');
    budgetStopToTell(null, () => undefined);
    tellOwnerOncePerWindow(stallKey('w-1'), wordsOf(stallKey('w-1')), 86_400_000);
    // the same raise twice records nothing more and pushes nothing more
    const pushes = frames.length;
    noteCriticalMemory(100);
    recordFailureTold('gmail', 'g-2', 'Gmail watching has been failing for 12 minutes.');
    expect(frames.length).toBe(pushes);

    const rows = db().prepare("SELECT key, value FROM healer_state WHERE scope = 'owner_told' ORDER BY key").all() as Array<{ key: string; value: string }>;
    expect(rows.map((r) => r.key)).toEqual([
      'broken:a-2', 'budgetstop:global_daily', 'import-failed-not-running', 'memory-low', 'ratelimit:a-1', 'signin:google:g-1', 'stall:w-1', 'watcher:gmail:g-2',
    ]);
    for (const r of rows) expect(r.value, r.key).not.toBe('');
    expect(standingOwnerNotices().map((c) => c.cardKey).sort()).toEqual(rows.map((r) => r.key));
    for (const key of rows.map((r) => r.key)) expect(frames.filter((f) => f.type === 'chat:error' && f.cardKey === key && f.severity !== 'info'), key).toHaveLength(1);
  });

  it('a row whose condition has ended leaves the reload list as it is read', () => {
    noteSignInExpired('google_accounts', 'g-1', 'The Google account needs signing in again.');
    db().prepare("UPDATE google_accounts SET connected = 1 WHERE id = 'g-1'").run();
    expect(standingOwnerNotices()).toEqual([]);
    expect(db().prepare("SELECT 1 FROM healer_state WHERE key = 'signin:google:g-1'").get()).toBeUndefined();
  });
});
