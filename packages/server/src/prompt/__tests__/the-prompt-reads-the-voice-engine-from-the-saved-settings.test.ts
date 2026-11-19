// A live call is coached for the voice that will really speak: the saved voice settings decide it, so a
// cloud choice with no cloud voice picked is coached for the local voice, as the call will sound.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const keys = vi.hoisted(() => ({ hume: false }));
const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../config/loader.js', async (orig) => ({
  ...(await orig<typeof import('../../config/loader.js')>()),
  getProviderCredential: (id: string) => (id === 'hume' && keys.hume ? 'stand-in-key' : null),
}));

const { runMigrations } = await import('../../db/migrations.js');
const { renderPhoneConduct } = await import('../assembler.js');

const CLOUD_FILLER = 'um, hmm, let me think';
const LOCAL_FILLER = 'local TTS speaks';
const call = 'Hello\nDirection: inbound';
const save = (key: string, value: string): void => {
  mockDb.current!.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
};

beforeEach(() => { keys.hume = false; mockDb.current = new Database(':memory:'); runMigrations(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the voice engine a call is coached for', () => {
  it('cloud chosen but no cloud voice picked: coached for the local voice', () => {
    keys.hume = true;
    save('voice.tts_engine', 'cloud');
    expect(renderPhoneConduct('phone', call, undefined)).toContain(LOCAL_FILLER);
  });

  it('cloud chosen, a cloud voice picked and a key saved: coached for the cloud voice', () => {
    keys.hume = true;
    save('voice.tts_engine', 'cloud');
    save('voice.cloud_voice', 'a-voice');
    expect(renderPhoneConduct('phone', call, undefined)).toContain(CLOUD_FILLER);
  });

  it('the engine the turn carries wins over the saved settings', () => {
    keys.hume = true;
    save('voice.tts_engine', 'cloud');
    save('voice.cloud_voice', 'a-voice');
    expect(renderPhoneConduct('phone', call, { latestUserSource: null, ttsEngine: 'local' })).toContain(LOCAL_FILLER);
  });
});
