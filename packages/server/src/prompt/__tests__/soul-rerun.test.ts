// Re-running setup after first run never overwrites an owner-edited SOUL.md; a deliberate re-style
// keeps the previous text in a dated copy beside it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../home.js', () => ({ homeDir: () => home.dir }));
vi.mock('../assembler.js', () => ({
  writeSoulFile: (s: { file: string }, c: string) => { const d = path.join(home.dir, '.dojo', 'prompts'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, s.file), c); },
  readSoulFile: (s: { file: string; fallback: string }) => { try { return fs.readFileSync(path.join(home.dir, '.dojo', 'prompts', s.file), 'utf-8'); } catch { return s.fallback; } },
  soulFileForAgent: () => null,
}));
vi.mock('../../config/platform.js', () => ({ getPrimaryAgentId: () => 'x' }));
import { writeSoulOnRerun } from '../soul-rerun.js';

const soul = { file: 'SOUL.md', fallback: 'SHIPPED', spawnTruth: true };
const file = () => path.join(home.dir, '.dojo', 'prompts', 'SOUL.md');
const put = (t: string) => { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), t); };

beforeEach(() => { home.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-rerun-')); });
afterEach(() => { fs.rmSync(home.dir, { recursive: true, force: true }); });

describe('writeSoulOnRerun', () => {
  it('leaves an owner-edited soul byte-identical when style/rules were not changed', () => {
    put('MY WORDS');
    const out = writeSoulOnRerun(soul, 'COMPOSED', true, false);
    expect(out).toEqual({ written: false, backup: null });
    expect(fs.readFileSync(file(), 'utf-8')).toBe('MY WORDS');
  });
  it('re-styling an edited soul keeps the previous text in a dated copy and says where', () => {
    put('MY WORDS');
    const out = writeSoulOnRerun(soul, 'COMPOSED', true, true);
    expect(out.written).toBe(true);
    expect(out.backup).toMatch(/^SOUL\.md\..+\.bak$/);
    expect(fs.readFileSync(path.join(path.dirname(file()), out.backup!), 'utf-8')).toBe('MY WORDS');
    expect(fs.readFileSync(file(), 'utf-8')).toBe('COMPOSED');
  });
  it('a shipped-default soul is composed freely, and so is first run', () => {
    put('SHIPPED');
    expect(writeSoulOnRerun(soul, 'COMPOSED', true, false).written).toBe(true);
    put('MY WORDS');
    expect(writeSoulOnRerun(soul, 'COMPOSED', false, false).written).toBe(true);
  });
});
