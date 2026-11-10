// THE TEMP-WORKSPACE CARRY: a temp PAIR in the platform's own temp dir, which no scope template can name, so
// it is this layer's implementation detail, never a second grant: a declaration describes the effect, not
// the mechanism. WHAT THE CALL DECLARES IS THE PROGRAM (ffmpeg): CARRIED_PROGRAMS in scopes.ts names it,
// held by a census; no declaration, no grant. TWO ENTRIES, DELIBERATELY UNBLENDED: they differ in argv
// (`-vn`), temp names and the exit-error wording that reaches the model through the caller's own `catch`.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnAuthorized } from './proc.js';

// Decode any audio buffer to 16kHz mono 16-bit WAV: both local STT engines expect RIFF/WAVE in this shape.
export async function decodeToWav16kMono(bytes: Buffer, sourceExt: string): Promise<Buffer> {
  const inPath = path.join(os.tmpdir(), `dojo-stt-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${sourceExt || '.bin'}`);
  const outPath = path.join(os.tmpdir(), `dojo-stt-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  fs.writeFileSync(inPath, bytes);
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawnAuthorized('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-i', inPath,
        '-ar', '16000',  // 16 kHz sample rate (Whisper / Moonshine default)
        '-ac', '1',       // mono
        '-c:a', 'pcm_s16le', // signed 16-bit little-endian PCM
        outPath,
      ]);
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('error', (err) => reject(new Error(`ffmpeg failed to spawn: ${err.message}`)));
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 400)}`));
      });
    });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.unlinkSync(inPath); } catch { /* tmp cleanup is best-effort */ }
    try { fs.unlinkSync(outPath); } catch { /* tmp cleanup is best-effort */ }
  }
}

// Extract the audio track of a video buffer as 16-bit PCM WAV: local engines skip their own ffmpeg pass.
export async function extractAudioFromVideo(bytes: Buffer, sourceExt: string): Promise<Buffer> {
  const inPath = path.join(os.tmpdir(), `dojo-stt-vid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${sourceExt || '.bin'}`);
  const outPath = path.join(os.tmpdir(), `dojo-stt-vid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  fs.writeFileSync(inPath, bytes);
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawnAuthorized('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-i', inPath,
        '-vn',            // strip video stream
        '-ar', '16000',   // 16 kHz (Whisper / Moonshine default)
        '-ac', '1',        // mono
        '-c:a', 'pcm_s16le',
        outPath,
      ]);
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('error', (err) => reject(new Error(`ffmpeg failed to spawn: ${err.message}`)));
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg video demux exited ${code}: ${stderr.slice(0, 400)}`));
      });
    });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.unlinkSync(inPath); } catch { /* tmp cleanup is best-effort */ }
    try { fs.unlinkSync(outPath); } catch { /* tmp cleanup is best-effort */ }
  }
}
