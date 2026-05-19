#!/usr/bin/env tsx
/**
 * Voice round-trip smoke test.
 *
 * 1. Synthesizes "hello world, this is the dojo voice test" via Kokoro
 * 2. Writes the WAV to /tmp/voice-rt.wav
 * 3. Sends that WAV to whisper-server for transcription
 * 4. Prints the transcribed text and round-trip timing
 *
 * Usage (from cornerpin-platform/):
 *   npx tsx packages/server/scripts/voice-roundtrip.ts
 *
 * First run downloads whisper model (~570MB) and Kokoro model (~330MB).
 */

import fs from 'node:fs';
import { synthesizeOnce } from '../src/voice/tts-service.js';
import { transcribeBuffer, stopWhisperServer } from '../src/voice/stt-service.js';

const PHRASE = 'Hello world, this is the dojo voice test.';
const OUT_WAV = '/tmp/voice-rt.wav';

async function main() {
  console.log(`[voice-rt] synthesizing: "${PHRASE}"`);
  const ttsStart = Date.now();
  const result = await synthesizeOnce(PHRASE);
  const ttsMs = Date.now() - ttsStart;
  fs.writeFileSync(OUT_WAV, result.wav);
  console.log(`[voice-rt] TTS done in ${ttsMs}ms — wrote ${result.wav.length} bytes to ${OUT_WAV}`);
  console.log(`[voice-rt]   sample rate: ${result.sampleRate} Hz, samples: ${result.pcm.length}`);

  console.log('[voice-rt] transcribing via whisper-server...');
  const sttStart = Date.now();
  const trans = await transcribeBuffer(result.wav);
  const sttMs = Date.now() - sttStart;
  console.log(`[voice-rt] STT done in ${sttMs}ms (internal: ${trans.durationMs}ms)`);
  console.log(`[voice-rt] transcribed text: "${trans.text}"`);

  const cleaned = trans.text.toLowerCase().replace(/[^a-z ]/g, '').trim();
  const match = cleaned.includes('hello world') && cleaned.includes('dojo');
  console.log(`[voice-rt] match: ${match ? 'PASS' : 'FAIL'}`);

  await stopWhisperServer();
  process.exit(match ? 0 : 1);
}

main().catch((err) => {
  console.error('[voice-rt] ERROR:', err);
  process.exit(2);
});
