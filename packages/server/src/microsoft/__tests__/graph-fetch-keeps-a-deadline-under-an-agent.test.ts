// The Graph byte door promises two things: the agent's Stop, and — to a site that passed no
// `signal` — `GRAPH_TIMEOUT_MS` too. Under an agent the second promise was broken: the slot's
// Stop-only signal was dialled into `fetch`, so the timeout operand never ran, and
// `openAgentCall` composes only the clocks it is GIVEN — none were. The sibling transports
// (`microsoft/client.ts`, `google/client.ts`, `agent/web-tools.ts`) pass
// `AbortSignal.timeout(...)` INTO `openAgentCall`; this pins the same here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../agent/abortable-call.js', () => ({
  STOPPED_BY_USER: 'stopped by user',
  openAgentCall: vi.fn((_agent: string, _scope: string, ...externals: Array<AbortSignal | undefined>) => {
    const ctl = new AbortController();
    const present = externals.filter(Boolean) as AbortSignal[];
    return {
      signal: present.length ? AbortSignal.any([ctl.signal, ...present]) : ctl.signal,
      refused: false,
      cutByStop: () => false,
      cutBy: () => null,
      release: vi.fn(),
    };
  }),
}));

import { openAgentCall, STOPPED_BY_USER } from '../../agent/abortable-call.js';
import { graphFetch, GRAPH_TIMEOUT_MS } from '../graph-fetch.js';

const GRAPH_URL = 'https://graph.microsoft.com/v1.0/me/drive/items/x/content';
const realFetch = globalThis.fetch;

let hang = false;
const dialled: Array<AbortSignal | null | undefined> = [];

// The stub records the signal every dial carries; when told to hang it refuses to settle until
// that very signal aborts, and then rejects with its reason — the way a stalled endpoint dies.
const fetchMock = vi.fn((_url: string, init: RequestInit = {}) => {
  dialled.push(init.signal);
  if (!hang) return Promise.resolve(new Response('ok'));
  return new Promise<Response>((_resolve, reject) => {
    const signal = init.signal as AbortSignal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
});

beforeEach(() => {
  hang = false;
  dialled.length = 0;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockClear();
  vi.mocked(openAgentCall).mockClear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('graphFetch — the deadline survives an agent owning the call', () => {
  it('dials the default clock INTO the slot when the caller brought none', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    await graphFetch('agent-1', GRAPH_URL);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(GRAPH_TIMEOUT_MS);
    expect(vi.mocked(openAgentCall).mock.calls[0][2], 'the slot was handed no clock to compose').toBeInstanceOf(AbortSignal);
  });

  it('a caller that brought its own signal keeps exactly that clock, with nothing stacked on it', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const mine = new AbortController().signal;
    await graphFetch('agent-1', GRAPH_URL, { signal: mine });
    expect(vi.mocked(openAgentCall).mock.calls[0][2]).toBe(mine);
    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it('an ownerless call still gets the default clock, and registers with nobody', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    await graphFetch(undefined, GRAPH_URL);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(GRAPH_TIMEOUT_MS);
    expect(dialled[0]).toBeInstanceOf(AbortSignal);
    expect(openAgentCall).not.toHaveBeenCalled();
  });

  it('the deadline reports itself when it fires — never as a stop', async () => {
    const timeoutCtl = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutCtl.signal);
    hang = true;
    const inFlight = graphFetch('agent-1', GRAPH_URL);
    timeoutCtl.abort(new DOMException('deadline', 'TimeoutError'));
    const err = await inFlight.catch((e: unknown) => e as Error);
    expect((err as Error).name).toBe('TimeoutError');
    expect((err as Error).message).not.toBe(STOPPED_BY_USER);
    expect(vi.mocked(openAgentCall).mock.results[0].value.release).toHaveBeenCalledTimes(1);
  }, 2000);
});
