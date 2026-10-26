// Disk version snapshots (versions/ subdir): the path helpers, the best-effort
// writer, and the reader the Trainer reaches via file_read — newest first,
// tolerant of a missing or corrupt sidecar. No DB or store is touched here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../db/connection.js', () => ({ getDb: () => { throw new Error('no db in this test'); } }));
vi.mock('../store.js', () => ({ getTechnique: () => null }));

import {
  VERSIONS_SUBDIR,
  versionsDir,
  versionFilePath,
  versionMetaPath,
  writeDiskVersionSnapshot,
  listDiskVersions,
} from '../versioning.js';

let tmp = '';
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('disk version snapshot names', () => {
  it('VERSIONS_SUBDIR is "versions" and the helpers join under it', () => {
    expect(VERSIONS_SUBDIR).toBe('versions');
    expect(versionsDir('/t')).toBe(path.join('/t', 'versions'));
    expect(versionFilePath('/t', 3)).toBe(path.join('/t', 'versions', 'TECHNIQUE_v3.md'));
    expect(versionMetaPath('/t', 3)).toBe(path.join('/t', 'versions', 'TECHNIQUE_v3.json'));
  });
});

describe('writeDiskVersionSnapshot', () => {
  it('writes the .md and a .json sidecar carrying the recorded meta', () => {
    writeDiskVersionSnapshot(tmp, 2, '# A', {
      changedBy: 'x',
      changeSummary: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(fs.readFileSync(versionFilePath(tmp, 2), 'utf-8')).toBe('# A');
    const meta = JSON.parse(fs.readFileSync(versionMetaPath(tmp, 2), 'utf-8'));
    expect(meta).toEqual({
      versionNumber: 2,
      changedBy: 'x',
      changeSummary: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('is best-effort: a techniqueDir that is a regular file does not throw', () => {
    const file = path.join(tmp, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(() => writeDiskVersionSnapshot(file, 1, 'content', {
      changedBy: null,
      changeSummary: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    })).not.toThrow();
  });
});

describe('listDiskVersions', () => {
  it('returns [] when the versions directory is missing', () => {
    expect(listDiskVersions(path.join(tmp, 'nope'))).toEqual([]);
  });

  it('lists newest first by number (not text order) with fields from the sidecar', () => {
    writeDiskVersionSnapshot(tmp, 1, 'one', { changedBy: 'a', changeSummary: 'first', createdAt: '2026-01-01T00:00:00.000Z' });
    writeDiskVersionSnapshot(tmp, 2, 'two!', { changedBy: 'b', changeSummary: 'second', createdAt: '2026-01-02T00:00:00.000Z' });
    writeDiskVersionSnapshot(tmp, 10, 'ten-ten', { changedBy: 'c', changeSummary: 'tenth', createdAt: '2026-01-10T00:00:00.000Z' });

    const metaOf: Record<number, { content: string; changedBy: string; changeSummary: string; createdAt: string }> = {
      1: { content: 'one', changedBy: 'a', changeSummary: 'first', createdAt: '2026-01-01T00:00:00.000Z' },
      2: { content: 'two!', changedBy: 'b', changeSummary: 'second', createdAt: '2026-01-02T00:00:00.000Z' },
      10: { content: 'ten-ten', changedBy: 'c', changeSummary: 'tenth', createdAt: '2026-01-10T00:00:00.000Z' },
    };

    const entries = listDiskVersions(tmp);
    expect(entries.map(e => e.versionNumber)).toEqual([10, 2, 1]);

    for (const e of entries) {
      const want = metaOf[e.versionNumber]!;
      expect(e.filePath).toBe(versionFilePath(tmp, e.versionNumber));
      expect(e.metaPath).toBe(versionMetaPath(tmp, e.versionNumber));
      expect(e.sizeBytes).toBe(Buffer.byteLength(want.content));
      expect(e.changedBy).toBe(want.changedBy);
      expect(e.changeSummary).toBe(want.changeSummary);
      expect(e.createdAt).toBe(want.createdAt);
    }
  });

  it('a .md with no sidecar yields null meta fields and its byte size', () => {
    fs.mkdirSync(versionsDir(tmp), { recursive: true });
    fs.writeFileSync(versionFilePath(tmp, 5), 'five');

    const e = listDiskVersions(tmp)[0]!;
    expect(e.versionNumber).toBe(5);
    expect(e.changedBy).toBeNull();
    expect(e.changeSummary).toBeNull();
    expect(e.createdAt).toBeNull();
    expect(e.sizeBytes).toBe(4);
  });

  it('a corrupt sidecar is ignored but the version is still listed', () => {
    fs.mkdirSync(versionsDir(tmp), { recursive: true });
    fs.writeFileSync(versionFilePath(tmp, 6), 'six');
    fs.writeFileSync(versionMetaPath(tmp, 6), 'not json');

    const e = listDiskVersions(tmp)[0]!;
    expect(e.versionNumber).toBe(6);
    expect(e.changedBy).toBeNull();
    expect(e.changeSummary).toBeNull();
    expect(e.createdAt).toBeNull();
  });

  it('a partial sidecar supplies only the fields it has; the rest fall back to null', () => {
    fs.mkdirSync(versionsDir(tmp), { recursive: true });
    fs.writeFileSync(versionFilePath(tmp, 7), 'seven');
    fs.writeFileSync(versionMetaPath(tmp, 7), '{"changedBy":"bot"}');

    const e = listDiskVersions(tmp)[0]!;
    expect(e.versionNumber).toBe(7);
    expect(e.changedBy).toBe('bot');
    expect(e.changeSummary).toBeNull();
    expect(e.createdAt).toBeNull();
  });

  it('ignores files that are not TECHNIQUE_vN.md snapshots', () => {
    const dir = versionsDir(tmp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.md'), 'x');
    fs.writeFileSync(path.join(dir, 'TECHNIQUE_v8.json'), '{}');
    fs.writeFileSync(path.join(dir, 'TECHNIQUE_v9.md.bak'), 'x');

    expect(listDiskVersions(tmp)).toEqual([]);
  });
});
