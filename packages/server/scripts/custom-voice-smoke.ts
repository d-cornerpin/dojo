#!/usr/bin/env tsx
/**
 * Smoke-test the Phase 2 custom-voice path.
 *
 * 1. Copies a built-in voicepack (am_michael) into the import area as
 *    `am_smoke` so we exercise the full validation + monkey-patch chain
 *    without needing an externally-trained voicepack on hand.
 * 2. Calls synthesizeOnce with the custom voice id and checks the WAV
 *    comes back non-empty.
 * 3. Reads back the voice list and confirms am_smoke is in there.
 * 4. Deletes it and confirms it's gone.
 *
 * Usage:
 *   npx tsx packages/server/scripts/custom-voice-smoke.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installCustomVoice,
  deleteCustomVoice,
  EXPECTED_VOICE_BYTES,
} from '../src/voice/custom-voices.js';
import { synthesizeOnce, listVoices } from '../src/voice/tts-service.js';
import { loadSecrets } from '../src/config/loader.js';

async function main(): Promise<void> {
  await loadSecrets();

  // kokoro-js ships its voicepacks alongside its dist; we need a known-good
  // .bin to import. Walk up from this file to the repo root, then into
  // node_modules/kokoro-js/voices/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const builtIn = path.resolve(here, '../../..', 'node_modules/kokoro-js/voices/am_michael.bin');
  if (!fs.existsSync(builtIn)) {
    throw new Error(`Expected built-in voice file at ${builtIn}`);
  }
  const buf = fs.readFileSync(builtIn);
  if (buf.length !== EXPECTED_VOICE_BYTES) {
    throw new Error(`Built-in voice byte size mismatch: ${buf.length} vs pinned ${EXPECTED_VOICE_BYTES}`);
  }

  const id = 'am_smoke';
  console.log(`[smoke] installing custom voice "${id}"...`);
  const meta = installCustomVoice({
    id,
    name: 'Smoke Test',
    language: 'en-us',
    gender: 'Male',
    binary: buf,
  });
  console.log('[smoke] meta:', meta);

  const voices = listVoices();
  const found = voices.find((v) => v.id === id);
  if (!found) throw new Error('Custom voice did not appear in listVoices()');
  if (!('custom' in found) || found.custom !== true) {
    throw new Error('Custom voice missing custom:true flag');
  }
  console.log(`[smoke] listVoices() includes ${id}: ${found.name}`);

  console.log('[smoke] synthesizing with custom voice...');
  const start = Date.now();
  const { wav, pcm } = await synthesizeOnce('Hello from the custom voice path.', id);
  console.log(`[smoke] wav bytes=${wav.length} samples=${pcm.length} ${Date.now() - start}ms`);
  if (wav.length < 1000) throw new Error('WAV too small — synthesis likely failed');
  if (pcm.length < 1000) throw new Error('PCM too small — synthesis likely failed');

  console.log('[smoke] deleting custom voice...');
  deleteCustomVoice(id);
  const after = listVoices().find((v) => v.id === id);
  if (after) throw new Error('Custom voice survived delete');

  console.log('[smoke] OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] ERROR:', err);
  process.exit(1);
});
