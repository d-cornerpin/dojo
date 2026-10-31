// 709 — a WAV is handed straight to the local speech engines only when it really is
// 16 kHz mono 16-bit PCM. Any other WAV (44.1/48 kHz, stereo, 24-bit, float, damaged) goes
// through the existing ffmpeg conversion. ffmpeg and the speech engines are mocks.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sttMock = vi.hoisted(() => vi.fn(async (_a: Buffer, _o: unknown) => ({ text: 'ok', durationMs: 1 })));
const decodeMock = vi.hoisted(() => vi.fn());

vi.mock('../../voice/stt-service.js', () => ({
  transcribeBuffer: sttMock,
  isWhisperBinaryAvailable: (): boolean => true,
}));
vi.mock('../../voice/model-manager.js', () => ({ DEFAULT_WHISPER: 'base.en' }));
vi.mock('../transcription-model.js', () => ({
  getEffectiveTranscriptionModel: (): unknown => ({ kind: 'local', localEngine: 'whisper' }),
}));
vi.mock('../../agent/effects/transcode.js', () => ({
  decodeToWav16kMono: decodeMock,
  extractAudioFromVideo: vi.fn(),
}));

const { transcribeAudio } = await import('../transcription.js');

function makeWav(sampleRate: number, channels: number, bits: number, numSamples: number, extraChunkBeforeFmt = false): Buffer {
  const blockAlign = channels * (bits / 8);
  const dataLen = numSamples * blockAlign;
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii'); fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(channels, 10); fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * blockAlign, 16); fmt.writeUInt16LE(blockAlign, 20); fmt.writeUInt16LE(bits, 22);
  const list = Buffer.alloc(8 + 5 + 1); // odd-sized body, padded to even
  list.write('LIST', 0, 'ascii'); list.writeUInt32LE(5, 4);
  const data = Buffer.alloc(8 + dataLen);
  data.write('data', 0, 'ascii'); data.writeUInt32LE(dataLen, 4);
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...(extraChunkBeforeFmt ? [list] : []), fmt, data]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
const run = (audio: Buffer) => transcribeAudio({ audio, mimeType: 'audio/wav', filename: 'a.wav', agentId: 'a1' });

beforeEach(() => {
  sttMock.mockClear();
  decodeMock.mockReset();
  decodeMock.mockImplementation(async () => makeWav(16000, 1, 16, 100));
});

describe('709 only real 16 kHz mono 16-bit PCM skips the conversion', () => {
  it('16 kHz mono 16-bit goes straight through', async () => {
    const wav = makeWav(16000, 1, 16, 100);
    await run(wav);
    expect(decodeMock).not.toHaveBeenCalled();
    expect(sttMock).toHaveBeenCalledTimes(1);
    expect(sttMock.mock.calls[0][0]).toBe(wav);
  });
  it('44.1 kHz mono is converted', async () => { await run(makeWav(44100, 1, 16, 100)); expect(decodeMock).toHaveBeenCalledTimes(1); });
  it('16 kHz stereo is converted', async () => { await run(makeWav(16000, 2, 16, 100)); expect(decodeMock).toHaveBeenCalledTimes(1); });
  it('16 kHz mono 24-bit is converted', async () => { await run(makeWav(16000, 1, 24, 100)); expect(decodeMock).toHaveBeenCalledTimes(1); });
  it('an extra chunk before fmt does not hide a good format', async () => {
    await run(makeWav(16000, 1, 16, 100, true));
    expect(decodeMock).not.toHaveBeenCalled();
  });
  it('a truncated header is converted and nothing throws out of the check', async () => {
    const stub = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WAVE', 'ascii'), Buffer.alloc(8)]);
    expect(stub.length).toBe(20);
    const r = await run(stub);
    expect(decodeMock).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });
});
