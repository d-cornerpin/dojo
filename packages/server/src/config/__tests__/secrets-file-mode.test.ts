// PHASE-5 T6C — the platform secrets file keeps owner-only permissions, on
// every write and on every load, not only on the write that created it.
//
// THE REQUIREMENT: `~/.dojo/secrets.yaml` holds the credential master key in
// the clear. `agent/brokers/deny.ts`'s `dojo-secrets-store` row states its own
// reason as "protected only by 0600 and by this deny" — so the mode is one of
// the two protections that row names, and it has to be true rather than
// intended. The installer sets it at creation (`deploy/install.sh`) and the
// machine-migration import re-asserts it (`migration/import.ts`), but nothing
// re-asserted it afterwards: `fs.writeFileSync(..., { mode })` applies the mode
// only when it CREATES the file, so every later rewrite inherits whatever the
// file already carried.
//
// WHAT THIS HOLDS: the loader is the one writer, so the loader is where the
// mode is re-asserted — on save, and on load when the file is found looser
// than owner-only. The repair is best-effort by design: a filesystem that
// cannot chmod (a mounted share, an alien volume) must not take the boot down
// with it, so the failure path is asserted here too.
//
// TEST HYGIENE: `os.homedir()` is redirected to a throwaway temp directory.
// These tests never read, write or chmod the real `~/.dojo`. Every value
// written here is a literal this file made up; no real secret appears.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-mode-home-'));
fs.mkdirSync(path.join(fixtureHome, '.dojo'), { recursive: true });
const SECRETS = path.join(fixtureHome, '.dojo', 'secrets.yaml');

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: () => fixtureHome }, homedir: () => fixtureHome };
});

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { loadSecrets, saveSecrets, clearSecretsCache } = await import('../loader.js');

/** Permission bits only — the type/format bits are not what this asserts. */
function modeOf(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

const FIXTURE: Parameters<typeof saveSecrets>[0] = {
  jwt_secret: 'not-a-real-secret-fixture-value',
  providers: {},
};

describe('PHASE-5 T6C: ~/.dojo/secrets.yaml keeps owner-only permissions', () => {
  beforeEach(() => {
    clearSecretsCache();
    if (fs.existsSync(SECRETS)) fs.rmSync(SECRETS);
    vi.restoreAllMocks();
  });

  afterAll(() => {
    fs.rmSync(fixtureHome, { recursive: true, force: true });
  });

  // The positive control. This one passed before the repair: it is what proves
  // clause 2 is measuring the REWRITE case and not a broken mode argument.
  it('creates the file owner-only', () => {
    saveSecrets(FIXTURE);
    expect(modeOf(SECRETS)).toBe(0o600);
  });

  it('re-asserts owner-only when the file already exists more open (the case the mode argument cannot reach)', () => {
    fs.writeFileSync(SECRETS, 'jwt_secret: pre-existing-fixture\n');
    fs.chmodSync(SECRETS, 0o644);
    expect(modeOf(SECRETS)).toBe(0o644); // the state a real box was found in

    saveSecrets(FIXTURE);

    expect(modeOf(SECRETS)).toBe(0o600);
  });

  it('repairs a loosened mode on load, so a box that was found open does not stay open until its next write', () => {
    saveSecrets(FIXTURE);
    fs.chmodSync(SECRETS, 0o644);
    clearSecretsCache();

    loadSecrets();

    expect(modeOf(SECRETS)).toBe(0o600);
  });

  it('leaves an already-tight file alone (no needless chmod on the hot load path)', () => {
    saveSecrets(FIXTURE);
    fs.chmodSync(SECRETS, 0o400); // tighter than required is the owner's business
    clearSecretsCache();

    loadSecrets();

    expect(modeOf(SECRETS)).toBe(0o400);
  });

  it('still loads when the filesystem refuses the chmod — the repair is best-effort, never a boot failure', () => {
    saveSecrets(FIXTURE);
    fs.chmodSync(SECRETS, 0o644);
    clearSecretsCache();
    const spy = vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw new Error('EPERM: operation not permitted (fixture)');
    });

    const secrets = loadSecrets();

    expect(secrets.jwt_secret).toBe(FIXTURE.jwt_secret);
    expect(spy).toHaveBeenCalled();
  });

  it('still saves when the filesystem refuses the chmod', () => {
    saveSecrets(FIXTURE);
    fs.chmodSync(SECRETS, 0o644);
    const spy = vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw new Error('EPERM: operation not permitted (fixture)');
    });

    expect(() => saveSecrets({ ...FIXTURE, jwt_secret: 'second-fixture-value' })).not.toThrow();
    expect(spy).toHaveBeenCalled();
    clearSecretsCache();
    expect(loadSecrets().jwt_secret).toBe('second-fixture-value');
  });
});
