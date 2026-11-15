// Saving the owner's name through the settings route changes the name the agents' message-sources text and
// the first-time profile carry, and an old user_name row is settled by migration 217 (the later edit wins).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';

const { HOME } = vi.hoisted(() => ({ HOME: `${(process.env.DOJO_TEST_HOME_ROOT || require('node:os').tmpdir())}/dojo-owner-name-${process.pid}` }));
vi.mock('../../home.js', () => ({ homeDir: (): string => HOME, dojoDir: (...s: string[]): string => `${HOME}/.dojo/${s.join('/')}` }));

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { freshDoneDb, doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { Hono } from 'hono';
import { configRouter } from '../routes/config.js';
import { renderMessageSources, renderUserProfile } from '../../prompt/assembler.js';
import { defaultUserProfile } from '../../prompt/user-profile.js';
import { clearPlatformConfigCache } from '../../config/platform.js';

const app = new Hono().route('/config', configRouter);
const save = (key: string, value: string) =>
  app.request(`/config/settings/${key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) });
const stored = (key: string) => (doneDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined)?.value;

beforeEach(() => {
  freshDoneDb();
  runMigrations();
  clearPlatformConfigCache();
});
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

describe('editing the owner name', () => {
  it('names the new name in the text the agents are given', async () => {
    await save('owner_name', 'Alex');
    expect(renderMessageSources()).toContain('direct message from Alex via dashboard');
    expect(defaultUserProfile()).toContain('- Name: Alex');

    await save('owner_name', 'Sam');
    expect(renderMessageSources()).toContain('direct message from Sam via dashboard');
    expect(renderMessageSources()).not.toContain('Alex');
  });

  it('updates the profile name line the agents read, but never a line the owner rewrote', async () => {
    const file = `${HOME}/.dojo/prompts/USER.md`;
    fs.mkdirSync(`${HOME}/.dojo/prompts`, { recursive: true });
    doneDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('owner_name', 'Old Name')").run();
    fs.writeFileSync(file, '# User Profile\n- Name: Old Name\n');
    await save('owner_name', 'Alex');
    expect(renderUserProfile('primary')).toContain('- Name: Alex');
    expect(renderUserProfile('primary')).not.toContain('Old Name');
    fs.writeFileSync(file, '# User Profile\n- Name: Mr Handwritten\n');
    await save('owner_name', 'Sam');
    expect(fs.readFileSync(file, 'utf-8')).toContain('- Name: Mr Handwritten');
  });

  it('saves the name even when USER.md cannot be read', async () => {
    fs.mkdirSync(`${HOME}/.dojo/prompts/USER.md`, { recursive: true });
    const res = await save('owner_name', 'Alex');
    expect(res.status).toBe(200);
    expect(stored('owner_name')).toBe('Alex');
  });

  it('migration 217 moves a name saved under the old key onto owner_name, the later edit winning', () => {
    const db = doneDb();
    const put = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    put.run('owner_name', 'Old Setup Name');
    put.run('user_name', ' Alex ');
    db.prepare('DELETE FROM _migrations WHERE name = ?').run('217_one_owner_name_key.sql');
    runMigrations();
    expect(stored('owner_name')).toBe('Alex');
    expect(stored('user_name')).toBeUndefined();
  });

  it('migration 217 keeps owner_name when there is no old key or the old one is blank', () => {
    const db = doneDb();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('owner_name', 'Sam')").run();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('user_name', '  ')").run();
    db.prepare('DELETE FROM _migrations WHERE name = ?').run('217_one_owner_name_key.sql');
    runMigrations();
    expect(stored('owner_name')).toBe('Sam');
    expect(stored('user_name')).toBeUndefined();
  });
});
