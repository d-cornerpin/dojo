// A stuck Hume socket (server never hangs up, network dropped) used to leak the
// 50ms tick: when the 10s cap fired, resolve ran but the interval was never
// cleared, so it kept firing for the rest of the process life. The cap must
// clear the interval after itself.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('hume', () => ({ HumeClient: class {} }));

vi.mock('../../config/loader.js', () => ({ getProviderCredential: () => null }));

vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop,
    setLogBroadcast: noop,
    readLogEntries: () => [],
  };
});

const { HumeStreamSession } = await import('../hume-engine.js');

// A session whose socket never emits 'close'. close() nulls the socket on
// return, so the close mock is handed back separately to assert on.
function sessionWithStuckSocket(): {
  session: HumeStreamSession;
  close: ReturnType<typeof vi.fn>;
} {
  const session = new HumeStreamSession({ voiceId: 'fake-voice', agentId: 'agent-1' });
  const close = vi.fn();
  (session as unknown as { socket: unknown }).socket = {
    sendPublish: vi.fn(),
    close,
    on: vi.fn(),
  };
  return { session, close };
}

describe('a stuck Hume close leaves no timer behind', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the 10s cap clears the 50ms tick', async () => {
    vi.useFakeTimers();
    const { session, close } = sessionWithStuckSocket();
    const p = session.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(vi.getTimerCount()).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('a prompt socket close leaves no timer (control)', async () => {
    vi.useFakeTimers();
    const { session } = sessionWithStuckSocket();
    (session as unknown as { sawSocketClose: boolean }).sawSocketClose = true;
    const p = session.close();
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });
});
