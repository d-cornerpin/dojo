// One owner for the SHAPE of every engine-emitted marker: the literals and the anchored and unanchored
// matchers built from them. It does not own MEMBERSHIP (which shapes enter a summary, are hidden, or count as
// inter-agent traffic): those are separate policies and each consumer keeps its own list.

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function anchored(prefixes: readonly string[]): RegExp {
  return new RegExp(`^\\s*(${prefixes.map(esc).join('|')})`, 'i');
}

function anywhere(prefixes: readonly string[]): RegExp {
  return new RegExp(`(${prefixes.map(esc).join('|')})`, 'i');
}


export const A2A_ENVELOPE_PREFIX = '[A2A:';

export const A2A_LEGACY_SOURCE_PREFIXES: readonly string[] = [
  '[SOURCE: AGENT MESSAGE FROM',
  '[SOURCE: GROUP BROADCAST FROM',
  '[SOURCE: PM AGENT POKE FROM',
];

export const A2A_INBOUND_PREFIXES: readonly string[] = [
  A2A_ENVELOPE_PREFIX,
  ...A2A_LEGACY_SOURCE_PREFIXES,
];

// The one inbound-A2A row matcher, case-insensitive (a human message opening `[a2a:` reads as peer traffic).
export const A2A_INBOUND_RE = anchored(A2A_INBOUND_PREFIXES);
export const A2A_INBOUND_ANYWHERE_RE = anywhere(A2A_INBOUND_PREFIXES);

export const A2A_ENVELOPE_RE = /^\[A2A:([A-Z]+)\s+thread:([^\s\]]+)\s+from:([^\]]+)\]/;

export const A2A_LEGACY_SOURCE_RE =
  /^\[SOURCE: (?:AGENT MESSAGE|GROUP BROADCAST|PM AGENT POKE) FROM ([^\]]+)\]/i;

/** Thread id inside a marker: never hex-only, because named thread ids exist. */
export const A2A_THREAD_RE = /thread:([^\s\]]+)/;

/** Thread-id characters a marker carries; a stored id may be full or a marker token. */
export const A2A_THREAD_SHORT_LENGTH = 8;

// The token comes from the id without its `thread-` prefix (the varying region). Every reader compares stored
// FULL ids through this, never `substr(id, 1, 8)`.
export function a2aThreadShort(threadId: string): string {
  return threadId.replace(/^thread-/, '').slice(0, A2A_THREAD_SHORT_LENGTH);
}

/** The legacy front slice: only resolves markers already in history, never used to write one. */
export function a2aThreadShortLegacy(threadId: string): string {
  return threadId.slice(0, A2A_THREAD_SHORT_LENGTH);
}

export function a2aThreadTokenMatches(markerToken: string, fullThreadId: string): boolean {
  if (!markerToken || !fullThreadId) return false;
  return markerToken === a2aThreadShort(fullThreadId)
    || markerToken === a2aThreadShortLegacy(fullThreadId);
}

// SQL twin of a2aThreadTokenMatches; bind the marker token twice (legacy slice, then current form).
export function a2aThreadTokenMatchesSql(column: string): string {
  const stripped = `CASE WHEN ${column} LIKE 'thread-%' THEN substr(${column}, 8) ELSE ${column} END`;
  return `(substr(${column}, 1, ${A2A_THREAD_SHORT_LENGTH}) = ?`
    + ` OR substr(${stripped}, 1, ${A2A_THREAD_SHORT_LENGTH}) = ?)`;
}

export function parseA2AThreadShort(content: string | null | undefined): string | null {
  if (!content) return null;
  const m = A2A_THREAD_RE.exec(content);
  return m ? m[1].slice(0, A2A_THREAD_SHORT_LENGTH) : null;
}


// Platform plumbing, not peer traffic. The A2A forms are absent on purpose: platform-noise.ts keeps an A2A
// deliverable as vault memory, and compaction layers its own A2A check on top.
export const PLATFORM_SOURCE_ENVELOPE_PREFIXES: readonly string[] = [
  '[SOURCE: TRACKER TASK',
  '[SOURCE: SCHEDULER',
  '[SOURCE: HEALER',
  '[SOURCE: ENGINE',
  '[SOURCE: SUB-AGENT COMPLETION',
  '[SOURCE: SYSTEM',
  '[SOURCE: AGENT HEALTH ALERT',
  '[SOURCE: AGENT NOTICE',
];

export const SOURCE_ENVELOPE_PREFIXES: readonly string[] = [
  ...A2A_LEGACY_SOURCE_PREFIXES,
  ...PLATFORM_SOURCE_ENVELOPE_PREFIXES,
];

export const SOURCE_ENVELOPE_ANYWHERE_RE = anywhere(SOURCE_ENVELOPE_PREFIXES);

export const SOURCE_ENVELOPE_OPENER = '[SOURCE:';


export const ENGINE_SCAFFOLD_PREFIXES: readonly string[] = [
  '[System:',
  '[System note',
  '[SYSTEM',
  '[Engine',
  '[ENGINE',
  '[CONTINUITY BRIEF',
  '[Context note',
  '[DOJO',
];

export const ENGINE_SCAFFOLD_RE = anchored(ENGINE_SCAFFOLD_PREFIXES);

// Engine notes memory/assembler.ts puts ahead of a turn open with this, so platform-noise.ts filters them.
export const CONTEXT_NOTE_PREFIX = '[Context note:';

export const ENGINE_INJECTION_PREFIXES: readonly string[] = [
  '[Engine hint:',
  '[Engine note:',
  '[System note:',
];


// Both `[New Session]` and the dated `[New Session: ...]` are live; `formatDivider` builds another shape.
export const NEW_SESSION_BRACKET_RE = /^\s*\[New Session[\]:]/i;
export const NEW_SESSION_BRACKET_ANYWHERE_RE = /\[New Session[\]:]/i;


export const TECHNIQUE_FRESH_SENTINEL = '══ TECHNIQUE FRESH READ ══';

export const TECHNIQUE_FRESH_HEADER_RE = /^══ TECHNIQUE FRESH READ ══ (.+?) \(/;

export function parseTechniqueFreshRead(content: string | null | undefined): string | null {
  if (!content) return null;
  const m = TECHNIQUE_FRESH_HEADER_RE.exec(content);
  return m ? m[1] : null;
}
