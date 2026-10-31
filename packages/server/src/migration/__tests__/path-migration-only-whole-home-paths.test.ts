import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migratePaths, swapHome } from '../path-migration.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-whole-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('swapHome', () => {
  it('swaps only whole-home paths, not a longer folder that shares the prefix', () => {
    expect(swapHome('/Users/dan/a and /Users/daniel/b', '/Users/dan', '/Users/sam'))
      .toBe('/Users/sam/a and /Users/daniel/b');
  });
  it('swaps a path ending exactly at the home, before a quote, or before a space', () => {
    expect(swapHome('home=/Users/dan', '/Users/dan', '/Users/sam')).toBe('home=/Users/sam');
    expect(swapHome('"/Users/dan" x', '/Users/dan', '/Users/sam')).toBe('"/Users/sam" x');
  });
  it('keeps paths with spaces and does not touch -, _ or . extensions of the home name', () => {
    expect(swapHome('/Users/dan/My Docs/a b.txt', '/Users/dan', '/Users/sam')).toBe('/Users/sam/My Docs/a b.txt');
    expect(swapHome('/Users/dan-old /Users/dan_x /Users/dan.bak', '/Users/dan', '/Users/sam'))
      .toBe('/Users/dan-old /Users/dan_x /Users/dan.bak');
  });
  it('reads $ in the new home literally', () => {
    expect(swapHome('/Users/dan/x', '/Users/dan', '/Users/$&sam')).toBe('/Users/$&sam/x');
  });
  it('treats regex characters in the old home literally', () => {
    expect(swapHome('/Users/d.n/a /Users/dan/b', '/Users/d.n', '/Users/sam')).toBe('/Users/sam/a /Users/dan/b');
  });
  it('replaces every occurrence', () => {
    expect(swapHome('/Users/dan/a:/Users/dan/b', '/Users/dan', '/h')).toBe('/h/a:/h/b');
  });
});

describe('migratePaths guards', () => {
  it('an empty old home leaves files exactly as they were', () => {
    const dojo = tmp();
    fs.writeFileSync(path.join(dojo, 'secrets.yaml'), 'abc');
    migratePaths('', '/Users/sam', dojo);
    expect(fs.readFileSync(path.join(dojo, 'secrets.yaml'), 'utf-8')).toBe('abc');
  });
  it('an old home of only slashes leaves files untouched', () => {
    const dojo = tmp();
    fs.writeFileSync(path.join(dojo, 'secrets.yaml'), 'abc/def');
    migratePaths('/', '/Users/sam', dojo);
    expect(fs.readFileSync(path.join(dojo, 'secrets.yaml'), 'utf-8')).toBe('abc/def');
  });
  it('a trailing slash on the old home still migrates, and a sibling prefix is left alone', () => {
    const dojo = tmp();
    fs.writeFileSync(path.join(dojo, 'secrets.yaml'), 'a: /Users/dan/x\nb: /Users/daniel/y\n');
    migratePaths('/Users/dan/', '/Users/sam', dojo);
    expect(fs.readFileSync(path.join(dojo, 'secrets.yaml'), 'utf-8')).toBe('a: /Users/sam/x\nb: /Users/daniel/y\n');
  });
  it('database rows: only whole-home paths are rewritten', () => {
    const dojo = tmp();
    fs.mkdirSync(path.join(dojo, 'data'));
    const db = new Database(path.join(dojo, 'data', 'dojo.db'));
    db.exec('CREATE TABLE techniques (id TEXT, directory_path TEXT); CREATE TABLE config (key TEXT, value TEXT);');
    db.prepare('INSERT INTO techniques VALUES (?, ?)').run('t1', '/Users/dan/My Techniques/a');
    db.prepare('INSERT INTO techniques VALUES (?, ?)').run('t2', '/Users/daniel/techniques/b');
    db.prepare('INSERT INTO config VALUES (?, ?)').run('k', '["/Users/dan/x","/Users/daniel/y"]');
    db.close();
    migratePaths('/Users/dan', '/Users/sam', dojo);
    const after = new Database(path.join(dojo, 'data', 'dojo.db'));
    const rows = after.prepare('SELECT id, directory_path FROM techniques ORDER BY id').all();
    expect(rows).toEqual([
      { id: 't1', directory_path: '/Users/sam/My Techniques/a' },
      { id: 't2', directory_path: '/Users/daniel/techniques/b' },
    ]);
    expect((after.prepare('SELECT value FROM config').get() as { value: string }).value)
      .toBe('["/Users/sam/x","/Users/daniel/y"]');
    after.close();
  });
});
