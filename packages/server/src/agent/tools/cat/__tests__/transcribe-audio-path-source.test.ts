// THE `transcribe_audio` PATH SOURCE: AUDITED, AND TILDE-HONEST.
//
// Two defects in one handler, both about the `path` source:
//   * The audit line spelled every non-attachment source `url ${urlArg}`, so a `path`
//     read (and a `file://` url, which becomes one) logged "Source url undefined" with
//     a null target — the operator's audit log could not show WHICH file was transcribed.
//   * `path.resolve` does not expand `~`, so `~/.dojo/uploads/a.mp3` — the spelling the
//     tool description teaches, and the one every sibling file tool accepts through
//     `resolvePath` — resolved against the server cwd and was refused.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };

// The scratch home `homeDir()` answers, rebound per case.
const homeRef = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-transcribe-audio-path-test', 'dojo.db'),
  };
});

vi.mock('../../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../../home.js', async (orig) => ({
  ...(await orig()),
  homeDir: () => homeRef.dir,
}));

vi.mock('../../../../services/transcription.js', () => ({
  resolveAttachmentPath: vi.fn(),
  fetchAudioUrl: vi.fn(),
  transcribeAudio: vi.fn(),
}));

// OR-AUDIT-ANSWERS (the owner removed this fence for the main agent): 'main' is the main agent here.
vi.mock('../../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../../config/platform.js')>()),
  isPrimaryAgent: (id: string) => id === 'main',
}));

vi.mock('../../util.js', async (orig) => ({
  ...(await orig()),
  auditLog: vi.fn(),
}));

// The effects facade performs I/O only inside a gate-loop-authorized call; this suite
// calls the handler directly, so it is backed by the real fs here.
vi.mock('../../../effects/fs.js', () => ({
  existsSync: (target: fs.PathLike) => fs.existsSync(target),
  readFileSync: (target: fs.PathLike) => fs.readFileSync(target),
}));

import { mediaHandlers } from '../media.js';
import { auditLog } from '../../util.js';
import { resolveAttachmentPath, transcribeAudio } from '../../../../services/transcription.js';

const auditSpy = vi.mocked(auditLog);

let audioPath = '';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  homeRef.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-transcribe-audio-'));
  const uploads = path.join(homeRef.dir, '.dojo', 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  audioPath = path.join(uploads, 'a.mp3');
  fs.writeFileSync(audioPath, Buffer.from('FAKE-AUDIO-BYTES'));

  vi.mocked(resolveAttachmentPath).mockReturnValue({ path: audioPath, filename: 'a.mp3', mimeType: 'audio/mpeg' });
  vi.mocked(transcribeAudio).mockResolvedValue({
    ok: true, text: 'hello', apiModelId: 'm', providerId: 'p',
    costMode: 'local', durationSeconds: 1, latencyMs: 1,
  });
  auditSpy.mockClear();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(homeRef.dir, { recursive: true, force: true });
});

async function callTranscribe(args: Record<string, unknown>, agentId = 'a1') {
  return mediaHandlers.transcribe_audio({
    agentId, name: 'transcribe_audio', args, callId: 'c', toolCall: {} as never,
  });
}

/** The transcribe audit row the call wrote: its target and its detail. */
function auditRow(): { target: string | null; detail: string | undefined } {
  const call = auditSpy.mock.calls.find((c) => c[1] === 'transcribe_audio');
  expect(call, 'no transcribe_audio audit row').toBeDefined();
  return { target: call![2] ?? null, detail: call![4] };
}

describe('transcribe_audio path source', () => {
  it('audits a path source by name', async () => {
    const out = await callTranscribe({ path: audioPath });
    expect(out.isError).toBe(false);
    const { detail } = auditRow();
    expect(detail).toContain(`path ${audioPath}`);
    expect(detail).not.toContain('undefined');
  });

  it('names the transcribed file as the audit target', async () => {
    const out = await callTranscribe({ path: audioPath });
    expect(out.isError).toBe(false);
    const { target } = auditRow();
    expect(target).not.toBeNull();
    expect(target).toContain('a.mp3');
  });

  it('accepts a ~/ path inside ~/.dojo/uploads', async () => {
    const out = await callTranscribe({ path: '~/.dojo/uploads/a.mp3' });
    expect(out.isError).toBe(false);
  });

  it('OR-AUDIT-ANSWERS: the MAIN agent transcribes an audio file anywhere on the Mac', async () => {
    const desk = path.join(homeRef.dir, 'Desktop');
    fs.mkdirSync(desk, { recursive: true });
    fs.writeFileSync(path.join(desk, 'meeting.m4a'), Buffer.from('FAKE-AUDIO-BYTES'));
    const out = await callTranscribe({ path: '~/Desktop/meeting.m4a' }, 'main');
    expect(out.isError, out.content).toBe(false);
  });

  it('OR-AUDIT-ANSWERS (a) "Keep secrets hidden": even the main agent may not hand a key file to the transcriber', async () => {
    const ssh = path.join(homeRef.dir, '.ssh');
    fs.mkdirSync(ssh, { recursive: true });
    fs.writeFileSync(path.join(ssh, 'id_ed25519'), 'KEY');
    const out = await callTranscribe({ path: '~/.ssh/id_ed25519' }, 'main');
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/sensitive-files block list/);
  });

  it('still refuses a path outside the uploads dir (an agent other than the main agent)', async () => {
    const out = await callTranscribe({ path: '/etc/hosts' });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('must be inside ~/.dojo/uploads/');
  });

  it('audits an attachment source unchanged', async () => {
    const out = await callTranscribe({ attachment_id: 'att-7' });
    expect(out.isError).toBe(false);
    const { detail } = auditRow();
    expect(detail).toContain('attachment ');
    expect(detail).toContain('att-7');
  });
});
