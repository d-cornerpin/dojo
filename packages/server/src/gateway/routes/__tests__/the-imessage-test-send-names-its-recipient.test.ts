// ════════════════════════════════════════════════════════════════════════════
// THE iMESSAGE TEST SEND NAMES ITS RECIPIENT — and refuses anyone off the list.
//
// `POST /imessage/test` demanded a `recipient`, but the dashboard's test box
// posted only `{ message }`, so every test send answered 400. A recipient that
// DID arrive went straight to `sendIMessage`, whose text path revalidates nothing
// (the attachment path does, `imessage-bridge.ts`), and the route threw the
// return value away: a send where neither imsg nor AppleScript got through still
// answered `{ sent: true }`.
//
// The ruling: the recipient is a typed field the owner fills (prefilled with the
// starred owner address, which `GET /imessage` now serves), an address not on
// the approved list is refused with a clear message, the send goes to the
// approved record's own address, and a send that did not go through says so.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sent: Array<{ to: string; text: string }> = [];
let sendResult = true;

vi.mock('../../../services/imessage-bridge.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../services/imessage-bridge.js');
  return {
    ...actual,
    getIMBridgeStatus: () => ({ running: true, enabled: true, connected: true }),
    getDefaultSender: () => '+15550100',
    getSafeSenders: () => [{ address: '+15550100', name: 'Owner', is_primary: true }, { address: 'friend@example.test', name: 'Friend' }],
    sendIMessage: async (to: string, text: string) => { sent.push({ to, text }); return sendResult; },
  };
});
vi.mock('../../../agent/v2/outbound.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../agent/v2/outbound.js');
  return { ...actual, withOutboundAsyncIfAbsent: async (_o: unknown, fn: () => Promise<unknown>) => fn() };
});

import { servicesRouter } from '../services.js';

const post = (body: unknown): Promise<Response> =>
  servicesRouter.request('/imessage/test', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => { sent.length = 0; sendResult = true; });

describe('the iMessage test send names its recipient', () => {
  it('GET /imessage serves the owner address for the dashboard to prefill', async () => {
    const res = await servicesRouter.request('/imessage');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: { ownerAddress: string | null } };
    expect(body.data.ownerAddress).toBe('+15550100');
  });

  it('⚠ an address off the approved list is refused, and nothing is sent', async () => {
    const res = await post({ recipient: 'stranger@example.test', message: 'hi' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.error).toContain('is not on your approved iMessage list');
    expect(sent).toEqual([]);
  });

  it('an approved recipient receives at the approved record’s own address', async () => {
    const res = await post({ recipient: 'friend@example.test', message: 'hi' });
    expect(res.status).toBe(200);
    expect(sent).toEqual([{ to: 'friend@example.test', text: 'hi' }]);
  });

  it('⚠ a send that did not go through answers 502, not sent:true', async () => {
    sendResult = false;
    const res = await post({ recipient: 'friend@example.test', message: 'hi' });
    expect(res.status).toBe(502);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.error).toContain('did not go through');
  });

  it('a missing recipient is still a 400', async () => {
    const res = await post({ message: 'hi' });
    expect(res.status).toBe(400);
  });
});
