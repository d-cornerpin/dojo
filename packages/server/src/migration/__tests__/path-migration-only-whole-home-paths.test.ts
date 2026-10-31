import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migratePaths, swapHome } from '../path-migration.js';

// Placeholder homes. A sibling shares the old home as a prefix; it is built by joining so no
// real-looking account name appears in the source.
const OLD = '/Users/someone';
const NEW = '/Users/anyone';
const SIB = OLD + 'else';
const REGEXY = OLD.replace('one', '.ne'); // a home containing a regex wildcard
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
    expect(swapHome(`${OLD}/a and ${SIB}/b`, `${OLD}`, `${NEW}`))
      .toBe(`${NEW}/a and ${SIB}/b`);
  });
  it('swaps a path ending exactly at the home, before a quote, or before a space', () => {
    expect(swapHome(`home=${OLD}`, `${OLD}`, `${NEW}`)).toBe(`home=${NEW}`);
    expect(swapHome(`"${OLD}" x`, `${OLD}`, `${NEW}`)).toBe(`"${NEW}" x`);
  });
  it('keeps paths with spaces and does not touch -, _ or . extensions of the home name', () => {
    expect(swapHome(`${OLD}/My Docs/a b.txt`, `${OLD}`, `${NEW}`)).toBe(`${NEW}/My Docs/a b.txt`);
    expect(swapHome(`${OLD}-old ${OLD}_x ${OLD}.bak`, `${OLD}`, `${NEW}`))
      .toBe(`${OLD}-old ${OLD}_x ${OLD}.bak`);
  });
  it('reads $ in the new home literally', () => {
    expect(swapHome(`${OLD}/x`, `${OLD}`, '/Users/$&anyone')).toBe('/Users/$&anyone/x');
  });
  it('treats regex characters in the old home literally', () => {
    expect(swapHome(`${REGEXY}/a ${OLD}/b`, `${REGEXY}`, `${NEW}`)).toBe(`${NEW}/a ${OLD}/b`);
  });
  it('replaces every occurrence', () => {
    expect(swapHome(`${OLD}/a:${OLD}/b`, `${OLD}`, '/h')).toBe('/h/a:/h/b');
  });
});

describe('migratePaths guards', () => {
  it('an empty old home leaves files exactly as they were', () => {
    const dojo = tmp();
    fs.writeFileSync(path.join(dojo, 'secrets.yaml'), 'abc');
    migratePaths('', `${NEW}`, dojo);
    expect(fs.readFileSync(path.join(dojo, 'secrets.yaml'), 'utf-8')).toBe('abc');
  });
  it('an old home of only slashes leaves files untouched', () => {
    const dojo = tmp();
    fs.writeFileSync(path.join(dojo, 'secrets.yaml'), 'abc/def');
    migratePaths('/', `${NEW}`, dojo);
    expect(fs.readFileSync(path.join(dojo, 'secrets.yaml'), 'utf-8')).toBe('abc/def');
  });
  it('a trailing slash on the old home still migrates, and a sibling prefix is left alone', () => {
    const dojo = tmp();
    fs.writeFileSync(path.join(dojo, 'secrets.yaml'), `a: ${OLD}/x\nb: ${SIB}/y\n`);
    migratePaths(`${OLD}/`, `${NEW}`, dojo);
    expect(fs.readFileSync(path.join(dojo, 'secrets.yaml'), 'utf-8')).toBe(`a: ${NEW}/x\nb: ${SIB}/y\n`);
  });
  it('database rows: only whole-home paths are rewritten', () => {
    const dojo = tmp();
    fs.mkdirSync(path.join(dojo, 'data'));
    const db = new Database(path.join(dojo, 'data', 'dojo.db'));
    db.exec('CREATE TABLE techniques (id TEXT, directory_path TEXT); CREATE TABLE config (key TEXT, value TEXT);');
    db.prepare('INSERT INTO techniques VALUES (?, ?)').run('t1', `${OLD}/My Techniques/a`);
    db.prepare('INSERT INTO techniques VALUES (?, ?)').run('t2', `${SIB}/techniques/b`);
    db.prepare('INSERT INTO config VALUES (?, ?)').run('k', `["${OLD}/x","${SIB}/y"]`);
    db.close();
    migratePaths(`${OLD}`, `${NEW}`, dojo);
    const after = new Database(path.join(dojo, 'data', 'dojo.db'));
    const rows = after.prepare('SELECT id, directory_path FROM techniques ORDER BY id').all();
    expect(rows).toEqual([
      { id: 't1', directory_path: `${NEW}/My Techniques/a` },
      { id: 't2', directory_path: `${SIB}/techniques/b` },
    ]);
    expect((after.prepare('SELECT value FROM config').get() as { value: string }).value)
      .toBe(`["${NEW}/x","${SIB}/y"]`);
    after.close();
  });
});
