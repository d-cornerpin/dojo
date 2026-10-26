// Custom Kokoro voicepack management: import validation, listing, deletion and
// the runtime usability gate. installCustomVoicePatch is deliberately untested
// here — it needs the @huggingface/transformers package.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = vi.hoisted(() => ({ dir: (process.env.TMPDIR ?? '/tmp') + '/cv-test-' + process.pid }));
vi.mock('../model-manager.js', () => ({ VOICE_ROOT: root.dir }));

import {
  EXPECTED_VOICE_BYTES,
  PINNED_KOKORO_MODEL_ID,
  isValidCustomVoiceId,
  installCustomVoice,
  listCustomVoices,
  deleteCustomVoice,
  checkCustomVoiceUsable,
} from '../custom-voices.js';

const customDir = () => path.join(root.dir, 'custom');
const binPath = (id: string) => path.join(customDir(), `${id}.bin`);
const metaPath = (id: string) => path.join(customDir(), `${id}.json`);

/** A byte-valid pack: 522,240 zero bytes (zeros are finite, so it passes). */
const goodPack = () => Buffer.alloc(EXPECTED_VOICE_BYTES);

function writeSidecar(id: string, meta: unknown, binBytes = 3): void {
  fs.mkdirSync(customDir(), { recursive: true });
  fs.writeFileSync(binPath(id), Buffer.alloc(binBytes));
  fs.writeFileSync(metaPath(id), typeof meta === 'string' ? meta : JSON.stringify(meta));
}

beforeAll(() => {
  fs.rmSync(root.dir, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(root.dir, { recursive: true, force: true });
});

describe('custom voices', () => {
  it('lists nothing before anything is installed (custom folder does not exist)', () => {
    expect(listCustomVoices()).toEqual([]);
  });

  it('validates custom voice ids', () => {
    for (const id of ['am_myvoice', 'af_x', 'bm_a1', 'am_my-voice_2', 'af_heart2', 'am_' + 'a'.repeat(32)]) {
      expect(isValidCustomVoiceId(id)).toBe(true);
    }
    for (const id of [
      'am_', 'am_-x', 'am_x-', 'am_My', 'cm_x', 'ax_x', 'am-x', 'AM_x', 'am_x y', '../am_x',
      'am_x.bin', '', 'am_x\n', 'am_' + 'a'.repeat(33),
      'af_heart', 'am_michael', 'bf_emma', 'bm_fable',
    ]) {
      expect(isValidCustomVoiceId(id)).toBe(false);
    }
  });

  it('installs a good pack and writes both bin and json files', () => {
    const meta = installCustomVoice({
      id: 'am_first',
      name: '  First  ',
      language: 'en-us',
      gender: 'Male',
      binary: goodPack(),
    });
    expect(meta.id).toBe('am_first');
    expect(meta.name).toBe('First');
    expect(meta.language).toBe('en-us');
    expect(meta.gender).toBe('Male');
    expect(meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(fs.statSync(binPath('am_first')).size).toBe(EXPECTED_VOICE_BYTES);
    expect(JSON.parse(fs.readFileSync(metaPath('am_first'), 'utf8'))).toEqual(meta);
  });

  it('cuts a display name over 80 characters down to 80', () => {
    const meta = installCustomVoice({ id: 'am_long', name: 'L'.repeat(100), language: 'en-us', gender: 'Male', binary: goodPack() });
    expect(meta.name).toBe('L'.repeat(80));
  });

  it('refuses an invalid voice id', () => {
    expect(() =>
      installCustomVoice({ id: 'bad', name: 'X', language: 'en-us', gender: 'Male', binary: goodPack() }),
    ).toThrow(/Invalid voice id "bad"/);
    expect(fs.existsSync(binPath('bad'))).toBe(false);
    expect(fs.existsSync(metaPath('bad'))).toBe(false);
  });

  it('refuses a blank display name', () => {
    expect(() =>
      installCustomVoice({ id: 'am_noname', name: '   ', language: 'en-us', gender: 'Male', binary: goodPack() }),
    ).toThrow('Display name is required.');
    expect(fs.existsSync(binPath('am_noname'))).toBe(false);
    expect(fs.existsSync(metaPath('am_noname'))).toBe(false);
  });

  it('refuses wrong-size, empty and all-NaN packs, writing no files', () => {
    expect(() =>
      installCustomVoice({ id: 'am_tiny', name: 'T', language: 'en-us', gender: 'Male', binary: Buffer.alloc(10) }),
    ).toThrow('not a valid voice file: expected 522240 bytes, got 10');
    expect(() =>
      installCustomVoice({ id: 'am_empty', name: 'E', language: 'en-us', gender: 'Male', binary: Buffer.alloc(0) }),
    ).toThrow('file is empty');
    expect(() =>
      installCustomVoice({
        id: 'am_nan',
        name: 'N',
        language: 'en-us',
        gender: 'Male',
        binary: Buffer.from(new Float32Array(130560).fill(NaN).buffer),
      }),
    ).toThrow('not a valid voice file: contains only NaN/Inf values');
    for (const id of ['am_tiny', 'am_empty', 'am_nan']) {
      expect(fs.existsSync(binPath(id))).toBe(false);
      expect(fs.existsSync(metaPath(id))).toBe(false);
    }
  });

  it('accepts a right-size pack with one finite value among NaNs', () => {
    const floats = new Float32Array(130560).fill(NaN);
    floats[0] = 1;
    const meta = installCustomVoice({ id: 'am_mixed', name: 'Mixed', language: 'en-us', gender: 'Male', binary: Buffer.from(floats.buffer) });
    expect(meta.id).toBe('am_mixed');
  });

  it('lists installed voices sorted by name', () => {
    installCustomVoice({ id: 'am_zeta', name: 'Zeta', language: 'en-us', gender: 'Male', binary: goodPack() });
    installCustomVoice({ id: 'am_alpha', name: 'Alpha', language: 'en-us', gender: 'Male', binary: goodPack() });
    const names = listCustomVoices().map((v) => v.name);
    expect(names.indexOf('Alpha')).toBeLessThan(names.indexOf('Zeta'));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('skips junk sidecars and defaults bad metadata', () => {
    // A .json whose id has no .bin is skipped.
    fs.mkdirSync(customDir(), { recursive: true });
    fs.writeFileSync(metaPath('am_orphan'), JSON.stringify({ id: 'am_orphan', name: 'Orphan', language: 'en-us', gender: 'Male' }));
    // bad id, bad-case id and a built-in id are skipped even with a .bin.
    for (const id of ['bad', 'Bad_Id', 'af_heart']) {
      writeSidecar(id, { id, name: id, language: 'en-us', gender: 'Male' });
    }
    // A .bin whose .json does not parse is skipped.
    writeSidecar('am_junk', 'not json');
    // Bad metadata defaults: empty name -> id, unknown language/gender -> en-us/Male.
    writeSidecar('am_sidecar', { name: '', language: 'fr', gender: 'x' });
    // Good metadata is kept as given.
    writeSidecar('am_keep', { language: 'en-gb', gender: 'Female', name: 'N', createdAt: '2026-01-01T00:00:00.000Z' });

    const list = listCustomVoices();
    const ids = list.map((v) => v.id);
    expect(ids).not.toContain('am_orphan');
    expect(ids).not.toContain('bad');
    expect(ids).not.toContain('Bad_Id');
    expect(ids).not.toContain('af_heart');
    expect(ids).not.toContain('am_junk');

    const sidecar = list.find((v) => v.id === 'am_sidecar')!;
    expect(sidecar.name).toBe('am_sidecar');
    expect(sidecar.language).toBe('en-us');
    expect(sidecar.gender).toBe('Male');
    expect(sidecar.createdAt).toBe(new Date(0).toISOString());

    const keep = list.find((v) => v.id === 'am_keep')!;
    expect(keep.name).toBe('N');
    expect(keep.language).toBe('en-gb');
    expect(keep.gender).toBe('Female');
    expect(keep.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('deletes an installed voice and its files', () => {
    deleteCustomVoice('am_zeta');
    expect(fs.existsSync(binPath('am_zeta'))).toBe(false);
    expect(fs.existsSync(metaPath('am_zeta'))).toBe(false);
    expect(listCustomVoices().map((v) => v.id)).not.toContain('am_zeta');
  });

  it('deleting an id that has no files does not throw', () => {
    expect(() => deleteCustomVoice('am_none')).not.toThrow();
  });

  it('deleting an invalid id throws', () => {
    expect(() => deleteCustomVoice('bad')).toThrow('Invalid voice id: bad');
  });

  it('gate: built-in and invalid ids are always usable', () => {
    expect(checkCustomVoiceUsable('af_heart', 'other-model')).toEqual({ ok: true });
    expect(checkCustomVoiceUsable('bad', 'other-model')).toEqual({ ok: true });
  });

  it('gate: a custom id with a mismatched live model is disabled', () => {
    const r = checkCustomVoiceUsable('am_gate', 'other-model');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('onnx-community/Kokoro-82M-v1.0-ONNX');
    expect(r.reason).toContain('the live model is other-model');
  });

  it('gate: an installed id with the pinned model is usable', () => {
    installCustomVoice({ id: 'am_pinned', name: 'Pinned', language: 'en-us', gender: 'Male', binary: goodPack() });
    expect(checkCustomVoiceUsable('am_pinned', PINNED_KOKORO_MODEL_ID)).toEqual({ ok: true });
  });

  it('gate: a never-installed custom id with the pinned model reports missing', () => {
    expect(checkCustomVoiceUsable('am_gone', PINNED_KOKORO_MODEL_ID)).toEqual({
      ok: false,
      reason: 'Custom voice not found on disk: am_gone',
    });
  });

  it('gate: a corrupted pack with the pinned model reports corruption', () => {
    writeSidecar('am_bad', { id: 'am_bad', name: 'Bad', language: 'en-us', gender: 'Male' });
    const r = checkCustomVoiceUsable('am_bad', PINNED_KOKORO_MODEL_ID);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('Custom voice am_bad is corrupted: not a valid voice file: expected 522240 bytes, got 3');
  });
});
