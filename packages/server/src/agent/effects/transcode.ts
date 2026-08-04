// ════════════════════════════════════════════════════════════════════════════
// THE TEMP-WORKSPACE CARRY (PHASE-5 T8 Step 3, RULING P5-R15 ADDENDUM 4(1)).
//
// Mechanic 6's principle, one step wider. `effects/fs.ts`'s `atomicWriteFile`
// owns a temp SIBLING of a path the call declared; these two own a temp PAIR in
// the platform's own temp directory, which **no declaration in this platform can
// name**: `expandScopeTemplate` expands `~`, `<agentId>` and `{args.<dotted>}`
// and the temp directory is none of the three. So the mechanism moved in here
// WHOLE — same names, same order, same cleanup, the errors rethrown unchanged —
// and the temp pair is this layer's own implementation detail rather than a
// second grant. Requiring one would mean a declaration had to describe two files
// the tool does not name, the user never sees, and the platform picks.
//
// WHAT THE CALL DECLARES IS THE PROGRAM. `ffmpeg` rides RULING P5-R14 branch
// (B): the argv is built here and nothing honest can be said about it before the
// handler runs, so the capability carries the PROGRAM — which is what proves
// gate-loop provenance — and `scopes.ts`'s `CARRIED_PROGRAMS` names it with its
// reason, held by a census. A tool that has not declared it gets no grant and
// the spawn refuses.
//
// TWO ENTRIES, NOT ONE, AND DELIBERATELY UNBLENDED — the same judgement the
// slides style writer got beside `atomicWriteFile`. The decode and the video
// demux differ in their argv (`-vn`), in their temp names and in the exact
// wording of their exit errors, and those strings reach the model through the
// caller's own `catch`. Merging them would change one caller's behaviour to
// match the other's, which a relocation may never do.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnAuthorized } from './proc.js';

// Decode an arbitrary audio buffer (mp3, m4a, opus, etc.) to 16kHz
// mono 16-bit PCM WAV via ffmpeg. Both Moonshine and the whisper.cpp
// engines expect RIFF/WAVE PCM in this shape; phone-mode bypasses
// this because Twilio already streams raw PCM, but uploaded files
// can be anything.
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

// Extract the audio track from a video buffer as 16-bit PCM WAV. The
// caller hands this wav buffer onward — local engines see it as
// already-PCM and skip their own ffmpeg pass; cloud providers accept
// wav uniformly.
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
