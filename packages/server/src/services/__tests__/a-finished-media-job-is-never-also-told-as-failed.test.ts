// A job that already finished is never also reported as failed: when a speech/music job succeeds and posting the
// file then throws, the failure notice goes only when the job was really moved to failed.

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
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: vi.fn() }));
vi.mock('../../costs/tracker.js', () => ({ recordCost: vi.fn() }));
vi.mock('../../agent/effects/fs.js', () => ({ existsSync: () => true, mkdirSync: () => undefined, copyFileSync: () => undefined }));
const post = vi.hoisted(() => vi.fn());
vi.mock('../../memory/message-store.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  deliveredResult: () => ({}),
  insertMessageIfAbsent: post,
}));
vi.mock('../audio-generation.js', () => ({
  generateAudio: async () => ({ ok: true, filePath: '/nowhere/clip.wav', mimeType: 'audio/wav', sizeBytes: 3, durationSeconds: 2, providerId: 'p', inputTokens: 0, outputTokens: 0, latencyMs: 1 }),
}));

import { runMigrations } from '../../db/migrations.js';
import { createGenerationJob, enqueueAudioOrMusicJob, setFailed } from '../generation-jobs.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  tell.mockClear();
  post.mockReset();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

async function finished(id: string): Promise<string> {
  for (let i = 0; i < 200; i += 1) {
    const st = (mockDb.current!.prepare('SELECT status FROM generation_jobs WHERE id = ?').get(id) as { status: string }).status;
    if (st !== 'queued' && st !== 'running') return st;
    await new Promise((r) => setTimeout(r, 5));
  }
  return 'still running';
}

describe('a finished media job is never also told as failed', () => {
  it('posting the file throws after success: no failure is told', async () => {
    post.mockImplementation(() => { throw new Error('disk full'); });
    const id = createGenerationJob({ kind: 'audio', agentId: 'a1', modelId: 'm', providerId: 'p', prompt: 'hello' });
    enqueueAudioOrMusicJob(id);
    expect(await finished(id)).toBe('succeeded');
    await new Promise((r) => setTimeout(r, 20));
    expect(tell).not.toHaveBeenCalled();
  });

  it('setFailed says whether it moved the row', () => {
    const id = createGenerationJob({ kind: 'music', agentId: 'a1', modelId: 'm', providerId: 'p', prompt: 'x' });
    expect(setFailed(id, 'boom')).toBe(true);
    expect(setFailed(id, 'boom')).toBe(false);
  });
});
