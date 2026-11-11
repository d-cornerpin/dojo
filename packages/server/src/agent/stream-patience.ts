import os from 'node:os';

// HOW LONG TO WAIT FOR A PROVIDER: the standing bounds, and when a provider's own declaration
// replaces them. A leaf module so the schema door and the model reader share one pair of constants.

// An endpoint that accepted a request and said nothing for ninety seconds is a dead connection.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = 90_000;
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

// FLOOR 10s: a typo cannot fail every call. CEILING 30min: patience outliving its turn is a hang.
export const STREAM_PATIENCE_MIN_MS = 10_000;
export const STREAM_PATIENCE_MAX_MS = 30 * 60_000;

export interface DeclaredPatience {
  firstChunkTimeoutMs: number | null;
  streamIdleTimeoutMs: number | null;
}

export interface StreamPatience {
  firstChunkMs: number;
  idleMs: number;
  /** True iff `firstChunkMs` came from the provider's own declaration, not the standing default.
   *  Blowing through a self-declared bound forfeits the same-model retry: it re-dials cold. */
  firstChunkDeclared: boolean;
  /** The same fact for `idleMs`: the Ollama native path and the log line must not take a default for a declaration. */
  idleDeclared: boolean;
}

// Coherent = whole, positive, under the ceiling; no floor on purpose (the write door has one). Never a throw.
function isCoherent(stored: unknown): stored is number {
  if (typeof stored !== 'number' || !Number.isInteger(stored)) return false;
  if (stored <= 0 || stored > STREAM_PATIENCE_MAX_MS) return false;
  return true;
}

function honour(stored: unknown, standing: number): number {
  return isCoherent(stored) ? stored : standing;
}

/** Reads the declared-patience columns (NULL = standing constants); bounds resolve INDEPENDENTLY. */
export function resolveStreamPatience(declared?: DeclaredPatience | null): StreamPatience {
  return {
    firstChunkMs: honour(declared?.firstChunkTimeoutMs, STREAM_FIRST_CHUNK_TIMEOUT_MS),
    idleMs: honour(declared?.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_MS),
    firstChunkDeclared: isCoherent(declared?.firstChunkTimeoutMs),
    idleDeclared: isCoherent(declared?.streamIdleTimeoutMs),
  };
}

// A first-chunk timeout on a declared patience gets its own code: recovery must not re-dial the unfinishable.
export const DECLARED_PATIENCE_EXCEEDED_CODE = 'declared_patience_exceeded';
export const STREAM_IDLE_TIMEOUT_CODE = 'stream_idle_timeout';

// The transport has its own timers; the watchdog must stay the binding bound, or the abort is not ours.

/** undici's unconfigured `headersTimeout`/`bodyTimeout`: a fact about Node's fetch, not our choice. */
export const TRANSPORT_DEFAULT_TIMEOUT_MS = 300_000;

/** The SDK's own time-to-headers timer: still a ceiling when a server withholds headers till tokens. */
export const TRANSPORT_REQUEST_TIMEOUT_DEFAULT_MS = 600_000;

/** Slack so the watchdog always beats the transport's coarse, differently-started timers. */
export const TRANSPORT_MARGIN_MS = 30_000;

export interface TransportTimeouts {
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
  requestTimeoutMs: number;
}

/** The clock this patience needs, or `null` when today's defaults already cover it. */
export function resolveTransportTimeouts(patience: StreamPatience): TransportTimeouts | null {
  const headersNeeded = patience.firstChunkMs + TRANSPORT_MARGIN_MS;
  const bodyNeeded = Math.max(patience.firstChunkMs, patience.idleMs) + TRANSPORT_MARGIN_MS;
  if (headersNeeded <= TRANSPORT_DEFAULT_TIMEOUT_MS && bodyNeeded <= TRANSPORT_DEFAULT_TIMEOUT_MS) {
    return null;
  }
  return {
    headersTimeoutMs: Math.max(TRANSPORT_DEFAULT_TIMEOUT_MS, headersNeeded),
    bodyTimeoutMs: Math.max(TRANSPORT_DEFAULT_TIMEOUT_MS, bodyNeeded),
    requestTimeoutMs: Math.max(TRANSPORT_REQUEST_TIMEOUT_DEFAULT_MS, headersNeeded),
  };
}

// Floor 1 and ceiling 100000: a typo either way lands on "feature off", never on "refuse every call".
export const PREFILL_THROUGHPUT_MIN_TOK_PER_SEC = 1;
export const PREFILL_THROUGHPUT_MAX_TOK_PER_SEC = 100_000;

function isCoherentThroughput(stored: unknown): stored is number {
  if (typeof stored !== 'number' || !Number.isInteger(stored)) return false;
  if (stored < PREFILL_THROUGHPUT_MIN_TOK_PER_SEC || stored > PREFILL_THROUGHPUT_MAX_TOK_PER_SEC) return false;
  return true;
}

// A declared throughput always beats the ledger's: an override a machine can silently overrule is not one.
export type PrefillThroughputSource = 'declared' | 'measured';

export interface ResolvedPrefillThroughput {
  tokensPerSec: number;
  source: PrefillThroughputSource;
}

/** `null` = feature off; a refusal names its `source`. Measured is floored, not rounded (a max of lower bounds). */
export function resolvePrefillThroughput(
  declaredTokensPerSec: number | null | undefined,
  measuredTokensPerSec?: number | null,
): ResolvedPrefillThroughput | null {
  if (isCoherentThroughput(declaredTokensPerSec)) {
    return { tokensPerSec: declaredTokensPerSec, source: 'declared' };
  }
  const floored = typeof measuredTokensPerSec === 'number' && Number.isFinite(measuredTokensPerSec)
    ? Math.floor(measuredTokensPerSec)
    : null;
  if (isCoherentThroughput(floored)) {
    return { tokensPerSec: floored, source: 'measured' };
  }
  return null;
}

/** Largest input the prefill speed can chew in declared patience; `null` when undeclared (gate off). */
export function resolveDoomCeiling(
  declaredPatienceMs: number,
  prefillTokensPerSec: number | null | undefined,
  measuredPrefillTokensPerSec?: number | null,
): number | null {
  const resolved = resolvePrefillThroughput(prefillTokensPerSec, measuredPrefillTokensPerSec);
  if (resolved === null) return null;
  const usableMs = Math.max(0, declaredPatienceMs - TRANSPORT_MARGIN_MS);
  return Math.floor((usableMs / 1000) * resolved.tokensPerSec);
}

// THE DOOM GUARD IS LOCAL-ONLY: on a cloud provider the measured rate is a cached lower bound, so
// it would cap a huge window. LOCAL = Ollama by type or a URL on the owner's own network, no DNS guesswork.

export const LOCAL_PROVIDER_TYPES: ReadonlySet<string> = new Set(['ollama']);

function hostOf(baseUrl: string): string | null {
  try {
    const h = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`).hostname.toLowerCase();
    return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  } catch { return null; }
}

/** Does this URL point at this machine? The PARSED hostname decides, never a substring. */
export function isThisMachineUrl(baseUrl: string): boolean {
  const host = hostOf(baseUrl);
  return host !== null && (host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host));
}

function isLocalAddress(addr: string): boolean {
  const a6 = addr.toLowerCase();
  if (a6 === '::1' || a6 === '::') return true;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a6);
  if (v4) {
    const a = Number(v4[1]); const b = Number(v4[2]);
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return a6.includes(':') && /^(fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}):/.test(a6);
}
const LOCAL_NAME_SUFFIXES = ['.local', '.lan', '.home.arpa', '.localhost', '.ts.net'];

// Read once per process: the router checks every candidate inside a strict latency budget.
let ownNamesCache: ReadonlySet<string> | null = null;
function ownNames(): ReadonlySet<string> {
  if (ownNamesCache) return ownNamesCache;
  const names = new Set<string>();
  try {
    const h = os.hostname().toLowerCase();
    names.add(h);
    names.add(h.replace(/\.local$/, ''));
    for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) names.add(i.address.toLowerCase());
  } catch { /* unreadable: the address classes still decide */ }
  ownNamesCache = names;
  return names;
}

export function __resetOwnersNetworkCacheForTests(): void {
  ownNamesCache = null;
}

export function isOwnersNetworkUrl(baseUrl: string): boolean {
  const host = hostOf(baseUrl);
  if (host === null || host === '') return false;
  if (host === 'localhost' || isLocalAddress(host)) return true;
  if (LOCAL_NAME_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return ownNames().has(host);   // a bare single-word host is NOT local by its name
}

export function doomGuardApplies(provider: { providerType: string | null | undefined; providerBaseUrl: string | null | undefined }): boolean {
  if (provider.providerType && LOCAL_PROVIDER_TYPES.has(provider.providerType)) return true;
  return typeof provider.providerBaseUrl === 'string' && isOwnersNetworkUrl(provider.providerBaseUrl);
}

// The admission budget and the compaction trigger size off the context window alone; they must
// see the box's speed too. Half the ceiling, not the boundary: a plan there tips on an off day.
export const PROVIDER_CEILING_SAFETY = 0.5;

/** Caps a budget at the ceiling's safety fraction: min, never a widening; null-vs-zero is the caller's. */
export function providerAwareBudgetTokens(modelCtxBudget: number, ceiling: number): number {
  return Math.min(modelCtxBudget, Math.floor(ceiling * PROVIDER_CEILING_SAFETY));
}
