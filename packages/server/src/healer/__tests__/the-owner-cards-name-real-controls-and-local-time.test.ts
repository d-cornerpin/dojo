// The owner's cards point at controls that exist and at a time he can read: Reset lives in the orb menu on the
// agent's chat, and the stall card's time goes through the Dojo's one time formatter, the Mac's own time.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current, closeDb: () => undefined }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { stuckWords, wordsOf, stallKey } from '../owner-notices.js';

describe('the owner cards name real controls and local time', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations(mockDb.current);
    seedTrackerTask(mockDb.current, { id: 't1', title: 'Write the guide', agentId: 'a1', status: 'in_progress' });
  });
  afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

  it('the stuck card names Reset in the orb menu, not a detail page', () => {
    const words = stuckWords('Helper');
    expect(words).toContain('open its chat and press Reset in the orb menu');
    expect(words).not.toContain('detail page');
  });

  it('the stall card gives the local time and names the Tracker page', () => {
    const words = wordsOf(stallKey('t1'));
    expect(words).toMatch(/since [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2}/);
    expect(words).not.toMatch(/since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(words).toContain('Open it on the Tracker page');
  });
});
