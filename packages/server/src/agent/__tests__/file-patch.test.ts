// Tests for the file_patch tool. Covers the contract called out in the
// tool request: hard error on unmatched search, atomic write, multi-patch
// sequencing, dry-run, replace_all, line-ending preservation, and binary
// rejection.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// auditLog hits the DB; mock the connection so tests don't need one.
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({ run: () => ({}), get: () => ({}), all: () => [] }),
    exec: () => ({}),
    transaction: (fn: () => unknown) => () => fn(),
  }),
}));

vi.mock('../../gateway/ws.js', () => ({
  broadcast: () => { /* no-op */ },
}));

import { executeFilePatch } from '../tools.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-patch-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('file_patch', () => {
  it('replaces a single occurrence in place', async () => {
    const file = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(file, 'hello world\nhello world\n');
    const out = await executeFilePatch('agent-1', {
      path: file,
      patches: [{ search: 'hello', replace: 'hi' }],
    });
    expect(out).toMatch(/Patched .*1 total replacements/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('hi world\nhello world\n');
  });

  it('replace_all replaces every occurrence', async () => {
    const file = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(file, 'foo bar foo baz foo');
    const out = await executeFilePatch('agent-1', {
      path: file,
      patches: [{ search: 'foo', replace: 'qux', replace_all: true }],
    });
    expect(out).toMatch(/3 replacements/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('qux bar qux baz qux');
  });

  it('hard-errors when a search string is not found and does NOT touch disk', async () => {
    const file = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(file, 'this is the file content');
    const out = await executeFilePatch('agent-1', {
      path: file,
      patches: [{ search: 'NOT IN FILE', replace: 'x' }],
    });
    expect(out).toMatch(/^Error: patch 1 of 1 did not match/);
    expect(out).toMatch(/No changes have been written/);
    // File on disk is untouched.
    expect(fs.readFileSync(file, 'utf-8')).toBe('this is the file content');
  });

  it('applies patches sequentially (later patches see earlier results)', async () => {
    const file = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(file, 'one two three');
    const out = await executeFilePatch('agent-1', {
      path: file,
      patches: [
        { search: 'one', replace: 'ONE' },
        { search: 'ONE two', replace: 'TWO ONE' }, // depends on patch 1
      ],
    });
    expect(out).toMatch(/Patched/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('TWO ONE three');
  });

  it('aborts the entire batch if ANY patch fails — no partial writes', async () => {
    const file = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(file, 'alpha beta gamma');
    const out = await executeFilePatch('agent-1', {
      path: file,
      patches: [
        { search: 'alpha', replace: 'A' },        // would have matched
        { search: 'NOT THERE', replace: 'X' },    // fails
      ],
    });
    expect(out).toMatch(/^Error: patch 2 of 2 did not match/);
    // First patch's intended change must NOT be on disk.
    expect(fs.readFileSync(file, 'utf-8')).toBe('alpha beta gamma');
  });

  it('dry_run reports what would change but never writes', async () => {
    const file = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(file, 'hello world');
    const out = await executeFilePatch('agent-1', {
      path: file,
      patches: [{ search: 'world', replace: 'universe' }],
      dry_run: true,
    });
    expect(out).toMatch(/^\[Dry run/);
    expect(out).toMatch(/1 replacement/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('hello world');
  });

  it('preserves CRLF line endings when neither search nor replace touches them', async () => {
    const file = path.join(tmpDir, 'a.txt');
    const original = 'line1\r\nline2\r\nline3\r\n';
    fs.writeFileSync(file, original);
    const out = await executeFilePatch('agent-1', {
      path: file,
      patches: [{ search: 'line2', replace: 'LINE-TWO' }],
    });
    expect(out).toMatch(/Patched/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('line1\r\nLINE-TWO\r\nline3\r\n');
  });

  it('rejects binary files (null bytes in first 8KB)', async () => {
    const file = path.join(tmpDir, 'a.bin');
    const buf = Buffer.concat([Buffer.from('PNG'), Buffer.from([0x00, 0x01, 0x02])]);
    fs.writeFileSync(file, buf);
    const out = await executeFilePatch('agent-1', {
      path: file,
      patches: [{ search: 'PNG', replace: 'XXX' }],
    });
    expect(out).toMatch(/binary/i);
    // Untouched.
    expect(fs.readFileSync(file)).toEqual(buf);
  });

  it('rejects empty search strings', async () => {
    const file = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(file, 'content');
    const out = await executeFilePatch('agent-1', {
      path: file,
      patches: [{ search: '', replace: 'x' }],
    });
    expect(out).toMatch(/non-empty string/);
  });

  it('errors when the file does not exist', async () => {
    const out = await executeFilePatch('agent-1', {
      path: path.join(tmpDir, 'does-not-exist.txt'),
      patches: [{ search: 'a', replace: 'b' }],
    });
    expect(out).toMatch(/File not found/);
  });

  it('errors when path is a directory', async () => {
    const out = await executeFilePatch('agent-1', {
      path: tmpDir,
      patches: [{ search: 'a', replace: 'b' }],
    });
    expect(out).toMatch(/is a directory/);
  });

  it('handles a 5MB file with one inline base64-style line (the Maddy regression case)', async () => {
    const file = path.join(tmpDir, 'big.html');
    const big = 'PREFIX' + 'a'.repeat(5_000_000) + 'SUFFIX';
    fs.writeFileSync(file, big);
    const out = await executeFilePatch('agent-1', {
      path: file,
      patches: [{ search: 'SUFFIX', replace: 'TAIL' }],
    });
    expect(out).toMatch(/Patched/);
    const after = fs.readFileSync(file, 'utf-8');
    expect(after.endsWith('TAIL')).toBe(true);
    expect(after.startsWith('PREFIX')).toBe(true);
    expect(after.length).toBe(big.length - 'SUFFIX'.length + 'TAIL'.length);
  });

  it('does NOT leave a tmp file behind on success', async () => {
    const file = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(file, 'hello');
    await executeFilePatch('agent-1', {
      path: file,
      patches: [{ search: 'hello', replace: 'world' }],
    });
    const entries = fs.readdirSync(tmpDir);
    expect(entries).toEqual(['a.txt']);
  });
});
