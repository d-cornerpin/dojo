// ════════════════════════════════════════════════════════════════════════
// Outbound network guard — the ONE owner of "may the server fetch this URL?"
// (PHASE-0 T11)
//
// The agent's outbound web tools take whatever URL the model produces, and the
// model's input includes untrusted text (inbound email, iMessage, web pages,
// peer agents). Without this check a prompt-injected or merely confused agent
// can make the SERVER — which sits inside the trust boundary — reach:
//
//   • `http://127.0.0.1:3001/api/...`  the platform's own API
//   • `http://169.254.169.254/latest/` cloud instance metadata (credentials)
//   • `http://192.168.x.x/`            anything on the owner's LAN
//
// This module was extracted from the copy that already lived inline in
// `gateway/routes/system.ts` (the og-preview route, added when the dashboard
// began auto-previewing every link in every inbound message). That route now
// imports from here: one address-class judgement on the platform, not two that
// drift. The extraction also fixed two real holes in the original — it string-
// matched `::ffff:127.` for IPv4-mapped IPv6, which Node's URL parser rewrites
// to the hex form `::ffff:7f00:1`, and it covered only fe80 of fe80::/10.
//
// SCOPE, stated honestly:
//   • This is an address-class refusal, not a capability grant. There is no
//     allowlist bypass in Phase 0 — Phase 5's net broker owns grants.
//   • `assertPublicHttpTarget` returns the RESOLVED address so a caller CAN
//     pin it. Callers that hand the URL to `fetch` or Playwright do NOT pin:
//     those stacks resolve DNS again themselves, so a hostile DNS server can
//     answer public here and private there (DNS rebinding). Closing that needs
//     connect-to-IP-with-Host-header (or a proxy), which is Phase 5's broker.
// ════════════════════════════════════════════════════════════════════════

import dns from 'node:dns/promises';
import net from 'node:net';

/** Thrown when a URL is refused. Carries what was asked for and what it hit. */
export class NetGuardError extends Error {
  readonly url: string;
  readonly address: string | null;

  constructor(message: string, url: string, address: string | null = null) {
    super(message);
    this.name = 'NetGuardError';
    this.url = url;
    this.address = address;
  }
}

// ── IPv4 ──

/** The class name if `ip` (a valid dotted quad) is non-public, else null. */
function ipv4Class(ip: string): string | null {
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0) return 'this-network (0.0.0.0/8)';
  if (a === 10) return 'private (RFC1918 10/8)';
  if (a === 127) return 'loopback (127/8)';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT (100.64/10)';
  if (a === 169 && b === 254) return 'link-local / cloud metadata (169.254/16)';
  if (a === 172 && b >= 16 && b <= 31) return 'private (RFC1918 172.16/12)';
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'IETF-reserved (192.0.0/24, 192.0.2/24)';
  if (a === 192 && b === 168) return 'private (RFC1918 192.168/16)';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmarking (198.18/15)';
  if (a >= 224) return 'multicast / reserved / broadcast (224/4, 240/4)';
  return null;
}

// ── IPv6 ──

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null if unparseable.
 * Handles `::` compression, a trailing dotted-quad (`::ffff:127.0.0.1`) and a
 * zone id (`fe80::1%en0`). Parsing rather than string-matching is the point:
 * the same address has several spellings and only one of them is obvious.
 */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (s.length === 0) return null;

  // Rewrite a trailing dotted quad into the two hex groups it stands for.
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    if (cut === -1) return null;
    const v4 = s.slice(cut + 1);
    if (!net.isIPv4(v4)) return null;
    const o = v4.split('.').map(Number);
    s = `${s.slice(0, cut + 1)}${(((o[0] << 8) | o[1]) >>> 0).toString(16)}:${(((o[2] << 8) | o[3]) >>> 0).toString(16)}`;
  }

  const parseGroup = (g: string): number => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN);

  const halves = s.split('::');
  if (halves.length > 2) return null;

  let parts: number[];
  if (halves.length === 2) {
    const left = halves[0] === '' ? [] : halves[0].split(':');
    const right = halves[1] === '' ? [] : halves[1].split(':');
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    parts = [...left.map(parseGroup), ...Array<number>(fill).fill(0), ...right.map(parseGroup)];
  } else {
    const groups = s.split(':');
    if (groups.length !== 8) return null;
    parts = groups.map(parseGroup);
  }

  if (parts.length !== 8 || parts.some((n) => !Number.isInteger(n))) return null;
  return parts;
}

/** The dotted quad embedded in the last 32 bits of an expanded IPv6 address. */
function embeddedV4(g: number[]): string {
  return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
}

/** The class name if `ip` (a valid IPv6 literal) is non-public, else null. */
function ipv6Class(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (!g) return 'unparseable IPv6 address';

  const zeroTo4 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;

  // IPv4-mapped ::ffff:0:0/96 — the classic bypass, in either spelling.
  if (zeroTo4 && g[5] === 0xffff) {
    const inner = ipv4Class(embeddedV4(g));
    return inner ? `IPv4-mapped ${inner}` : null;
  }

  // ::, ::1, and the deprecated IPv4-compatible ::a.b.c.d.
  if (zeroTo4 && g[5] === 0) {
    if (g[6] === 0 && g[7] === 0) return 'unspecified (::)';
    if (g[6] === 0 && g[7] === 1) return 'loopback (::1)';
    const inner = ipv4Class(embeddedV4(g));
    return inner ? `IPv4-compatible ${inner}` : null;
  }

  // NAT64 well-known prefix 64:ff9b::/96 also carries an IPv4 destination.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    const inner = ipv4Class(embeddedV4(g));
    return inner ? `NAT64-embedded ${inner}` : null;
  }

  if ((g[0] & 0xfe00) === 0xfc00) return 'unique-local / private (fc00::/7)';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local (fe80::/10)';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast (ff00::/8)';
  return null;
}

// ── Public API ──

/**
 * Name the non-public address class `ip` belongs to, or null if it is a public
 * internet address. Anything that is not a valid IP literal returns a class
 * (fail closed) — the caller asked "is this safe to reach", and "I cannot tell"
 * is never yes.
 */
export function privateAddressClass(ip: string): string | null {
  const version = net.isIP(ip);
  if (version === 4) return ipv4Class(ip);
  if (version === 6) return ipv6Class(ip);
  // A zone id makes net.isIP say "no" while the OS would still route it.
  if (ip.includes('%')) return ipv6Class(ip);
  return 'not an IP address';
}

/** True when `ip` is loopback / private / link-local / metadata / ULA / junk. */
export function isPrivateAddress(ip: string): boolean {
  return privateAddressClass(ip) !== null;
}

/**
 * Refuse `raw` unless it is an http(s) URL whose host resolves entirely to
 * public internet addresses. Returns the normalised href and the resolved
 * address so a caller can pin it.
 *
 * Throws `NetGuardError` on a bad scheme, an unparseable URL, an empty answer
 * set, or any non-public address. A genuine DNS failure (ENOTFOUND, SERVFAIL)
 * is re-thrown UNCHANGED: nothing was reached either way, and web_fetch has a
 * friendly "that domain does not resolve" branch keyed on the DNS error text
 * that wrapping would silently kill.
 */
export async function assertPublicHttpTarget(raw: string): Promise<{ href: string; address: string }> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new NetGuardError(`Blocked: "${raw}" is not a valid URL.`, raw);
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new NetGuardError(
      `Blocked: outbound web tools only speak http and https, not "${u.protocol}" (${raw}).`,
      raw,
    );
  }

  // WHATWG URL keeps the brackets on an IPv6 host; net.isIP does not want them.
  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '');

  if (net.isIP(host)) {
    const klass = privateAddressClass(host);
    if (klass) {
      throw new NetGuardError(
        `Blocked: ${raw} points at ${host}, which is a ${klass} address. Outbound web tools may only reach public internet addresses.`,
        raw,
        host,
      );
    }
    return { href: u.href, address: host };
  }

  // dns.lookup (getaddrinfo) rather than dns.resolve on purpose: it applies the
  // same resolution the OS will apply to the real connection, including
  // /etc/hosts and the numeric spellings (`http://2130706433/` → 127.0.0.1).
  const resolved = await dns.lookup(host, { all: true });

  if (resolved.length === 0) {
    throw new NetGuardError(`Blocked: "${host}" resolved to no addresses (${raw}).`, raw);
  }

  for (const answer of resolved) {
    const klass = privateAddressClass(answer.address);
    if (klass) {
      throw new NetGuardError(
        `Blocked: "${host}" resolves to ${answer.address}, which is a ${klass} address. Outbound web tools may only reach public internet addresses.`,
        raw,
        answer.address,
      );
    }
  }

  return { href: u.href, address: resolved[0].address };
}
