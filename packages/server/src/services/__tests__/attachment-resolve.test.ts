// Regression test for resolveAttachmentPath (services/attachment-resolve.ts):
// the lookup used to load only the NEWEST 500 attachment-bearing messages and
// scan their JSON, so an attachment older than that window returned `null` even
// though the file was still on disk and still recorded. The fix looks the id up
// by the id itself (`AND instr(attachments, ?) > 0`, the id bound as a parameter)
// and drops the cap; the newest-first preference, the `fs.existsSync` check, the
// exact `fileId` match and the skip of malformed rows are all preserved.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { resolveAttachmentPath } from '../attachment-resolve.js';

let tmpDir: string;
let blobPath: string;   // a shared existing file the filler rows point at

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'att-'));
  blobPath = path.join(tmpDir, 'blob.bin');
  fs.writeFileSync(blobPath, Buffer.from('blob'));

  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      created_at INTEGER,
      attachments TEXT
    );
  `);
  mockDb.current = db;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const attJson = (arr: unknown) => JSON.stringify(arr);

/** Insert a messages row whose `attachments` column is `attachments`, at `created_at`. */
function insertMessage(id: string, createdAt: number, attachments: string): void {
  mockDb.current!
    .prepare(`INSERT INTO messages (id, created_at, attachments) VALUES (?, ?, ?)`)
    .run(id, createdAt, attachments);
}

describe('resolveAttachmentPath', () => {
  it('finds an attachment older than the 500 newest attachment-bearing rows', () => {
    // 600 newer rows, each a distinct attachment pointing at an existing file.
    for (let i = 0; i < 600; i++) {
      insertMessage(`m-new-${i}`, 1 + i, attJson([{
        fileId: `filler-${i}`,
        filename: `filler-${i}.bin`,
        mimeType: 'application/octet-stream',
        path: blobPath,
      }]));
    }
    // The one old row (lowest created_at) carries the id we look up.
    const targetPath = path.join(tmpDir, 'old-recording.wav');
    fs.writeFileSync(targetPath, Buffer.from('RIFF'));
    insertMessage('m-old', 0, attJson([{
      fileId: 'rec-abc',
      filename: 'old-recording.wav',
      mimeType: 'audio/wav',
      path: targetPath,
    }]));

    expect(resolveAttachmentPath('rec-abc')).toEqual({
      path: targetPath,
      filename: 'old-recording.wav',
      mimeType: 'audio/wav',
    });
  });

  it('returns null when the id is in no row', () => {
    insertMessage('m-1', 2, attJson([{ fileId: 'other-1', filename: 'a.bin', mimeType: 'text/plain', path: blobPath }]));
    insertMessage('m-2', 1, attJson([{ fileId: 'other-2', filename: 'b.bin', mimeType: 'text/plain', path: blobPath }]));
    expect(resolveAttachmentPath('no-such-id-999')).toBeNull();
  });

  it('skips a row whose recorded file no longer exists, and an older row with the same id that does exist wins', () => {
    const livePath = path.join(tmpDir, 'live.txt');
    fs.writeFileSync(livePath, 'live');

    // Newest row: the id is recorded, but its file is gone.
    insertMessage('m-gone', 2, attJson([{
      fileId: 'shared-1',
      filename: 'gone.txt',
      mimeType: 'text/plain',
      path: path.join(tmpDir, 'gone.txt'),   // never written -> existsSync is false
    }]));
    // Older row: the same id, and its file still exists.
    insertMessage('m-live', 1, attJson([{
      fileId: 'shared-1',
      filename: 'live.txt',
      mimeType: 'text/plain',
      path: livePath,
    }]));

    expect(resolveAttachmentPath('shared-1')).toEqual({
      path: livePath,
      filename: 'live.txt',
      mimeType: 'text/plain',
    });
  });

  it('skips a row whose attachments is invalid JSON, without throwing', () => {
    const okPath = path.join(tmpDir, 'ok.wav');
    fs.writeFileSync(okPath, 'wav');

    // Newest row: broken JSON, but it mentions the id so the pre-filter admits it.
    insertMessage('m-bad', 2, 'this is not json but mentions rec-xyz');
    // Older row: valid, and it carries the id.
    insertMessage('m-good', 1, attJson([{
      fileId: 'rec-xyz',
      filename: 'ok.wav',
      mimeType: 'audio/wav',
      path: okPath,
    }]));

    expect(() => resolveAttachmentPath('rec-xyz')).not.toThrow();
    expect(resolveAttachmentPath('rec-xyz')).toEqual({
      path: okPath,
      filename: 'ok.wav',
      mimeType: 'audio/wav',
    });
  });

  it('an id containing % or _ matches only the exact id, not a LIKE-shaped neighbour', () => {
    const targetPath = path.join(tmpDir, 'target.bin');
    fs.writeFileSync(targetPath, 't');
    const decoyPath = path.join(tmpDir, 'decoy.bin');
    fs.writeFileSync(decoyPath, 'd');

    // The target id carries _ and %. A LIKE-as-pattern fix (the id spliced into a
    // pattern) would also admit the decoy id below: _100% reads as "any char, 100,
    // any run". instr treats both as literal, so the decoy is not even pulled.
    insertMessage('m-target', 2, attJson([{
      fileId: 'img_100%done.txt',
      filename: 'target.bin',
      mimeType: 'application/octet-stream',
      path: targetPath,
    }]));
    insertMessage('m-decoy', 1, attJson([{
      fileId: 'imgX100done.txt',
      filename: 'decoy.bin',
      mimeType: 'application/octet-stream',
      path: decoyPath,
    }]));

    expect(resolveAttachmentPath('img_100%done.txt')).toEqual({
      path: targetPath,
      filename: 'target.bin',
      mimeType: 'application/octet-stream',
    });
  });
});
