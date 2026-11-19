// The voice models answer lists what the saved engines still need on disk, voice first, so every setup
// screen and the voice button download the speech model the owner chose.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const disk = vi.hoisted(() => ({ on: new Set<string>() }));
const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('hume', () => ({ HumeClient: class {} }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../model-manager.js', async (orig) => {
  const real = await orig<typeof import('../model-manager.js')>();
  return {
    ...real,
    listInstalledModels: () => [
      { kind: 'whisper', id: 'base.en', filename: 'f', bytes: 0, installed: disk.on.has('base.en') },
      { kind: 'kokoro', id: real.KOKORO_MODEL_ID, filename: 'f', bytes: 0, installed: disk.on.has('kokoro') },
      { kind: 'moonshine', id: real.MOONSHINE_MODEL_ID, filename: 'f', bytes: 0, installed: disk.on.has('moonshine') },
    ],
  };
});

const { runMigrations } = await import('../../db/migrations.js');
const { voiceRouter } = await import('../voice-routes.js');

beforeEach(() => { disk.on.clear(); mockDb.current = new Database(':memory:'); runMigrations(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const missing = async (): Promise<string[]> => {
  const body = await (await voiceRouter.request('/models')).json() as { data: { missing: Array<{ kind: string; id: string }> } };
  return body.data.missing.map((m) => `${m.kind}/${m.id}`);
};

describe('what the saved voice engines still need', () => {
  it('a fresh box needs the local voice, then the default speech model', async () => {
    expect(await missing()).toEqual(['kokoro/onnx-community/Kokoro-82M-v1.0-ONNX', 'moonshine/moonshine-base']);
  });

  it('a saved Whisper size is the speech model that is needed', async () => {
    disk.on.add('kokoro');
    mockDb.current!.prepare("INSERT INTO config (key, value) VALUES ('voice.stt_model', 'base.en')").run();
    expect(await missing()).toEqual(['whisper/base.en']);
  });

  it('nothing is needed when the voice and the saved speech model are on disk', async () => {
    disk.on.add('kokoro');
    disk.on.add('moonshine');
    expect(await missing()).toEqual([]);
  });
});
