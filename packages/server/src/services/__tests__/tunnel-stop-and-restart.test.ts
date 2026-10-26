// ════════════════════════════════════════════════════════════════════════════════════════
// STOP TUNNEL ESCALATION AND STALE EXIT.
//
// THE MEASURED DEFECTS. `stopTunnel` cleared the module's `tunnelProcess` handle the instant it
// SIGTERMed the child, so the 5s SIGKILL escalation it armed — which re-reads `tunnelProcess` to
// decide who to kill — never fired for the child it stopped, and if the owner restarted inside the
// 5s window the stale timer SIGKILLed the NEW tunnel. Separately, the `exit`/`error` handlers never
// asked whether the exiting child was still the current one: a late `exit` from a stopped-and-
// replaced child overwrote the new tunnel's status/pidfile/handle, and the delayed one-restart
// fired even though the tunnel had been stopped during the 2s window.
//
// Every child here is an `EventEmitter` stand-in; no real cloudflared is ever spawned.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const H = vi.hoisted(() => ({
  children: [] as unknown[],
  seq: 0,
  home: '',
}));

vi.mock('node:child_process', async (orig) => {
  const { EventEmitter } = await import('node:events');
  const real = await orig<typeof import('node:child_process')>();
  const makeChild = (): unknown => {
    const c: any = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.pid = 4242 + H.seq++;
    c.exitCode = null;
    c.signalCode = null;
    c.kill = vi.fn();
    H.children.push(c);
    return c;
  };
  return {
    ...real,
    spawn: vi.fn(() => makeChild()),
    execSync: vi.fn(() => ''),
  };
});
vi.mock('../../db/connection.js', () => ({
  getDb: () => { throw new Error('no db'); },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('./imessage-bridge.js', () => ({ sendAlert: vi.fn() }));
vi.mock('../../config/loader.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getProviderCredential: () => 'tok',
  setProviderCredential: vi.fn(),
}));
vi.mock('../../home.js', async () => {
  const osm = await import('node:os');
  const p = await import('node:path');
  H.home = p.join(osm.tmpdir(), `dojo-tunnel-stop-${process.pid}`);
  return { homeDir: () => H.home };
});

interface FakeChild {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  stdout: { emit: (ev: string, d: Buffer) => void };
  stderr: { emit: (ev: string, d: Buffer) => void };
  emit: (ev: string, ...a: unknown[]) => void;
}

const URL = 'https://dojo-123.trycloudflare.com';
const pidfile = (): string => path.join(H.home, '.dojo', 'tunnel.pid');
const child = (n: number): FakeChild => H.children[n] as FakeChild;

let tunnel: typeof import('../tunnel.js');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllTimers();
  H.children.length = 0;
  H.seq = 0;
  vi.resetModules();
  tunnel = await import('../tunnel.js');
  // `writeTunnelPidfile` writes into ~/.dojo; the logger only creates it lazily on
  // flush, so the dir is made here rather than hoped for.
  fs.mkdirSync(path.join(H.home, '.dojo'), { recursive: true });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

afterAll(() => {
  if (H.home) fs.rmSync(H.home, { recursive: true, force: true });
});

describe('stopTunnel escalation and stale-exit handling', () => {
  it('stopTunnel escalates SIGKILL on the child it stopped, even though the module handle is cleared at once', () => {
    expect(tunnel.startTunnel('quick', 3000).ok).toBe(true);
    const first = child(0);
    tunnel.stopTunnel();
    expect(first.kill).toHaveBeenCalledWith('SIGTERM');
    // The escalation lands on THAT child, not on whatever `tunnelProcess` points at now.
    vi.advanceTimersByTime(5000);
    expect(first.kill.mock.calls.map((c) => c[0])).toContain('SIGKILL');
  });

  it("a tunnel restarted within the 5s window is not SIGKILLed by the stopped child's stale timer", () => {
    tunnel.startTunnel('quick', 3000);
    const old = child(0);
    tunnel.stopTunnel();
    expect(tunnel.startTunnel('quick', 3000).ok).toBe(true);
    const fresh = child(1);
    vi.advanceTimersByTime(5000);
    // The old child's own timer kills only the old child.
    expect(old.kill.mock.calls.map((c) => c[0])).toContain('SIGKILL');
    expect(fresh.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it("a late exit from a stopped-and-replaced child leaves the new tunnel's state alone", () => {
    tunnel.startTunnel('quick', 3000);
    const old = child(0);
    tunnel.stopTunnel();
    tunnel.startTunnel('quick', 3000);
    const fresh = child(1);
    fresh.stderr.emit('data', Buffer.from(`${URL}\n`));
    expect(tunnel.getTunnelStatus().status).toBe('active');
    // The replaced child exits long after the swap.
    old.emit('exit', 0);
    // Nothing the new tunnel owns is touched: status, URL, pidfile, handle.
    const st = tunnel.getTunnelStatus();
    expect(st.status).toBe('active');
    expect(st.url).toBe(URL);
    expect(fs.existsSync(pidfile())).toBe(true);
    expect(fresh.kill).not.toHaveBeenCalled();
  });

  it("the delayed one-restart does not fire when the tunnel is stopped inside the 2s window", () => {
    tunnel.startTunnel('quick', 3000);
    const first = child(0);
    first.stderr.emit('data', Buffer.from(`${URL}\n`));
    expect(tunnel.getTunnelStatus().status).toBe('active');
    // The tunnel crashes; the exit handler arms a single delayed restart…
    first.emit('exit', 1);
    // …but the owner stops it inside the window.
    tunnel.stopTunnel();
    vi.advanceTimersByTime(2000);
    expect(H.children.length).toBe(1);
  });

  it('the delayed one-restart still fires when the tunnel was not stopped (control)', () => {
    tunnel.startTunnel('quick', 3000);
    const first = child(0);
    first.stderr.emit('data', Buffer.from(`${URL}\n`));
    expect(tunnel.getTunnelStatus().status).toBe('active');
    first.emit('exit', 1);
    vi.advanceTimersByTime(2000);
    expect(H.children.length).toBe(2);
  });
});
