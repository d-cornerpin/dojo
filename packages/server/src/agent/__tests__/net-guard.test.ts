// PHASE-0 T11 — the SSRF guard on outbound web tools.
//
// The agent's outbound web tools (web_fetch, web_browse, open_browser) take
// whatever URL the model produces. A prompt-injected or simply confused agent
// could therefore make the SERVER fetch `http://127.0.0.1:3001/api/...` (the
// platform's own API, from inside its own trust boundary), the cloud metadata
// endpoint `169.254.169.254`, or anything on the owner's LAN.
//
// `assertPublicHttpTarget` is the one owner of that decision: scheme check,
// DNS resolution, address-class check, and it RETURNS the resolved address so
// a caller can pin it.
//
// TEST HYGIENE: DNS is mocked. Nothing here touches the real network — a unit
// test that resolves real hostnames is a test that fails on a plane.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock('node:dns/promises', () => ({
  default: { lookup },
  lookup,
}));

// web_fetch's collaborators — the wiring test below drives the real webFetch,
// so its permission check and logger are stubbed and `fetch` is replaced.
vi.mock('../permissions.js', () => ({
  checkPermission: () => ({ allowed: true }),
}));
vi.mock('../../config/loader.js', () => ({
  getSearchApiKey: () => null,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));

import { assertPublicHttpTarget, NetGuardError, isPrivateAddress, privateAddressClass } from '../net-guard.js';
import { webFetch } from '../web-tools.js';

/** DNS answer shape `dns.lookup(host, { all: true })` returns. */
function answers(...addresses: string[]) {
  return addresses.map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4,
  }));
}

beforeEach(() => {
  lookup.mockReset();
  // Default: any un-stubbed hostname would be a test bug, not a public host.
  lookup.mockRejectedValue(new Error('unexpected DNS lookup in a unit test'));
});

describe('assertPublicHttpTarget — literal addresses (no DNS)', () => {
  // The plan's Step-1 cases, verbatim.
  const blocked = [
    ['http://127.0.0.1:3001', 'the platform’s own API on loopback'],
    ['http://127.0.0.1:3001/api/health', 'loopback with a path'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://[::1]:8080', 'IPv6 loopback'],
    ['http://10.0.0.5', 'RFC1918 10/8'],
    ['http://192.168.1.10', 'RFC1918 192.168/16'],
    ['http://172.16.0.1', 'RFC1918 172.16/12 lower bound'],
    ['http://172.31.255.255', 'RFC1918 172.16/12 upper bound'],
    ['http://100.64.0.1', 'CGNAT 100.64/10'],
    ['http://0.0.0.0:3001', '0/8 "this network" — reaches localhost on most stacks'],
    ['http://[::]', 'IPv6 unspecified'],
    ['http://[fc00::1]', 'IPv6 unique-local fc00::/7'],
    ['http://[fd12:3456:789a::1]', 'IPv6 unique-local fd00::/8'],
    ['http://[fe80::1]', 'IPv6 link-local fe80::/10'],
    ['http://[febf::1]', 'IPv6 link-local upper bound of the /10'],
    ['http://224.0.0.1', 'IPv4 multicast'],
    ['http://255.255.255.255', 'IPv4 broadcast'],
    ['http://198.18.0.1', 'benchmarking 198.18/15'],
  ] as const;

  for (const [url, why] of blocked) {
    it(`refuses ${url} (${why})`, async () => {
      await expect(assertPublicHttpTarget(url)).rejects.toBeInstanceOf(NetGuardError);
      expect(lookup).not.toHaveBeenCalled(); // a literal IP never needs DNS
    });
  }

  it('allows a public literal IP and pins it', async () => {
    const res = await assertPublicHttpTarget('http://93.184.216.34/x');
    expect(res.address).toBe('93.184.216.34');
    expect(res.href).toBe('http://93.184.216.34/x');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('allows 172.32.0.1 — one past the RFC1918 172.16/12 block', async () => {
    const res = await assertPublicHttpTarget('http://172.32.0.1');
    expect(res.address).toBe('172.32.0.1');
  });

  it('allows a public IPv6 literal', async () => {
    const res = await assertPublicHttpTarget('http://[2606:4700:4700::1111]/');
    expect(res.address).toBe('2606:4700:4700::1111');
  });
});

describe('assertPublicHttpTarget — the IPv4-mapped IPv6 bypass', () => {
  // `::ffff:127.0.0.1` is the classic way past a guard that string-matches
  // "127." — and Node's URL parser rewrites it to the hex form `::ffff:7f00:1`,
  // which defeats a string match on the dotted form too.
  it('refuses http://[::ffff:127.0.0.1] (dotted mapped form)', async () => {
    await expect(assertPublicHttpTarget('http://[::ffff:127.0.0.1]/')).rejects.toBeInstanceOf(NetGuardError);
  });

  it('refuses the hex spelling of the same address (::ffff:7f00:1)', async () => {
    await expect(assertPublicHttpTarget('http://[::ffff:7f00:1]/')).rejects.toBeInstanceOf(NetGuardError);
  });

  it('refuses a mapped metadata address (::ffff:169.254.169.254)', async () => {
    await expect(assertPublicHttpTarget('http://[::ffff:169.254.169.254]/')).rejects.toBeInstanceOf(NetGuardError);
  });

  it('refuses a mapped RFC1918 address (::ffff:192.168.1.10)', async () => {
    await expect(assertPublicHttpTarget('http://[::ffff:192.168.1.10]/')).rejects.toBeInstanceOf(NetGuardError);
  });

  it('refuses a mapped 172.16/12 address', async () => {
    await expect(assertPublicHttpTarget('http://[::ffff:172.20.1.1]/')).rejects.toBeInstanceOf(NetGuardError);
  });

  it('refuses the deprecated IPv4-compatible form (::10.0.0.5)', async () => {
    await expect(assertPublicHttpTarget('http://[::10.0.0.5]/')).rejects.toBeInstanceOf(NetGuardError);
  });

  it('refuses NAT64-embedded loopback (64:ff9b::127.0.0.1)', async () => {
    await expect(assertPublicHttpTarget('http://[64:ff9b::127.0.0.1]/')).rejects.toBeInstanceOf(NetGuardError);
  });

  it('allows a mapped PUBLIC address (::ffff:93.184.216.34)', async () => {
    await expect(assertPublicHttpTarget('http://[::ffff:93.184.216.34]/')).resolves.toBeTruthy();
  });
});

describe('assertPublicHttpTarget — hostnames go through DNS', () => {
  it('refuses a hostname that resolves to 192.168.1.10', async () => {
    lookup.mockResolvedValue(answers('192.168.1.10'));
    await expect(assertPublicHttpTarget('http://intranet.example.test/')).rejects.toBeInstanceOf(NetGuardError);
    expect(lookup).toHaveBeenCalledWith('intranet.example.test', { all: true });
  });

  it('refuses a hostname that resolves to the metadata address', async () => {
    lookup.mockResolvedValue(answers('169.254.169.254'));
    await expect(assertPublicHttpTarget('http://metadata.example.test/latest')).rejects.toBeInstanceOf(NetGuardError);
  });

  it('refuses a hostname that resolves to ::1', async () => {
    lookup.mockResolvedValue(answers('::1'));
    await expect(assertPublicHttpTarget('http://localhost.example.test/')).rejects.toBeInstanceOf(NetGuardError);
  });

  it('refuses when ANY answer is private, even if another is public', async () => {
    // A DNS-rebinding style answer set: one public A record, one internal.
    lookup.mockResolvedValue(answers('93.184.216.34', '10.1.2.3'));
    await expect(assertPublicHttpTarget('http://mixed.example.test/')).rejects.toBeInstanceOf(NetGuardError);
  });

  it('refuses an empty answer set', async () => {
    lookup.mockResolvedValue([]);
    await expect(assertPublicHttpTarget('http://nothing.example.test/')).rejects.toBeInstanceOf(NetGuardError);
  });

  it('refuses the decimal-encoded spelling of 127.0.0.1 (getaddrinfo resolves it)', async () => {
    lookup.mockResolvedValue(answers('127.0.0.1'));
    await expect(assertPublicHttpTarget('http://2130706433/')).rejects.toBeInstanceOf(NetGuardError);
  });

  it('passes a public hostname and returns the resolved address to pin', async () => {
    lookup.mockResolvedValue(answers('93.184.216.34'));
    const res = await assertPublicHttpTarget('https://example.com/page?q=1');
    expect(res.address).toBe('93.184.216.34');
    expect(res.href).toBe('https://example.com/page?q=1');
  });

  it('lets a genuine DNS failure through as the DNS error, not a guard refusal', async () => {
    // Fail-closed either way (nothing was reached), but web_fetch has a
    // friendly "that domain does not resolve" branch keyed on ENOTFOUND and
    // wrapping the error would silently kill it.
    const dnsErr = Object.assign(new Error('getaddrinfo ENOTFOUND nope.example.test'), { code: 'ENOTFOUND' });
    lookup.mockRejectedValue(dnsErr);
    await expect(assertPublicHttpTarget('http://nope.example.test/')).rejects.toBe(dnsErr);
  });
});

describe('assertPublicHttpTarget — schemes and junk', () => {
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com/x',
    'gopher://example.com/',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
  ]) {
    it(`refuses the non-http(s) scheme in ${url.slice(0, 28)}`, async () => {
      await expect(assertPublicHttpTarget(url)).rejects.toBeInstanceOf(NetGuardError);
      expect(lookup).not.toHaveBeenCalled();
    });
  }

  it('refuses an unparseable URL', async () => {
    await expect(assertPublicHttpTarget('not a url at all')).rejects.toBeInstanceOf(NetGuardError);
  });

  it('carries the offending url and address on the error', async () => {
    const err = await assertPublicHttpTarget('http://127.0.0.1:3001/api/health').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetGuardError);
    expect((err as NetGuardError).url).toBe('http://127.0.0.1:3001/api/health');
    expect((err as NetGuardError).address).toBe('127.0.0.1');
    expect((err as NetGuardError).message).toMatch(/127\.0\.0\.1/);
  });
});

describe('isPrivateAddress / privateAddressClass', () => {
  it('names the class it blocked on', () => {
    expect(privateAddressClass('127.0.0.1')).toMatch(/loopback/i);
    expect(privateAddressClass('169.254.169.254')).toMatch(/link-local|metadata/i);
    expect(privateAddressClass('10.0.0.5')).toMatch(/private/i);
    expect(privateAddressClass('fc00::1')).toMatch(/unique-local|private/i);
    expect(privateAddressClass('93.184.216.34')).toBeNull();
  });

  it('fails closed on anything that is not an IP address', () => {
    expect(isPrivateAddress('example.com')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
    expect(isPrivateAddress('999.999.999.999')).toBe(true);
  });

  it('strips an IPv6 zone id before judging (fe80::1%en0)', () => {
    expect(isPrivateAddress('fe80::1%en0')).toBe(true);
  });
});

// ── The wiring: web_fetch is the one entry point that follows redirects ──
//
// web_fetch already walked redirects MANUALLY (`redirect: 'manual'`) so it
// could re-run the per-domain permission check on each hop. The guard therefore
// goes INSIDE that loop: a public URL that 302s to 127.0.0.1 must be refused at
// the second hop, not fetched. (browser.ts and captureSiteScreenshot hand the
// URL to Playwright, which follows redirects internally — those are guarded at
// the requested URL only; per-hop is Phase 5's net broker.)
describe('web_fetch wiring — the guard runs per redirect hop', () => {
  const realFetch = globalThis.fetch;
  let fetched: string[] = [];

  beforeEach(() => {
    fetched = [];
    lookup.mockResolvedValue(answers('93.184.216.34'));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Serve a canned redirect chain / body without touching the network. */
  function stubFetch(route: (url: string) => Response) {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetched.push(url);
      return Promise.resolve(route(url));
    }) as typeof globalThis.fetch;
  }

  it('refuses when a public URL redirects to loopback, and never fetches it', async () => {
    stubFetch((url) =>
      url.startsWith('https://example.com')
        ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3001/api/health' } })
        : new Response('SHOULD NEVER BE READ', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );

    const out = await webFetch('agent-under-test', { url: 'https://example.com/start' });

    expect(out).toMatch(/Permission denied/);
    expect(out).toMatch(/127\.0\.0\.1/);
    expect(out).not.toMatch(/SHOULD NEVER BE READ/);
    expect(fetched).toEqual(['https://example.com/start']); // hop 2 never left
  });

  it('refuses the metadata endpoint on the FIRST hop without fetching', async () => {
    stubFetch(() => new Response('SHOULD NEVER BE READ', { status: 200 }));

    const out = await webFetch('agent-under-test', { url: 'http://169.254.169.254/latest/meta-data/' });

    expect(out).toMatch(/Permission denied/);
    expect(fetched).toEqual([]);
  });

  it('still fetches an ordinary public page', async () => {
    stubFetch(() => new Response('<html><body>hello world</body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }));

    const out = await webFetch('agent-under-test', { url: 'https://example.com/page' });

    expect(out).toMatch(/hello world/);
    expect(fetched).toEqual(['https://example.com/page']);
  });
});
