// A test can never touch the developer's real ~/.dojo: every worker has its own home (vitest.setup.ts), $HOME follows
// it, a direct os.homedir() call throws, and a missing DOJO_HOME throws instead of resolving the real home.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir, dojoDir } from '../home.js';

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

  it('PRODUCTION: with no DOJO_HOME and no VITEST, homeDir() is os.homedir() and nothing else', () => {
    const savedHome = process.env.DOJO_HOME;
    const savedVitest = process.env.VITEST;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.DOJO_HOME;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    try {
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
