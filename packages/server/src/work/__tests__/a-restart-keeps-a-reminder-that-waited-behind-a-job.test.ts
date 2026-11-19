// The start-up staleness sweep drops an old backlog, but not what waits on its own lifecycle: a reminder that waited
// behind a long job goes through its own expiry, and a request waiting on its due is kept for the clock.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { insertEngineEvent } from '../../memory/message-store.js';
import { sweepBootStaleness } from '../work-reaper.js';
import { freshReplyDb, testDb, AGENT } from '../../agent/v2/__tests__/helpers/reply-sender.js';
import { samAsks, askOf } from './helpers/a-request-handed-back.js';

const FORTY_MINUTES_AGO = (): number => Date.now() - 40 * 60_000;
const swept = (seq: number): boolean => (testDb().prepare('SELECT swept_at FROM messages WHERE seq = ?').get(seq) as { swept_at: number | null }).swept_at !== null;

beforeEach(() => { freshReplyDb(runMigrations); });

describe('a restart keeps a reminder that waited behind a job', () => {
  it('an old reminder is kept and an old plain engine event is swept', () => {
    const reminder = insertEngineEvent({ agentId: AGENT, content: 'remind the owner to call back', originIntent: 'scheduler', work: null });
    const plain = insertEngineEvent({ agentId: AGENT, content: 'a tracker notice', originIntent: 'tracker', work: null });
    testDb().prepare('UPDATE messages SET created_at = ? WHERE seq IN (?, ?)').run(FORTY_MINUTES_AGO(), reminder.seq, plain.seq);
    sweepBootStaleness();
    expect(swept(reminder.seq)).toBe(false);
    expect(swept(plain.seq)).toBe(true);
  });

  it('a request waiting on its due is kept while an old backlog is dropped', () => {
    for (let i = 1; i <= 7; i++) samAsks(`m-${i}`);
    testDb().prepare("UPDATE work SET opened_at = ? WHERE kind = 'ask'").run(FORTY_MINUTES_AGO());
    testDb().prepare("UPDATE work SET next_attempt_at = ? WHERE id = 'ask:m-7'").run(Date.now() + 60_000);
    sweepBootStaleness();
    expect(askOf('m-1').state).toBe('abandoned');
    expect(askOf('m-7').state).toBe('open');
  });
});
