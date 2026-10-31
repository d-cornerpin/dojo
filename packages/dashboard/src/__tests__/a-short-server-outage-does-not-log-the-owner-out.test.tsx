// ════════════════════════════════════════════════════════════════════════════
// A SERVER RESTART OF FIFTEEN SECONDS MUST NOT LOG THE OWNER OUT.
//
// `hooks/useWebSocket.ts` counted consecutive failed sockets and, at five,
// decided the token must be bad: it deleted `dojo_token` and sent the owner to
// /login. But the reconnect backoff is 1s, 2s, 4s, 8s — a server simply
// restarting for an update closes the socket five times within ~15 seconds with
// the token perfectly fine. A refused token already has its own signals: close
// code 1008 (the server's rejection) and the `exp` claim read in `connect()`.
// Unreachable is not invalid, so five plain closes must just keep retrying.
//
// The socket is faked (happy-dom's real one would try to reach a server the
// tripwire forbids); `window.location` is a plain writable object so a
// redirect is an observable field write, not a navigation.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { WebSocketProvider, useWebSocket } from '../hooks/useWebSocket';

// ── The fake socket: stores every instance; helpers fire onopen/onclose ──

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  close(): void { this.readyState = FakeWebSocket.CLOSED; }
  send(): void { /* nothing listens in these tests */ }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }
  closeWith(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

const StatusProbe = () => {
  const { connectionStatus } = useWebSocket();
  return <div>{connectionStatus}</div>;
};

const mount = () => render(
  <WebSocketProvider>
    <StatusProbe />
  </WebSocketProvider>,
);

// The backoff waits a down server produces: 1s, 2s, 4s, 8s, 16s, then the 30s
// cap — eight closes in a row, the first five inside ~15 seconds.
const OUTAGE_WAITS = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];

/** Close the newest socket with 1006 eight times, waiting between as the backoff says. */
const sitThroughOutage = () => {
  OUTAGE_WAITS.forEach((wait, i) => {
    act(() => { FakeWebSocket.instances[i].closeWith(1006); });
    act(() => { vi.advanceTimersByTime(wait); });
    expect(FakeWebSocket.instances.length, `backoff wait ${i + 1} opens a new socket`).toBe(i + 2);
  });
};

// A JWT-shaped token with an unexpired `exp`, so `connect()`'s expiry check
// passes and only an outage — never the token — could explain a logout.
const FUTURE_TOKEN = `x.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.y`;

let locationStub: { href: string; protocol: string; host: string };
let realLocation: PropertyDescriptor | undefined;

beforeEach(() => {
  // `window.location` becomes a writable object: a redirect is a field write,
  // and `connect()` still finds the `protocol`/`host` it needs for the URL.
  realLocation = Object.getOwnPropertyDescriptor(window, 'location');
  locationStub = { href: 'http://localhost:3000/', protocol: 'http:', host: 'localhost:3000' };
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: locationStub });
  localStorage.setItem('dojo_token', FUTURE_TOKEN);
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'location');
  if (realLocation) Object.defineProperty(window, 'location', realLocation);
});

describe('an unreachable server is never treated as a bad token', () => {
  it('eight closes with 1006 keep the token, open a new socket each time, and never redirect', () => {
    mount();
    sitThroughOutage();
    expect(localStorage.getItem('dojo_token'), 'the token survives the outage').toBeTruthy();
    expect(locationStub.href, 'no redirect to /login').not.toBe('/login');
  });

  it('the newest socket still connects once the server is back', () => {
    mount();
    sitThroughOutage();
    act(() => { FakeWebSocket.instances[FakeWebSocket.instances.length - 1].open(); });
    expect(screen.getByText('connected')).toBeTruthy();
  });

  it('a 1008 from the server still clears the token and goes to login', () => {
    mount();
    act(() => { FakeWebSocket.instances[0].closeWith(1008); });
    expect(localStorage.getItem('dojo_token')).toBeNull();
    expect(locationStub.href).toBe('/login');
  });
});
