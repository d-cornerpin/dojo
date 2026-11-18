// A job cut by a restart is told to the agent as the kind it was: a picture is a picture, not audio.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const tell = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../agent/wake-with-notice.js', () => ({
  tellAgentAndWake: tell, noteJobStartedIn: vi.fn(), takeJobStartedInFailureTurn: () => false,
}));
vi.mock('../../work/ask-settlement.js', () => ({ settleAskOnAsyncResult: vi.fn(), settleAskOnJobEnded: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { notifyAbandonedGenerationJobs } from '../generation-jobs.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  tell.mockClear();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const job = (id: string, kind: string) => mockDb.current!.prepare(
  `INSERT INTO generation_jobs (id, kind, agent_id, model_id, provider_id, prompt, status) VALUES (?, ?, 'a1', 'm', 'p', 'x', 'failed')`,
).run(id, kind);

describe('the interrupted-job notice names the kind that was cut', () => {
  it('a cut picture is told as a picture', () => {
    job('gen_img', 'image');
    notifyAbandonedGenerationJobs([{ id: 'gen_img' }]);
    expect(tell).toHaveBeenCalledTimes(1);
    const brief = (tell.mock.calls[0][0] as { brief: string }).brief;
    expect(brief).toContain('the picture you asked for could not be finished');
    expect(brief).not.toContain('audio');
  });

  it('a cut song is told as music', () => {
    job('gen_mus', 'music');
    notifyAbandonedGenerationJobs([{ id: 'gen_mus' }]);
    expect(tell).toHaveBeenCalledTimes(1);
    const brief = (tell.mock.calls[0][0] as { brief: string }).brief;
    expect(brief).toContain('the music you asked for could not be finished');
  });

  it('a cut clip is told as audio', () => {
    job('gen_aud', 'audio');
    notifyAbandonedGenerationJobs([{ id: 'gen_aud' }]);
    expect(tell).toHaveBeenCalledTimes(1);
    const brief = (tell.mock.calls[0][0] as { brief: string }).brief;
    expect(brief).toContain('the audio you asked for could not be finished');
  });
});
