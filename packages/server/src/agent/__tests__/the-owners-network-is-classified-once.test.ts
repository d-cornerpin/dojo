// v3.5 field fix 3, review round 2 (REVIEW.md "Re-review", R6): `doomGuardApplies` (agent/stream-patience.ts).
//   1. Tailscale (100.64.0.0/10, `*.ts.net`) is the owner's own machines: local.
//   2. A bare single-word host is NOT local by its name: a Docker proxy (`http://gateway:4000`) in front of cloud
//      models would be capped, against OR-FIELD3 (a). CHOICE: classify by provider type and address, never by
//      resolving the name (a DNS lookup from the leaf module is a new way out of the engine, pinned by
//      `only-the-audited-door-can-reach-the-wire`). Ollama is local by type; any other type is local only at a local
//      or private address or a local-only name. A bare host is cloud WHATEVER it resolves to, and DNS is never asked.
//   3. The machine's own names and interface addresses are read once per process, not per check: the router runs the
//      check per candidate inside its 2ms budget (`selector-latency.test.ts`).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';

const dnsAnswers = vi.hoisted(() => ({ map: new Map<string, string[] | null>(), calls: [] as string[] }));
vi.mock('node:dns', () => {
  const lookup = (host: string, _opts: unknown, cb: (err: Error | null, addrs: Array<{ address: string; family: number }>) => void): void => {
    dnsAnswers.calls.push(host);
    const a = dnsAnswers.map.get(host);
    setImmediate(() => (a ? cb(null, a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))) : cb(new Error('ENOTFOUND'), [])));
  };
  return { default: { lookup }, lookup };
});

import * as patience from '../stream-patience.js';

const { doomGuardApplies } = patience;
/** Optional so the file also runs (red) against the build before the cache existed. */
const resetCache = (patience as { __resetOwnersNetworkCacheForTests?: () => void }).__resetOwnersNetworkCacheForTests;

const compat = (baseUrl: string): boolean => doomGuardApplies({ providerType: 'openai-compatible', providerBaseUrl: baseUrl });
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => {
  resetCache?.();
  dnsAnswers.map.clear();
  dnsAnswers.calls.length = 0;
});

describe('Tailscale is the owner\'s own machines', () => {
  it.each([
    ['100.64.0.1 (low edge)', 'http://100.64.0.1:1234/v1'],
    ['100.127.255.254 (high edge)', 'http://100.127.255.254:1234/v1'],
    ['a MagicDNS name', 'http://studio.tailnet-1234.ts.net:1234/v1'],
  ])('%s is local', (_l, url) => { expect(compat(url)).toBe(true); });

  it.each([
    ['100.63.255.255 (just below)', 'http://100.63.255.255:1234/v1'],
    ['100.128.0.1 (just above)', 'http://100.128.0.1:1234/v1'],
  ])('CONTROL: %s is not', (_l, url) => { expect(compat(url)).toBe(false); });
});

describe('a bare single-word host is classified by type and address, never by its name or what it resolves to', () => {
  it('a proxy-like host that resolves PUBLIC is cloud (the full window), and DNS is never asked', async () => {
    dnsAnswers.map.set('gateway', ['203.0.113.7']);
    expect(compat('http://gateway:4000/v1')).toBe(false);
    await tick(); await tick();
    expect(compat('http://gateway:4000/v1')).toBe(false);
    expect(dnsAnswers.calls).toEqual([]);
  });

  it('a bare host that resolves PRIVATE is still cloud by the chosen rule (name the box by its address or .local)', async () => {
    dnsAnswers.map.set('studio', ['192.168.1.20']);
    expect(compat('http://studio:1234/v1')).toBe(false);
    await tick(); await tick();
    expect(compat('http://studio:1234/v1')).toBe(false);
    expect(compat('http://192.168.1.20:1234/v1'), 'the same box by its address keeps its guard').toBe(true);
    expect(compat('http://studio.local:1234/v1'), 'and by its mDNS name').toBe(true);
    expect(dnsAnswers.calls).toEqual([]);
  });

  it('Ollama is local by TYPE, bare host or not', () => {
    expect(doomGuardApplies({ providerType: 'ollama', providerBaseUrl: 'http://gpu:11434' })).toBe(true);
  });

  it('this machine\'s own hostname is local without asking DNS', () => {
    const own = os.hostname().toLowerCase();
    expect(compat(`http://${own}:1234/v1`)).toBe(true);
    expect(dnsAnswers.calls).toEqual([]);
  });
});

describe('the classification is cheap enough for the router', () => {
  const AVG_BUDGET_MS = 2;
  const ITERATIONS = 200;
  const CANDIDATES = [
    'https://api.example.com/v1', 'http://192.168.1.20:1234/v1', 'http://studio.local:8080/v1', 'https://openrouter.ai/api',
    'http://10.0.4.7:8000/v1', 'http://[fe80::1]:8000/v1', 'http://100.70.1.2:1234/v1', 'https://api.example.org/v1',
    'http://studio.tailnet-1234.ts.net/v1', 'http://127.0.0.1:1234/v1', 'http://gateway:4000/v1', 'https://203.0.113.10/v1',
    'http://172.20.0.3:8000/v1', 'http://gpu.lan:8080/v1', 'http://[fd12::7]:8000/v1', 'https://api.example.net/v1',
    'http://169.254.1.1:8000/v1', 'http://mini.home.arpa/v1', 'http://localhost:11434', 'https://cloud.example.com/v1',
  ];

  it(`a 20-candidate pass averages under ${AVG_BUDGET_MS}ms over ${ITERATIONS} passes, and the interfaces are read once`, () => {
    expect(CANDIDATES).toHaveLength(20);
    const spy = vi.spyOn(os, 'networkInterfaces');
    for (const url of CANDIDATES) compat(url);   // warm (the one interface read)
    const started = performance.now();
    for (let i = 0; i < ITERATIONS; i++) for (const url of CANDIDATES) compat(url);
    const avgMs = (performance.now() - started) / ITERATIONS;
    console.log(`[R6] doomGuardApplies, 20 candidates: ${avgMs.toFixed(4)}ms per pass (budget ${AVG_BUDGET_MS}ms)`);
    expect(avgMs).toBeLessThan(AVG_BUDGET_MS);
    expect(spy.mock.calls.length, 'once per process, not per check').toBeLessThanOrEqual(1);
    spy.mockRestore();
  });
});
