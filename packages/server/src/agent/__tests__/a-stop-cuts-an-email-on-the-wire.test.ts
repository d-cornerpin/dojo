// v3.5 field fix 3, audit W17 (owner card 2026-10-17: "Try to cancel the send too"): A STOP CUTS AN
// EMAIL THAT IS ON THE WIRE.
//
// The audit read the abort registry's direct callers (model calls) and concluded an in-flight Gmail /
// Outlook / Teams send is only abandoned, not cancelled. The send doors do register: every Gmail write
// goes through `googleWrite` and every Graph write through `msGraphWrite` / `graphFetch`, each of which
// opens a stop slot (`openAgentCall`), and `stopAgent` aborts every registered call (`scope: 'all'`).
// This suite drives the real client doors with the wire held open and proves the stop cuts the request
// (the HTTP call is aborted, not waited for), on the exact abort `stopAgent` makes. What the executor
// then tells the owner (whether the send had already gone out) is `stop-race.ts`'s own suite.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../google/auth.js', () => ({ getValidAccessTokenForAccount: async () => 'test-token' }));
vi.mock('../../google/accounts.js', () => ({ getGoogleAccount: () => ({ id: 'agent', kind: 'agent', email: 'agent@example.com' }) }));
vi.mock('../../google/activity-log.js', () => ({ logGoogleActivity: () => {} }));
vi.mock('../../microsoft/auth.js', () => ({ getValidAccessTokenForAccount: async () => 'test-token' }));
vi.mock('../../microsoft/accounts.js', () => ({ getMicrosoftAccount: () => ({ id: 'agent', kind: 'agent', email: 'agent@example.com' }) }));
vi.mock('../../microsoft/activity-log.js', () => ({ logMicrosoftActivity: () => {} }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../v2/outbound.js', () => ({ recordAtDoor: () => {}, inOutboundScope: () => false, recordedId: () => null }));

import { googleWrite } from '../../google/client.js';
import { msGraphWrite, graphFetch } from '../../microsoft/client.js';
import { STOPPED_BY_USER } from '../abortable-call.js';
import { abortInFlight, activeAbortControllers } from '../shared-state.js';

const AGENT = 'stop-email-agent';
let seen: AbortSignal[] = [];

beforeEach(() => {
  seen = [];
  // The wire: a request that never answers on its own, and fails the way fetch does when aborted.
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_res, rej) => {
    const s = init?.signal as AbortSignal;
    seen.push(s);
    s.addEventListener('abort', () => rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  })));
});
afterEach(() => { vi.unstubAllGlobals(); activeAbortControllers.delete(AGENT); });

/** The exact abort `stopAgent` makes (`agent/runtime.ts`), once the request is on the wire. */
async function stopWhileOnTheWire<T>(send: Promise<T>): Promise<T> {
  for (let i = 0; i < 50 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(seen).toHaveLength(1);
  expect(abortInFlight(AGENT, 'user-stop', { scope: 'all' })).toBeGreaterThan(0);
  return send;
}

describe('W17: Stop cancels an email send that is in flight', () => {
  it('a Gmail send (gmail_send\'s own door, googleWrite): the request is aborted and reads as the user\'s stop', async () => {
    const out = await stopWhileOnTheWire(googleWrite('POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { raw: 'x' }, AGENT, 'Agent', 'gmail_send', {}));
    expect(seen[0].aborted).toBe(true);
    expect(out).toMatchObject({ ok: false, error: STOPPED_BY_USER });
  });

  it('an Outlook send (outlook_send\'s door, msGraphWrite me/sendMail): the request is aborted', async () => {
    const out = await stopWhileOnTheWire(msGraphWrite('POST', 'me/sendMail', { message: {} }, AGENT, 'Agent', 'outlook_send', {}));
    expect(seen[0].aborted).toBe(true);
    expect(out).toMatchObject({ ok: false, error: STOPPED_BY_USER });
  });

  it('a raw Graph send (graphFetch, the Teams and upload door): the request is aborted', async () => {
    await expect(stopWhileOnTheWire(graphFetch(AGENT, 'https://graph.microsoft.com/v1.0/chats/c1/messages', { method: 'POST', body: '{}' })))
      .rejects.toThrow(STOPPED_BY_USER);
    expect(seen[0].aborted).toBe(true);
  });

  it('CONTROL: an abort that is not the user\'s stop is not reported as one', async () => {
    const send = googleWrite('POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { raw: 'x' }, AGENT, 'Agent', 'gmail_send', {});
    for (let i = 0; i < 50 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    abortInFlight(AGENT, 'urgent-preempt', { scope: 'all' });
    const out = await send;
    expect(out.ok).toBe(false);
    expect(out.error).not.toBe(STOPPED_BY_USER);
  });
});
