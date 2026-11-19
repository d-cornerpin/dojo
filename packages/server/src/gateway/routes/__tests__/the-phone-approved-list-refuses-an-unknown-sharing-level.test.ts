// The phone approved lists (SMS senders, voice callers) add and remove through the one module that owns
// them, and a new sender whose sharing level is not one of the four is refused and nothing is saved.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({
  enforceModelCapabilities: vi.fn(),
  injectAttachmentBlocks: vi.fn(),
  getAgentRuntime: () => ({ handleMessage: vi.fn(async () => {}) }),
}));

import { runMigrations } from '../../../db/migrations.js';
import { twilioRouter } from '../twilio.js';

const stored = (k: string): string | null =>
  (mockDb.current!.prepare('SELECT value FROM config WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null;
const post = (p: string, body: unknown) => twilioRouter.request(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the phone approved lists', () => {
  it('an unknown sharing level is refused and nothing is saved', async () => {
    const res = await post('/safe-senders/sms', { name: 'Pat', address: '+15550100', sharing_level: 'everything' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('sharing_level must be one of: open_book, dont_overshare, cautious, project_only.');
    expect(stored('twilio_sms_approved_senders')).toBeNull();

    const voice = await post('/safe-senders/voice', { name: 'Pat', address: '+15550100', sharing_level: 'everything' });
    expect(voice.status).toBe(400);
    expect(stored('twilio_voice_approved_callers')).toBeNull();
  });

  it('an absent level saves the sender as cautious', async () => {
    const res = await post('/safe-senders/sms', { name: 'Pat', address: '+15550100' });
    expect(res.status).toBe(200);
    expect(JSON.parse(stored('twilio_sms_approved_senders')!)[0]).toMatchObject({ address: '+15550100', sharing_level: 'cautious' });
  });

  it('removing a number takes it off the list once', async () => {
    await post('/safe-senders/sms', { name: 'Pat', address: '+15550100' });
    const del = await twilioRouter.request('/safe-senders/sms/' + encodeURIComponent('+15550100'), { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await del.json()).data.totalSenders).toBe(0);
    expect(JSON.parse(stored('twilio_sms_approved_senders')!)).toEqual([]);
    const again = await twilioRouter.request('/safe-senders/sms/' + encodeURIComponent('+15550100'), { method: 'DELETE' });
    expect(again.status).toBe(404);
    expect((await again.json()).error).toBe('Not found.');
  });
});
