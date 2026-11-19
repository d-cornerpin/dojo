// The mail bookkeeping rows (platform sends, owner mail seen) go once they are 90 days old; newer ones stay.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as w from './mail-world.js';

vi.mock('../../db/connection.js', async () => (await import('./mail-world.js')).dbModule());
vi.mock('../../gateway/ws.js', async () => (await import('./mail-world.js')).wsModule());
vi.mock('../../agent/runtime.js', async () => (await import('./mail-world.js')).runtimeModule());
vi.mock('../../google/client.js', async () => (await import('./mail-world.js')).googleClientModule());
vi.mock('../../microsoft/client.js', async () => (await import('./mail-world.js')).graphClientModule());

// Loaded at file level, so no case pays for the load.
import '../../db/migrations.js';
import '../gmail-watcher.js';
import '../outlook-watcher.js';
import { forgetOldMailRecords } from '../platform-sends.js';

beforeEach(() => w.freshWorld());

describe('old mail records are forgotten after ninety days', () => {
  it('a 91-day-old row goes, a row from today stays, other keys are untouched', () => {
    const put = (key: string, age: string) => w.rows(`INSERT INTO config (key, value, updated_at) VALUES (?, 'x', datetime('now', ?)) RETURNING key`, key, age);
    put('platform_send:old', '-91 days');
    put('platform_send:new', '-0 days');
    put('other_setting', '-200 days');
    forgetOldMailRecords('platform_send:');
    expect(w.rows(`SELECT key FROM config WHERE key IN ('platform_send:old', 'platform_send:new', 'other_setting') ORDER BY key`))
      .toEqual([{ key: 'other_setting' }, { key: 'platform_send:new' }]);
  });
});
