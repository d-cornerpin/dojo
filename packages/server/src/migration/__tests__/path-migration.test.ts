// ════════════════════════════════════════════════════════════════════════════
// PATH MIGRATION — importing a Dojo onto a machine with a different home folder
// must rewrite every old-home reference (database, secrets.yaml, config and
// technique text files, and the cloudflared config under the NEW home), or the
// imported box points at a folder that does not exist on the new machine.
//
// This suite pins `migratePaths` against a REAL temp home and REAL temp folders,
// with a REAL better-sqlite3 database. Nothing is mocked: the function opens and
// closes the database itself and rewrites text files in place, so the assertions
// read what was actually written.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migratePaths } from '../path-migration.js';

const OLD = '/old/home/alice';

let tmp: string;
let newHome: string;
let dojoDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  newHome = path.join(tmp, 'newhome');
  fs.mkdirSync(newHome, { recursive: true });
  dojoDir = path.join(tmp, 'dojo');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('migratePaths', () => {
  it('same home: changes nothing and does not throw', () => {
    fs.mkdirSync(dojoDir, { recursive: true });
    fs.writeFileSync(path.join(dojoDir, 'secrets.yaml'), `a: ${OLD}/x\n`);
    expect(() => migratePaths(OLD, OLD, dojoDir)).not.toThrow();
    expect(fs.readFileSync(path.join(dojoDir, 'secrets.yaml'), 'utf-8')).toBe(`a: ${OLD}/x\n`);
  });

  it('same home: does not throw even if dojoDir does not exist', () => {
    expect(() => migratePaths(OLD, OLD, dojoDir)).not.toThrow();
  });

  it('rewrites old-home references in every listed text file, recursively, by extension', () => {
    fs.mkdirSync(path.join(dojoDir, 'config', 'nested', 'deeper'), { recursive: true });
    fs.mkdirSync(path.join(dojoDir, 'techniques', 't1'), { recursive: true });

    const rewrite = [
      [path.join(dojoDir, 'secrets.yaml'), `a: ${OLD}/x\nb: ${OLD}/y\n`],
      [path.join(dojoDir, 'config', 'a.json'), `{"dir":"${OLD}/z"}`],
      [path.join(dojoDir, 'config', 'nested', 'deeper', 'b.md'), `${OLD}/nested`],
      [path.join(dojoDir, 'config', 'NOTES.MD'), `see ${OLD}/notes`],
      [path.join(dojoDir, 'techniques', 't1', 'TECHNIQUE.md'), `# ${OLD}/tech`],
      [path.join(dojoDir, 'techniques', 't1', 'run.sh'), `cd ${OLD}/scripts`],
      [path.join(dojoDir, 'techniques', 't1', 'x.yml'), `root: ${OLD}/y`],
      [path.join(dojoDir, 'techniques', 't1', 'x.toml'), `root = "${OLD}/t"`],
      [path.join(dojoDir, 'techniques', 't1', 'x.txt'), `${OLD}/text`],
    ] as Array<[string, string]>;
    for (const [file, content] of rewrite) fs.writeFileSync(file, content);

    // Not listed extensions — they contain the old path but are left alone.
    fs.writeFileSync(path.join(dojoDir, 'config', 'pic.png'), `${OLD}/pic`);
    fs.writeFileSync(path.join(dojoDir, 'config', 'data.db'), `${OLD}/data`);
    // No old path at all — keeps its exact text.
    fs.writeFileSync(path.join(dojoDir, 'config', 'plain.txt'), 'nothing here');

    migratePaths(OLD, newHome, dojoDir);

    expect(fs.readFileSync(path.join(dojoDir, 'secrets.yaml'), 'utf-8')).toBe(`a: ${newHome}/x\nb: ${newHome}/y\n`);
    expect(fs.readFileSync(path.join(dojoDir, 'config', 'a.json'), 'utf-8')).toBe(`{"dir":"${newHome}/z"}`);
    expect(fs.readFileSync(path.join(dojoDir, 'config', 'nested', 'deeper', 'b.md'), 'utf-8')).toBe(`${newHome}/nested`);
    expect(fs.readFileSync(path.join(dojoDir, 'config', 'NOTES.MD'), 'utf-8')).toBe(`see ${newHome}/notes`);
    expect(fs.readFileSync(path.join(dojoDir, 'techniques', 't1', 'TECHNIQUE.md'), 'utf-8')).toBe(`# ${newHome}/tech`);
    expect(fs.readFileSync(path.join(dojoDir, 'techniques', 't1', 'run.sh'), 'utf-8')).toBe(`cd ${newHome}/scripts`);
    expect(fs.readFileSync(path.join(dojoDir, 'techniques', 't1', 'x.yml'), 'utf-8')).toBe(`root: ${newHome}/y`);
    expect(fs.readFileSync(path.join(dojoDir, 'techniques', 't1', 'x.toml'), 'utf-8')).toBe(`root = "${newHome}/t"`);
    expect(fs.readFileSync(path.join(dojoDir, 'techniques', 't1', 'x.txt'), 'utf-8')).toBe(`${newHome}/text`);
    // Unlisted extensions untouched, despite containing the old path.
    expect(fs.readFileSync(path.join(dojoDir, 'config', 'pic.png'), 'utf-8')).toBe(`${OLD}/pic`);
    expect(fs.readFileSync(path.join(dojoDir, 'config', 'data.db'), 'utf-8')).toBe(`${OLD}/data`);
    // No old path keeps its exact text.
    expect(fs.readFileSync(path.join(dojoDir, 'config', 'plain.txt'), 'utf-8')).toBe('nothing here');
  });

  it('rewrites the cloudflared config looked up under the NEW home', () => {
    fs.mkdirSync(path.join(newHome, '.cloudflared'), { recursive: true });
    fs.writeFileSync(path.join(newHome, '.cloudflared', 'config.yml'), `${OLD}/.cloudflared/cert.pem`);
    migratePaths(OLD, newHome, dojoDir);
    expect(fs.readFileSync(path.join(newHome, '.cloudflared', 'config.yml'), 'utf-8')).toBe(`${newHome}/.cloudflared/cert.pem`);
  });

  it('missing pieces do not throw and nothing is created', () => {
    fs.mkdirSync(dojoDir, { recursive: true });
    expect(() => migratePaths(OLD, newHome, dojoDir)).not.toThrow();
    expect(fs.readdirSync(dojoDir)).toEqual([]);
  });

  it('rewrites database paths: techniques, config, agents, messages', () => {
    const dbPath = path.join(dojoDir, 'data', 'dojo.db');
    fs.mkdirSync(path.join(dojoDir, 'data'), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE techniques (id TEXT, directory_path TEXT);
      CREATE TABLE config (key TEXT, value TEXT);
      CREATE TABLE agents (id TEXT, system_prompt_path TEXT, config TEXT);
      CREATE TABLE messages (id TEXT, attachments TEXT);
    `);
    db.prepare('INSERT INTO techniques (id, directory_path) VALUES (?, ?), (?, ?)').run('t1', `${OLD}/.dojo/techniques/t1`, 't2', '/other/old/home/alice/x');
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?), (?, ?)').run('k1', `${OLD}/a:${OLD}/b`, 'k2', 'nothing here');
    db.prepare('INSERT INTO agents (id, system_prompt_path, config) VALUES (?, NULL, ?), (?, ?, NULL), (?, ?, ?)')
      .run('a1', `{"dir":"${OLD}/w"}`, 'a2', `${OLD}/p.md`, 'a3', '/keep', '{"x":1}');
    db.prepare('INSERT INTO messages (id, attachments) VALUES (?, ?)').run('m1', `["${OLD}/f.png"]`);
    db.close();

    migratePaths(OLD, newHome, dojoDir);

    const db2 = new Database(dbPath);
    expect(db2.prepare('SELECT directory_path FROM techniques WHERE id = ?').get('t1')!.directory_path).toBe(`${newHome}/.dojo/techniques/t1`);
    // Only a path that STARTS with the old home is changed for techniques.
    expect(db2.prepare('SELECT directory_path FROM techniques WHERE id = ?').get('t2')!.directory_path).toBe('/other/old/home/alice/x');
    expect(db2.prepare('SELECT value FROM config WHERE key = ?').get('k1')!.value).toBe(`${newHome}/a:${newHome}/b`);
    expect(db2.prepare('SELECT value FROM config WHERE key = ?').get('k2')!.value).toBe('nothing here');
    const a1 = db2.prepare('SELECT system_prompt_path, config FROM agents WHERE id = ?').get('a1')!;
    expect(a1.system_prompt_path).toBeNull();
    expect(a1.config).toBe(`{"dir":"${newHome}/w"}`);
    const a2 = db2.prepare('SELECT system_prompt_path, config FROM agents WHERE id = ?').get('a2')!;
    expect(a2.system_prompt_path).toBe(`${newHome}/p.md`);
    expect(a2.config).toBeNull();
    const a3 = db2.prepare('SELECT system_prompt_path, config FROM agents WHERE id = ?').get('a3')!;
    expect(a3.system_prompt_path).toBe('/keep');
    expect(a3.config).toBe('{"x":1}');
    expect(db2.prepare('SELECT attachments FROM messages WHERE id = ?').get('m1')!.attachments).toBe(`["${newHome}/f.png"]`);
    db2.close();
  });

  it('a database missing tables is tolerated: the config table is still rewritten', () => {
    const dbPath = path.join(dojoDir, 'data', 'dojo.db');
    fs.mkdirSync(path.join(dojoDir, 'data'), { recursive: true });
    const db = new Database(dbPath);
    db.exec('CREATE TABLE config (key TEXT, value TEXT)');
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('k1', `${OLD}/x`);
    db.close();

    expect(() => migratePaths(OLD, newHome, dojoDir)).not.toThrow();

    const db2 = new Database(dbPath);
    expect(db2.prepare('SELECT value FROM config WHERE key = ?').get('k1')!.value).toBe(`${newHome}/x`);
    db2.close();
  });

  it('closes the database afterwards: it can be reopened and written without a lock error', () => {
    const dbPath = path.join(dojoDir, 'data', 'dojo.db');
    fs.mkdirSync(path.join(dojoDir, 'data'), { recursive: true });
    const db = new Database(dbPath);
    db.exec('CREATE TABLE config (key TEXT, value TEXT)');
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('k1', `${OLD}/x`);
    db.close();

    migratePaths(OLD, newHome, dojoDir);

    // The migration's connection was closed; a fresh connection can both open and write.
    const reopened = new Database(dbPath);
    reopened.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('k2', 'ok');
    reopened.close();
  });
});
