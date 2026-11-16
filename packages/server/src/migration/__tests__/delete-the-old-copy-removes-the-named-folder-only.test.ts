// The import sets the previous Dojo folder aside and records where. The checklist shows it, and the owner's
// "Delete the old copy" removes that one recorded folder: never the live home, never a path the request names.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { homeDir } from '../../home.js';

const db = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../db/connection.js', () => ({ getDb: () => db.current, closeDb: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { migrationRouter } from '../../gateway/routes/migration.js';

const folder = (name: string): string => {
  const p = path.join(homeDir(), name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'kept.txt'), 'twelve bytes');
  return p;
};
const record = (p: string): void => {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  d.prepare("INSERT INTO config (key, value) VALUES ('import_old_copy', ?)").run(p);
  db.current = d;
};
const oldCopy = async () => (await (await migrationRouter.request('/import/status')).json()).data.oldCopy;
const deleteIt = (body: object = {}) => migrationRouter.request('/import/old-copy/delete', { method: 'POST', body: JSON.stringify(body) });

let live: string;
beforeEach(() => {
  for (const f of fs.readdirSync(homeDir())) if (f.startsWith('.dojo')) fs.rmSync(path.join(homeDir(), f), { recursive: true, force: true });
  live = folder('.dojo');
});

describe('delete the old copy', () => {
  it('shows where the recorded copy is and how big, and removes only that folder', async () => {
    const recorded = folder('.dojo-backup-111');
    const other = folder('.dojo-backup-222');
    record(recorded);
    expect(await oldCopy()).toEqual({ path: recorded, bytes: 12 });

    const res = await deleteIt({ path: other });
    expect(res.status).toBe(200);
    expect(fs.existsSync(recorded)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(live)).toBe(true);
    expect(await oldCopy()).toBeNull();
  });

  it('refuses when the record names the live Dojo home', async () => {
    record(live);
    expect(await oldCopy()).toBeNull();
    expect((await deleteIt()).status).toBe(404);
    expect(fs.existsSync(path.join(live, 'kept.txt'))).toBe(true);
  });

  it('refuses when the record names anything but a set-aside Dojo folder', async () => {
    const elsewhere = folder('Documents');
    record(elsewhere);
    expect((await deleteIt({ path: elsewhere })).status).toBe(404);
    expect(fs.existsSync(elsewhere)).toBe(true);
  });
});
