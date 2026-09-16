// ════════════════════════════════════════════════════════════════════════════════
// A TEST CAN NEVER TOUCH THE DEVELOPER'S REAL ~/.dojo AGAIN.
//
// ── THE INCIDENT ──
// 2026-09-16. `packages/server/package.json` ran a bare `vitest run` with no config
// file anywhere in the repo — no setupFiles, no globalSetup, no HOME redirection —
// and 111 `os.homedir()` call sites across 55 files each resolved the real home for
// themselves. One full-suite run therefore wrote into the OWNER'S account: 369
// migration boots, ~123,000 log lines, 30 share bundles, a `secrets.yaml`. The
// logger's rotation keeps one backup and rotates by unlink-then-rename on a
// PER-PROCESS throttle, so ~30 workers crossing 10 MB at once deleted and replaced
// that one backup repeatedly, and the real server's entire log history — the only
// durable record of what it had done — was destroyed by its own test suite.
//
// Two things had to be true for that, and this file asserts both are now false:
//   1. home was resolvable in 111 places instead of one  → the static clause;
//   2. nothing objected when a test resolved the real one → the runtime clause.
//
// This is the tripwire that would have caught it years earlier.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir, dojoDir, isTestRun } from '../home.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const SRC = path.resolve(path.dirname(THIS_FILE), '..');
const HOME_TS = path.join(SRC, 'home.ts');

// Two files may name `os.homedir()`: the one place that resolves it, and this one —
// which has to call it to prove the tripwire fires. Nothing else, ever.
const ALLOWED_TO_NAME_HOMEDIR = new Set([HOME_TS, THIS_FILE]);

function everyTsFile(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) everyTsFile(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// ── THE STATIC CLAUSE ──
// Grep is the only instrument that can see a call site nobody executes. A new
// `os.homedir()` in a rarely-taken branch would pass every runtime guard in this
// repo until the day it ran — on somebody's real home.
describe('home is resolved in exactly one place', () => {
  const files = everyTsFile(SRC);

  it('scanned the whole source tree, not an empty list', () => {
    // Vacuity guard: a scan that finds nothing reports a clean sweep, which is the
    // exact failure shape this file exists to prevent.
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain(HOME_TS);
  });

  it('no file under packages/server/src calls os.homedir() except home.ts', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOWED_TO_NAME_HOMEDIR.has(f)) continue;
      const src = fs.readFileSync(f, 'utf-8');
      // Strip line comments so the prose in this very file (and in the headers that
      // explain the incident) is not counted as a call.
      const code = src.replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, '');
      if (/\bhomedir\s*\(/.test(code)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it('no production file reads process.env.HOME for itself', () => {
    // `HOME` is the operating system's variable and several tests legitimately set
    // it when they drive a child process. Production code must go through
    // homeDir(), so that DOJO_HOME is the single lever.
    const offenders: string[] = [];
    for (const f of files) {
      if (f === HOME_TS || f.includes('__tests__') || f.endsWith('.test.ts')) continue;
      const code = fs.readFileSync(f, 'utf-8').replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, '');
      if (/process\.env\.(?:HOME|USERPROFILE)\b/.test(code)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it('the suite carries a vitest config, a global setup and a per-worker setup file', () => {
    // The original defect was as much an ABSENCE as a bug: `vitest run` with no
    // config at all. If these files disappear, the isolation disappears silently.
    const pkg = path.resolve(SRC, '..');
    expect(fs.existsSync(path.join(pkg, 'vitest.config.ts'))).toBe(true);
    expect(fs.existsSync(path.join(pkg, 'vitest.setup.ts'))).toBe(true);
    expect(fs.existsSync(path.join(pkg, 'vitest.global-setup.ts'))).toBe(true);
    const cfg = fs.readFileSync(path.join(pkg, 'vitest.config.ts'), 'utf-8');
    expect(cfg).toContain('setupFiles');
    expect(cfg).toContain('globalSetup');
  });
});

// ── THE RUNTIME CLAUSE ──
describe('the running suite is somewhere else entirely', () => {
  it('this worker has its own home, and it is not the real one', () => {
    const real = (globalThis as { __dojoRealHomedir?: () => string }).__dojoRealHomedir?.();
    expect(real).toBeTruthy();
    expect(process.env.DOJO_HOME).toBeTruthy();
    expect(homeDir()).toBe(process.env.DOJO_HOME);
    expect(homeDir()).not.toBe(real);
    expect(fs.existsSync(path.join(homeDir(), '.dojo'))).toBe(true);
    expect(dojoDir('logs', 'dojo.log')).toBe(path.join(homeDir(), '.dojo', 'logs', 'dojo.log'));
    expect(isTestRun()).toBe(true);
  });

  it('$HOME is redirected too, so even a path that bypasses homeDir() is contained', () => {
    expect(process.env.HOME).toBe(process.env.DOJO_HOME);
  });

  // ── The deliberate violations ──

  it('THROWS when something in this tree calls os.homedir() directly', () => {
    expect(() => os.homedir()).toThrow(/REAL-HOME TRIPWIRE/);
  });

  it('THROWS when DOJO_HOME goes missing inside a test run', () => {
    const saved = process.env.DOJO_HOME;
    delete process.env.DOJO_HOME;
    try {
      expect(() => homeDir()).toThrow(/REAL-HOME TRIPWIRE/);
    } finally {
      process.env.DOJO_HOME = saved;
    }
  });

  it('REFUSES a relative DOJO_HOME, which would mean a different home per process', () => {
    const saved = process.env.DOJO_HOME;
    process.env.DOJO_HOME = 'some/relative/path';
    try {
      expect(() => homeDir()).toThrow(/must be an absolute path/);
    } finally {
      process.env.DOJO_HOME = saved;
    }
  });

  // ── The production control ──

  it('PRODUCTION: with no DOJO_HOME and no test flag, homeDir() is os.homedir() and nothing else', () => {
    const savedHome = process.env.DOJO_HOME;
    const savedVitest = process.env.VITEST;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.DOJO_HOME;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    try {
      expect(isTestRun()).toBe(false);
      const real = (globalThis as { __dojoRealHomedir: () => string }).__dojoRealHomedir();
      expect(homeDir()).toBe(real);
    } finally {
      process.env.DOJO_HOME = savedHome;
      if (savedVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = savedVitest;
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    }
  });
});
