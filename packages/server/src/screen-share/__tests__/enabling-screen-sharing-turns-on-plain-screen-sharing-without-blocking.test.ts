import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));

// The Mac's side, faked: the admin prompt answers when the test says so, and port 5900 listens once it has run.
const mac = vi.hoisted(() => ({ listening: false, scripts: [] as string[], answer: null as null | ((err: Error | null) => void) }));
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  execFileSync: () => { throw new Error('a blocking call was made'); },
  execFile: (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    mac.scripts.push(args[1]);
    mac.answer = (err) => { if (!err) mac.listening = true; cb(err); };
  },
}));
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    setTimeout(): void {}
    destroy(): void {}
    connect(): void { setImmediate(() => this.emit(mac.listening ? 'connect' : 'error', new Error('refused'))); }
  }
  return { default: { Socket }, Socket };
});

import { runMigrations } from '../../db/migrations.js';
import { enable, disable } from '../manager.js';

describe('enabling screen sharing', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations();
    mac.listening = false;
    mac.scripts = [];
    mac.answer = null;
  });

  afterEach(() => {
    mockDb.current?.close();
    mockDb.current = null;
  });

  const approveEnable = async (): Promise<ReturnType<typeof enable>> => {
    const p = enable();
    await new Promise((r) => setTimeout(r, 30));
    mac.answer!(null);
    return p;
  };

  it("enabling does not block the server while the Mac's prompt waits", async () => {
    let ticked = false;
    setTimeout(() => { ticked = true; }, 0);
    const p = enable();
    await new Promise((r) => setTimeout(r, 30));
    expect(ticked).toBe(true);
    expect(mac.answer).not.toBeNull();
    mac.answer!(null);
    const r = await p;
    expect(r.state).toBe('ready');
  });

  it('enable turns on plain Screen Sharing, not Remote Management', async () => {
    await approveEnable();
    expect(mac.scripts[0]).toContain('launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist');
    expect(mac.scripts[0]).not.toContain('kickstart');
    expect(mac.scripts[0]).not.toContain('RemoteManagement');
  });

  it('disable turns off only what the Dojo turned on', async () => {
    await approveEnable();
    mac.answer = null;
    const d = disable();
    await new Promise((r) => setTimeout(r, 30));
    mac.answer!(null);
    const res = await d;
    expect(res.ok).toBe(true);
    expect(mac.scripts[1]).toContain('launchctl unload -w /System/Library/LaunchDaemons/com.apple.screensharing.plist');
  });

  it('a cancelled prompt is told plainly', async () => {
    const p = enable();
    await new Promise((r) => setTimeout(r, 30));
    mac.answer!(new Error('User canceled. (-128)'));
    const r = await p;
    expect(r.state).toBe('error');
    expect(r.error).toBe('Approval was cancelled on the Mac. Try Enable again and approve the prompt.');
  });
});
