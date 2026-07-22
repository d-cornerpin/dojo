// P8: voice session records + speaker stamps (migration 123).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import {
  startVoiceSessionRecord,
  endVoiceSessionRecord,
  bumpVoiceSessionTurnCount,
  getVoiceSessionIdForCall,
  stampSpokenMessage,
} from '../session-record.js';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE voice_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      external_id TEXT,
      conversation_id TEXT,
      stt_model TEXT,
      tts_engine TEXT,
      voice_id TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      end_reason TEXT,
      turn_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE messages (id TEXT PRIMARY KEY, speaker TEXT, voice_session_id TEXT);
  `);
  db.prepare("INSERT INTO messages (id) VALUES ('m1')").run();
  mockDb.current = db;
});

describe('voice session records (P8)', () => {
  it('start -> bump -> end writes a full lifecycle row', () => {
    const id = startVoiceSessionRecord({ agentId: 'a1', kind: 'dashboard', sttModel: 'moonshine-base', ttsEngine: 'local', voiceId: 'af_x' });
    expect(id).toBeTruthy();
    bumpVoiceSessionTurnCount(id);
    bumpVoiceSessionTurnCount(id);
    endVoiceSessionRecord(id, 'ws-closed');
    const row = mockDb.current!.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(id!) as Record<string, unknown>;
    expect(row.kind).toBe('dashboard');
    expect(row.turn_count).toBe(2);
    expect(row.ended_at).toBeTruthy();
    expect(row.end_reason).toBe('ws-closed');
  });

  it('a phone session resolves by callSid while open, and not after it ends', () => {
    const id = startVoiceSessionRecord({ agentId: 'a1', kind: 'phone', externalId: 'CA123' });
    expect(getVoiceSessionIdForCall('CA123')).toBe(id);
    endVoiceSessionRecord(id, 'hangup');
    expect(getVoiceSessionIdForCall('CA123')).toBeNull();
  });

  it('stampSpokenMessage sets speaker + session and keeps an existing session on null', () => {
    stampSpokenMessage('m1', 'owner', 'vs-1');
    let row = mockDb.current!.prepare("SELECT speaker, voice_session_id FROM messages WHERE id = 'm1'").get() as Record<string, unknown>;
    expect(row.speaker).toBe('owner');
    expect(row.voice_session_id).toBe('vs-1');
    // A later stamp with a null session keeps the original binding (COALESCE).
    stampSpokenMessage('m1', 'agent', null);
    row = mockDb.current!.prepare("SELECT speaker, voice_session_id FROM messages WHERE id = 'm1'").get() as Record<string, unknown>;
    expect(row.speaker).toBe('agent');
    expect(row.voice_session_id).toBe('vs-1');
  });

  it('never throws without a DB (best-effort contract)', () => {
    mockDb.current = null;
    expect(startVoiceSessionRecord({ agentId: 'a1', kind: 'dashboard' })).toBeNull();
    expect(() => endVoiceSessionRecord('x', 'r')).not.toThrow();
    expect(() => bumpVoiceSessionTurnCount('x')).not.toThrow();
    expect(getVoiceSessionIdForCall('CA1')).toBeNull();
    expect(() => stampSpokenMessage('m1', 'owner', null)).not.toThrow();
  });
});
