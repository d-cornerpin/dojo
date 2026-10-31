import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { integrityFailureFromError } from '../../../../../watchdog/src/alert-ledger.js';

let tmpFile: string | null = null;
afterEach(() => {
  if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch { /* gone */ } tmpFile = null; }
});

describe('watchdog database-integrity error classifier', () => {
  it('a real junk file makes the driver throw, and that error is classified as damage', () => {
    tmpFile = path.join(os.tmpdir(), `wd-junk-${process.pid}-${Date.now()}.db`);
    fs.writeFileSync(tmpFile, 'this is not a database. '.repeat(200).slice(0, 4096));
    let caught: unknown = null;
    try {
      const db = new Database(tmpFile, { readonly: true });
      try { db.pragma('integrity_check'); } finally { db.close(); }
    } catch (e) { caught = e; }
    expect(caught).not.toBeNull();
    const out = integrityFailureFromError(caught);
    expect(typeof out).toBe('string');
    expect((out as string).length).toBeGreaterThan(0);
  });
  it('a busy database is transient and stays quiet', () => {
    expect(integrityFailureFromError({ code: 'SQLITE_BUSY' })).toBeNull();
  });
  it('NOTADB is damage', () => {
    expect(integrityFailureFromError({ code: 'SQLITE_NOTADB' })).toBeTruthy();
  });
  it('plain errors and non-errors stay quiet', () => {
    expect(integrityFailureFromError(new Error('x'))).toBeNull();
    expect(integrityFailureFromError(undefined)).toBeNull();
  });
});
