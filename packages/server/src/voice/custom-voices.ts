/**
 * Custom Kokoro voicepack management.
 *
 * Users can fine-tune or otherwise produce their own Kokoro style vector
 * (.bin file) and import it here. Imported voices appear in the voice
 * picker next to the 28 built-ins.
 *
 * Storage layout (under VOICE_ROOT/custom/):
 *
 *   <id>.bin           — raw Float32 style vector, EXPECTED_VOICE_BYTES long
 *   <id>.json          — sidecar metadata { name, language, gender, createdAt }
 *
 * The voice id is the value that gets stored in `voice.preferred_voice` and
 * passed to KokoroTTS.generate(). It must follow Kokoro's [language][gender]_
 * prefix convention (e.g. `am_myvoice`) so kokoro-js's phonemizer picks the
 * right locale: first char a=en-US, b=en-GB; second char f=female, m=male.
 *
 * kokoro-js v1.2.1 hardcodes its voice registry (Object.freeze'd) and rejects
 * unknown ids in `_validate_voice`. installCustomVoicePatch() monkey-patches a
 * loaded KokoroTTS instance so the validator accepts our custom ids and the
 * synthesizer pulls the style tensor from our in-memory cache instead of the
 * built-in disk loader.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { VOICE_ROOT } from './model-manager.js';

const logger = createLogger('voice-custom');

/**
 * Bytes per voicepack for Kokoro-82M v1.0:
 *   510 token-length buckets × 256-dim style × 4 bytes per float32 = 522,240.
 * Measured against node_modules/kokoro-js/voices/am_michael.bin (2026-06-01).
 * Tied to the v1.0 weights; bump this if KOKORO_MODEL_ID ever moves to a new
 * style dim or bucket count.
 */
export const EXPECTED_VOICE_BYTES = 522_240;

export const CUSTOM_VOICE_DIR = path.join(VOICE_ROOT, 'custom');

const VOICE_ID_RE = /^[ab][fm]_[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;

const BUILTIN_VOICE_IDS = new Set([
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore',
  'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael',
  'am_onyx', 'am_puck', 'am_santa',
  'bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily',
  'bm_george', 'bm_lewis', 'bm_daniel', 'bm_fable',
]);

export interface CustomVoiceMeta {
  id: string;
  name: string;
  language: 'en-us' | 'en-gb';
  gender: 'Male' | 'Female';
  createdAt: string;
}

/** In-memory cache of style tensors, keyed by voice id. */
const styleCache = new Map<string, Float32Array>();

/** A loaded KokoroTTS instance that has had the patch applied. */
type PatchableKokoro = {
  _validate_voice: (voice: string) => string;
  generate_from_ids: (input_ids: unknown, opts?: { voice?: string; speed?: number }) => Promise<unknown>;
  __dojoCustomVoicePatched?: boolean;
  model: (inputs: Record<string, unknown>) => Promise<{ waveform: { data: Float32Array } }>;
};

function metaPath(id: string): string {
  return path.join(CUSTOM_VOICE_DIR, `${id}.json`);
}

function binPath(id: string): string {
  return path.join(CUSTOM_VOICE_DIR, `${id}.bin`);
}

export function isValidCustomVoiceId(id: string): boolean {
  return VOICE_ID_RE.test(id) && !BUILTIN_VOICE_IDS.has(id);
}

/** Read a .bin file off disk and check it parses to a finite Float32 vector. */
function validateVoiceBuffer(buf: Buffer): { ok: true } | { ok: false; error: string } {
  if (buf.length === 0) return { ok: false, error: 'file is empty' };
  if (buf.length !== EXPECTED_VOICE_BYTES) {
    return {
      ok: false,
      error: `not a valid voice file: expected ${EXPECTED_VOICE_BYTES} bytes, got ${buf.length}`,
    };
  }
  // The buffer might not be 4-byte aligned within its underlying ArrayBuffer
  // (Node's pooled allocator). Copy into a fresh ArrayBuffer to be safe before
  // viewing as Float32Array, otherwise the constructor throws RangeError.
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  const f = new Float32Array(ab);
  let finiteCount = 0;
  for (let i = 0; i < f.length; i++) {
    if (Number.isFinite(f[i])) finiteCount++;
  }
  if (finiteCount === 0) {
    return { ok: false, error: 'not a valid voice file: contains only NaN/Inf values' };
  }
  return { ok: true };
}

export function listCustomVoices(): CustomVoiceMeta[] {
  if (!fs.existsSync(CUSTOM_VOICE_DIR)) return [];
  const entries = fs.readdirSync(CUSTOM_VOICE_DIR);
  const out: CustomVoiceMeta[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -5);
    if (!isValidCustomVoiceId(id)) continue;
    if (!fs.existsSync(binPath(id))) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) as Partial<CustomVoiceMeta>;
      const language = raw.language === 'en-gb' ? 'en-gb' : 'en-us';
      const gender = raw.gender === 'Female' ? 'Female' : 'Male';
      out.push({
        id,
        name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : id,
        language,
        gender,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
      });
    } catch (err) {
      logger.warn('Skipping malformed custom voice metadata', { id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface InstallCustomVoiceOptions {
  id: string;
  name: string;
  language: 'en-us' | 'en-gb';
  gender: 'Male' | 'Female';
  binary: Buffer;
}

export function installCustomVoice(opts: InstallCustomVoiceOptions): CustomVoiceMeta {
  if (!isValidCustomVoiceId(opts.id)) {
    throw new Error(
      `Invalid voice id "${opts.id}". Use a lowercase id like am_myvoice (first char a=US b=GB, second char f=female m=male).`,
    );
  }
  if (typeof opts.name !== 'string' || opts.name.trim().length === 0) {
    throw new Error('Display name is required.');
  }
  const v = validateVoiceBuffer(opts.binary);
  if (!v.ok) throw new Error(v.error);

  fs.mkdirSync(CUSTOM_VOICE_DIR, { recursive: true });

  const meta: CustomVoiceMeta = {
    id: opts.id,
    name: opts.name.trim().slice(0, 80),
    language: opts.language,
    gender: opts.gender,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(binPath(opts.id), opts.binary);
  fs.writeFileSync(metaPath(opts.id), JSON.stringify(meta, null, 2));

  const ab = new ArrayBuffer(opts.binary.length);
  new Uint8Array(ab).set(opts.binary);
  styleCache.set(opts.id, new Float32Array(ab));

  logger.info('Installed custom voice', { id: opts.id, name: meta.name });
  return meta;
}

export function deleteCustomVoice(id: string): void {
  if (!isValidCustomVoiceId(id)) throw new Error(`Invalid voice id: ${id}`);
  styleCache.delete(id);
  fs.rmSync(binPath(id), { force: true });
  fs.rmSync(metaPath(id), { force: true });
  logger.info('Deleted custom voice', { id });
}

function loadStyleVector(id: string): Float32Array {
  const cached = styleCache.get(id);
  if (cached) return cached;
  const p = binPath(id);
  if (!fs.existsSync(p)) throw new Error(`Custom voice not found on disk: ${id}`);
  const buf = fs.readFileSync(p);
  const v = validateVoiceBuffer(buf);
  if (!v.ok) throw new Error(`Custom voice ${id} is corrupted: ${v.error}`);
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  const f = new Float32Array(ab);
  styleCache.set(id, f);
  return f;
}

/**
 * Patch a freshly-loaded KokoroTTS so it recognises our custom voice ids and
 * synthesises them using the on-disk style tensors instead of trying to hit
 * the kokoro-js bundled voices directory.
 *
 * Idempotent — calling it twice on the same instance is a no-op.
 *
 * Implementation notes:
 *   - kokoro-js v1.2.1's `_validate_voice` throws on unknown ids; we wrap it
 *     to short-circuit on our ids, returning the language-prefix char which
 *     drives downstream phonemizer locale selection.
 *   - `generate_from_ids` is the single internal call that turns input ids +
 *     a voice id into audio. We wrap it to look up our style vector when the
 *     id is custom, then run the model with the appropriate Tensor inputs.
 */
export async function installCustomVoicePatch(tts: unknown): Promise<void> {
  const inst = tts as PatchableKokoro;
  if (inst.__dojoCustomVoicePatched) return;

  // Lazy import so the patch module stays decoupled from how the caller
  // resolves transformers — and so we don't pin a specific subpath at the
  // top of the file.
  const transformers = await import('@huggingface/transformers');
  const Tensor = (transformers as unknown as { Tensor: new (kind: string, data: unknown, dims: number[]) => unknown }).Tensor;
  const RawAudio = (transformers as unknown as { RawAudio: new (data: Float32Array, sr: number) => unknown }).RawAudio;

  const origValidate = inst._validate_voice.bind(inst);
  inst._validate_voice = (voice: string): string => {
    if (isValidCustomVoiceId(voice) && fs.existsSync(binPath(voice))) {
      // Returning the first char matches the built-in path's behaviour: it
      // selects the phonemizer locale ('a' → en-us, anything else → en).
      return voice.charAt(0);
    }
    return origValidate(voice);
  };

  const origGenFromIds = inst.generate_from_ids.bind(inst);
  inst.generate_from_ids = async function (
    inputIds: unknown,
    opts: { voice?: string; speed?: number } = {},
  ): Promise<unknown> {
    const voice = opts.voice ?? 'af_heart';
    if (!(isValidCustomVoiceId(voice) && fs.existsSync(binPath(voice)))) {
      return origGenFromIds(inputIds, opts);
    }
    // Mirror the kokoro-js internal slice math: 256-dim style picked by the
    // input-id length (clamped to the 510 bucket range).
    const dims = (inputIds as { dims: number[] }).dims;
    const lastDim = dims[dims.length - 1];
    const sliceStart = 256 * Math.min(Math.max(lastDim - 2, 0), 509);
    const full = loadStyleVector(voice);
    const slice = full.slice(sliceStart, sliceStart + 256);

    const inputs: Record<string, unknown> = {
      input_ids: inputIds,
      style: new Tensor('float32', slice, [1, 256]),
      speed: new Tensor('float32', [opts.speed ?? 1], [1]),
    };
    const { waveform } = await inst.model(inputs);
    return new RawAudio(waveform.data, 24_000);
  };

  inst.__dojoCustomVoicePatched = true;
  logger.info('Applied custom-voice patch to Kokoro instance');
}
