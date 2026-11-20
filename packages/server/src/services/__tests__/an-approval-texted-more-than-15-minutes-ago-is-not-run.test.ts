// A texted "yes <id>" or "no <id>" resolves the named pending approval when fresh; one sent more than 15 minutes
// ago is not run, the owner is told so, and the approval stays pending.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const resolve = vi.hoisted(() => vi.fn(() => ({ ok: true })));
vi.mock('../../gateway/routes/healer.js', () => ({ resolveHealerProposal: resolve }));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { handleIMCommand } from '../imessage-commands.js';

const OWNER = '+15550100198';
const OLD = Date.now() - 20 * 60_000;

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)").run(JSON.stringify([
    { address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' },
  ]));
});
beforeEach(() => {
  resolve.mockClear();
  getDb().prepare('DELETE FROM healer_proposals').run();
  getDb().prepare(`INSERT INTO healer_proposals (id, status, surface, category, severity, title, description, proposed_fix, created_at)
    VALUES ('abc123ff', 'pending', 'imessage', 'x', 'low', 't', 'd', 'f', datetime('now'))`).run();
});

describe('a texted approval is run only while fresh', () => {
  it.each([['yes', 'approve', 'Approved.'], ['no', 'deny', 'Denied.']])('a fresh "%s <id>" resolves it', async (word, action, said) => {
    expect(await handleIMCommand(`${word} abc123`, OWNER, Date.now())).toContain(said);
    expect(resolve).toHaveBeenCalledWith({ id: 'abc123ff', action, note: null });
  });

  it.each(['yes', 'no'])('a "%s <id>" older than 15 minutes is not run, and the approval stays pending', async (word) => {
    expect(await handleIMCommand(`${word} abc123`, OWNER, OLD)).toContain('more than 15 minutes ago, so it was not run');
    expect(resolve).not.toHaveBeenCalled();
    expect((getDb().prepare("SELECT status FROM healer_proposals WHERE id = 'abc123ff'").get() as { status: string }).status).toBe('pending');
  });
});
