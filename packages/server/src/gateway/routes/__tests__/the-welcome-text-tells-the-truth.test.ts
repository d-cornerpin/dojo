// ════════════════════════════════════════════════════════════════════════════
// THE WELCOME TEXT TELLS THE TRUTH — sent means sent.
//
// `POST /imessage/welcome` awaited `sendIMessage` — which returns false when
// neither the imsg tool nor AppleScript got through (`imessage-bridge.ts`) —
// threw the result away, and always answered `{ sent: true }`, so the setup
// screen told the owner the text went out when it did not. It checked only
// `!recipient`, so a number reached `startIMBridge` before any 400.
//
// The ruling: a recipient must be a non-blank string or the route answers the
// existing 400 before the bridge starts, and a send that did not go through
// says so — the bridge having started is still true, so the 502 says that too.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sent: Array<{ to: string; text: string }> = [];
let sendResult = true;
const startIMBridgeSpy = vi.fn();

vi.mock('../../../services/imessage-bridge.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../services/imessage-bridge.js');
  return {
    ...actual,
    getIMBridgeStatus: () => ({ running: true, enabled: true, connected: true }),
    getDefaultSender: () => '+15550100',
    getSafeSenders: () => [{ address: '+15550100', name: 'Owner', is_primary: true }, { address: 'friend@example.test', name: 'Friend' }],
    sendIMessage: async (to: string, text: string) => { sent.push({ to, text }); return sendResult; },
    startIMBridge: (...args: unknown[]) => startIMBridgeSpy(...args),
  };
});
vi.mock('../../../agent/v2/outbound.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../agent/v2/outbound.js');
  return { ...actual, withOutboundAsyncIfAbsent: async (_o: unknown, fn: () => Promise<unknown>) => fn() };
});

import { servicesRouter } from '../services.js';

const post = (body: unknown): Promise<Response> =>
  servicesRouter.request('/imessage/welcome', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => { sent.length = 0; sendResult = true; startIMBridgeSpy.mockClear(); });

describe('the welcome text tells the truth', () => {
  it('a send that went through answers 200 and sent:true', async () => {
    const res = await post({ recipient: '+15550100' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: { sent: boolean } };
    expect(body.data.sent).toBe(true);
  });

  it('⚠ a send that did not go through answers 502, not sent:true', async () => {
    sendResult = false;
    const res = await post({ recipient: '+15550100' });
    expect(res.status).toBe(502);
    const body = await res.json() as { ok: boolean; data: { sent: boolean } };
    expect(body.ok).toBe(false);
    expect(body.data.sent).toBe(false);
  });

  it('⚠ a recipient that is not a string is a 400, and the bridge is not started', async () => {
    const res = await post({ recipient: 12345 });
    expect(res.status).toBe(400);
    expect(startIMBridgeSpy).not.toHaveBeenCalled();
  });

  it('⚠ a blank recipient is a 400', async () => {
    const res = await post({ recipient: '   ' });
    expect(res.status).toBe(400);
  });
});
