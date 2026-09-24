import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  TELEMETRY_WHITELIST, TELEMETRY_SCHEMA_VERSION, UNRECOGNISED, ABSENT, whitelistField, enumMembers,
} from '../telemetry-whitelist.js';
import { buildTelemetry, type TelemetrySources } from '../telemetry-build.js';
import { iso } from '../telemetry-coerce.js';

const KINDS = ['enum', 'count', 'millis', 'bytes', 'timestamp', 'ordinal', 'bool', 'version', 'digest'];

/** The kinds whose domain is a declared shape rather than a declared member list. */
const SHAPE_KINDS = ['version', 'digest'];

const srcOf = (file: string): string =>
  fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

const importsOf = (file: string): string[] =>
  [...srcOf(file).matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map(m => m[1]);

function sources(over: Partial<TelemetrySources> = {}): TelemetrySources {
  return {
    reportId: 'rep_test', createdAt: '2026-09-23T10:00:00.000Z', signature: 'ds1-000000000000',
    lane: 'tool-error', platformVersion: '3.1.28', osPlatform: 'darwin', nodeMajor: 22,
    windowMinutes: 30, windowTurns: 4, windowTruncated: false,
    turns: [], calls: [], toolCalls: [], work: [],
    settings: {
      providerKind: 'ollama', behavesLike: null, firstChunkTimeoutMs: null, streamIdleTimeoutMs: null,
      maxUnattendedMinutes: null, prefillTokensPerSec: null, toolsGrantedCount: 12,
      contextReceiptMode: 'off',
    },
    ...over,
  };
}

/** Every array section populated, every nullable field non-null: the source that should
 *  make the builder emit the whitelist's WHOLE leaf set and not one key more. */
function fullSources(): TelemetrySources {
  return sources({
    turns: [{ kind: 'user', subjectKind: 'conv', lane: 'voice', exitReason: 'answered',
              answered: true, effectfulCalls: 2, durationMs: 4100 }],
    calls: [{ providerKind: 'ollama', modelOrdinal: 0, requestType: 'agent_turn',
              inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0,
              latencyMs: 900, inputTokensEstimated: false }],
    toolCalls: [{ name: 'load_tool_docs', actionType: 'tool_call', result: 'success',
                  argShape: [{ key: 'tools', type: 'array', bytes: 24 }],
                  argsTotalBytes: 32, failureHitCount: 0 }],
    work: [{ kind: 'task', state: 'open', ageMinutes: 5 }],
    settings: {
      providerKind: 'ollama', behavesLike: 'deepseek-native', firstChunkTimeoutMs: 1000,
      streamIdleTimeoutMs: 2000, maxUnattendedMinutes: 30, prefillTokensPerSec: 900,
      toolsGrantedCount: 12, contextReceiptMode: 'off',
    },
  });
}

/** Collapse an emitted path onto the singular path the whitelist declares. */
const singular = (p: string): string =>
  p.replace(/^turns\./, 'turn.').replace(/^calls\./, 'call.')
    .replace(/^tools\./, 'tool.').replace(/^work\./, 'work.');

/**
 * Every LEAF path the attachment actually emits.
 * An array of primitives is a LEAF, not a container — that blind spot is what let an
 * out-of-gate `arg_values: string[]` ship green in the first cut (review I2).
 */
function emittedPaths(out: unknown): Map<string, unknown> {
  const found = new Map<string, unknown>();
  const walk = (node: unknown, prefix: string): void => {
    if (Array.isArray(node)) { for (const el of node) walk(el, prefix); return; }
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      const primitiveArray = Array.isArray(v) && v.some(el => el === null || typeof el !== 'object');
      if (v !== null && typeof v === 'object' && !primitiveArray) { walk(v, p); continue; }
      found.set(singular(p), v);
    }
  };
  walk(out, '');
  return found;
}

describe('(1) the whitelist cannot express free text', () => {
  it('declares no kind outside the closed union, and the union has no text member', () => {
    expect(KINDS).not.toContain('text');
    for (const f of TELEMETRY_WHITELIST) expect(KINDS).toContain(f.kind);
  });

  it('gives every enum field exactly one member source', () => {
    for (const f of TELEMETRY_WHITELIST.filter(x => x.kind === 'enum')) {
      const inline = f.members !== undefined;
      const derived = f.membersFrom !== undefined;
      expect(inline !== derived, `${f.path} must declare exactly one of members/membersFrom`).toBe(true);
      if (inline) expect(f.members!.length, `${f.path} declares an empty member list`).toBeGreaterThan(0);
    }
  });

  it('names a platform source for every field, and never a forbidden one', () => {
    // `audit_log.target` and `audit_log.detail` are platform-authored prose that interpolates
    // the user's file paths (agent/tools/cat/fs.ts:198-268). They are never a telemetry source.
    const FORBIDDEN = ['audit_log.target', 'audit_log.detail', 'messages.content',
      'providers.name', 'agents.name', 'work.title', 'scratchpad'];
    for (const f of TELEMETRY_WHITELIST) {
      expect(f.source.length).toBeGreaterThan(0);
      for (const bad of FORBIDDEN) {
        expect(f.source.includes(bad), `${f.path} names forbidden source ${bad}`).toBe(false);
      }
    }
  });

  it('has unique, dotted, lowercase paths', () => {
    const seen = new Set<string>();
    for (const f of TELEMETRY_WHITELIST) {
      expect(seen.has(f.path), `duplicate path ${f.path}`).toBe(false);
      seen.add(f.path);
      expect(f.path).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });

  // ── C1/C2: a string kind declares its DOMAIN, the same way an enum does ──

  it('gives every version and digest field its own anchored pattern, and no other field one', () => {
    for (const f of TELEMETRY_WHITELIST) {
      const needsShape = SHAPE_KINDS.includes(f.kind);
      expect(f.pattern !== undefined, `${f.path} (${f.kind}) must ${needsShape ? '' : 'not '}declare a pattern`)
        .toBe(needsShape);
      if (!needsShape) continue;
      const rx = f.pattern!.source;
      expect(rx.startsWith('^'), `${f.path}'s pattern is not anchored at the start`).toBe(true);
      expect(rx.endsWith('$'), `${f.path}'s pattern is not anchored at the end`).toBe(true);
      // N2: `.source` and `.global` cannot see the flag that actually defeats anchoring.
      // `/m` turns ^ and $ into LINE anchors — byte-identical source, global false — so
      // `/^ds1-[0-9a-f]{12}$/m` matches "ds1-000000000000\n<any prose at all>". `/y` is
      // stateful like `/g` and makes .test() alternate on repeat calls. No flag is legal.
      expect(f.pattern!.flags, `${f.path}'s pattern carries flags: /${f.pattern!.flags}`).toBe('');
    }
  });

  it('ties report.schema to the schema constant itself, not to a family of schemas', () => {
    const f = whitelistField('report.schema')!;
    expect(f.pattern!.test(TELEMETRY_SCHEMA_VERSION)).toBe(true);
    // Equality, not a shape: a different generation of the schema is not this field's domain.
    expect(f.pattern!.test('dojo-telemetry-2')).toBe(false);
    expect(f.pattern!.test(`x${TELEMETRY_SCHEMA_VERSION}`)).toBe(false);
  });

  // ── I3: the enum domain is bounded to frozen literal tuples of machine tokens ──

  it('admits only short machine tokens as members, and freezes every declared tuple', () => {
    const TOKEN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
    expect(Object.isFrozen(TELEMETRY_WHITELIST)).toBe(true);
    for (const f of TELEMETRY_WHITELIST) {
      expect(Object.isFrozen(f), `${f.path} is not frozen`).toBe(true);
      if (!f.members) continue;
      expect(Object.isFrozen(f.members), `${f.path}'s member list is not frozen`).toBe(true);
      for (const m of f.members) {
        expect(TOKEN.test(m), `${f.path} declares a member that is not a machine token: ${m}`).toBe(true);
      }
    }
  });

  it('declares every member list as a source literal, never a computed expression', () => {
    // The smuggling vector I3 names: `members: providerNames()` would put user-typed
    // strings inside a "declared domain" and satisfy every runtime clause above.
    const DECLARED_SPREADS = ['...BEHAVES_LIKE_PROFILES'];   // a platform `as const` tuple
    const bodies = [...srcOf('telemetry-whitelist.ts').matchAll(/members:\s*\[([\s\S]*?)\]/g)].map(m => m[1]);
    expect(bodies.length).toBe(TELEMETRY_WHITELIST.filter(f => f.members).length);
    for (const body of bodies) {
      for (const raw of body.split(',')) {
        const el = raw.trim();
        if (el === '') continue;
        const ok = /^'[a-z0-9][a-z0-9_-]*'$/.test(el) || DECLARED_SPREADS.includes(el);
        expect(ok, `member list carries a non-literal element: ${el}`).toBe(true);
      }
    }
  });
});

describe('(2) the builder takes no agent input and can reach nothing', () => {
  it('imports nothing that can reach the db, the disk, the network or an agent', () => {
    for (const file of ['telemetry-build.ts', 'telemetry-coerce.ts']) {
      for (const spec of importsOf(file)) {
        expect(
          /node:fs|node:http|node:net|node:child_process|\/db\/|\/agent\/|better-sqlite3|undici|connection/.test(spec),
          `${file} imports ${spec}`,
        ).toBe(false);
      }
    }
  });

  it('pins the whitelist to exactly the two platform modules its declarations need', () => {
    // I4: the builder's reach is transitively the whitelist's reach, and the whitelist
    // MUST import the live tool registry (clause (4)). So the honest guarantee is not
    // "it reaches nothing" — it is that this list is pinned and any widening is visible.
    expect(importsOf('telemetry-whitelist.ts').sort()).toEqual([
      '../agent/model-contract.js',
      '../agent/tools/registry.js',
    ]);
  });

  it('emits only whitelisted keys', () => {
    const out = buildTelemetry(sources({
      turns: [{ kind: 'user', subjectKind: 'conv', lane: null, exitReason: 'brake',
                answered: false, effectfulCalls: 2, durationMs: 4100 }],
    }));
    const paths = new Set(TELEMETRY_WHITELIST.map(f => f.path));
    for (const p of emittedPaths(out).keys()) {
      expect(paths.has(p), `emitted un-whitelisted key ${p}`).toBe(true);
    }
    expect((out.report as Record<string, unknown>).schema).toBe(TELEMETRY_SCHEMA_VERSION);
  });

  it('emits the whole whitelist and nothing beside it, gate included', () => {
    // M4 in one direction: a key typo silently deletes a field from every attachment.
    // I2 in the other: any value spread in AROUND `emit()` shows up as an extra path.
    const emitted = [...emittedPaths(buildTelemetry(fullSources())).keys()].sort();
    expect(emitted).toEqual(TELEMETRY_WHITELIST.map(f => f.path).sort());
  });
});

describe('(3) an unrecognised value fails CLOSED, it does not pass through', () => {
  it('replaces an off-list enum value with the sentinel, never the value', () => {
    const out = buildTelemetry(sources({
      turns: [{ kind: 'user', subjectKind: 'conv', lane: null,
                exitReason: 'exploded_spectacularly_/Users/dave/taxes.pdf',
                answered: false, effectfulCalls: 0, durationMs: 1 }],
    }));
    const turn = (out.turns as Record<string, unknown>[])[0];
    expect(turn.exit_reason).toBe(UNRECOGNISED);
    expect(JSON.stringify(out)).not.toContain('taxes.pdf');
    expect(JSON.stringify(out)).not.toContain('/Users/dave');
  });

  it('replaces an unregistered tool name and an undeclared arg key with the sentinel', () => {
    const out = buildTelemetry(sources({
      toolCalls: [{
        name: 'definitely_not_a_real_tool', actionType: 'tool_call', result: 'error',
        argShape: [{ key: 'mothers_maiden_name', type: 'string', bytes: 11 }],
        argsTotalBytes: 40, failureHitCount: 3,
      }],
    }));
    const tool = (out.tools as Record<string, unknown>[])[0];
    expect(tool.name).toBe(UNRECOGNISED);
    expect((tool.arg_shape as Record<string, unknown>[])[0].key).toBe(UNRECOGNISED);
    expect(JSON.stringify(out)).not.toContain('mothers_maiden_name');
  });

  it('keeps a REAL tool name and a REAL declared arg key', () => {
    const out = buildTelemetry(sources({
      toolCalls: [{
        name: 'load_tool_docs', actionType: 'tool_call', result: 'success',
        argShape: [{ key: 'tools', type: 'array', bytes: 24 }],
        argsTotalBytes: 32, failureHitCount: 0,
      }],
    }));
    const tool = (out.tools as Record<string, unknown>[])[0];
    expect(tool.name).toBe('load_tool_docs');
    expect((tool.arg_shape as Record<string, unknown>[])[0].key).toBe('tools');
  });

  it('nulls a non-finite number rather than emitting it', () => {
    const out = buildTelemetry(sources({
      calls: [{ providerKind: 'ollama', modelOrdinal: 0, requestType: 'agent_turn',
                inputTokens: Number.NaN, outputTokens: -5, cacheReadTokens: 0,
                cacheCreationTokens: 0, latencyMs: Infinity, inputTokensEstimated: false }],
    }));
    const call = (out.calls as Record<string, unknown>[])[0];
    expect(call.input_tokens).toBeNull();
    expect(call.output_tokens).toBeNull();
    expect(call.latency_ms).toBeNull();
  });
});

describe('(4) enumMembers reads the live platform, not a frozen copy', () => {
  it('derives tool names from the running registry', () => {
    const f = TELEMETRY_WHITELIST.find(x => x.path === 'tool.name')!;
    const members = enumMembers(f);
    expect(members).toContain('load_tool_docs');
    expect(members.length).toBeGreaterThan(50);
  });
});

describe('(5) a version or digest is checked against its OWN declared shape', () => {
  // Every probe below defeated the first cut's shared charset filter, which banned
  // characters instead of declaring a domain. None is a semver, a `ds1-` digest or
  // the schema constant, so every one of them must now come out as the sentinel.
  const PROBES: readonly [string, string][] = [
    ['prose sentence', 'the model kept saying my wife Sarah was wrong'],
    ['absolute path', '/Users/dave/taxes.pdf'],
    ['windows path', 'C:\\Users\\dave\\taxes.pdf'],
    ['email', 'dave@cornerp.in'],
    ['quoted text', '"my password is hunter2"'],
    ['bare filename', 'taxes.pdf'],
    ['bare filename 2', 'Sarah-divorce-settlement.docx'],
    ['person name', 'Dave'],
    ['full name hyphenated', 'Dave-Cliff'],
    ['provider name no space', 'DavesMacStudio'],
    ['secret-shaped', 'sk-ant-api03.abcDEF123456789'],
    ['aws-key-shaped', 'AKIAIOSFODNN7EXAMPLE'],
    ['jwt-ish fragment', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
    ['bare hostname', 'daves-mac-studio.local'],
    ['snake_case identifier', 'mothers_maiden_name'],
    ['ip address', '192.168.1.24'],
    ['64-char blob', 'A'.repeat(64)],
    ['65-char blob', 'A'.repeat(65)],
    // N2 behaviourally, not just declaratively: a valid digest, a newline, then prose.
    // JS `$` is strict end-of-input WITHOUT /m; with /m it is a line anchor and this
    // whole string is admitted. The flags clause declares the rule; this one feels it.
    ['digest then a newline then prose', 'ds1-000000000000\nthe model kept saying my wife Sarah was wrong'],
    ['version then a newline then prose', '3.1.28\nmy wife Sarah was wrong'],
  ];

  for (const [label, probe] of PROBES) {
    it(`turns a ${label} in a digest or version field into the sentinel, never the value`, () => {
      const out = buildTelemetry(sources({ signature: probe, platformVersion: probe }));
      const report = out.report as Record<string, unknown>;
      const platform = out.platform as Record<string, unknown>;
      expect(report.signature, `signature admitted a ${label}`).toBe(UNRECOGNISED);
      expect(platform.version, `version admitted a ${label}`).toBe(UNRECOGNISED);
      expect(JSON.stringify(out)).not.toContain(probe);
    });
  }

  it('keeps the REAL platform values — a semver, a ds1- signature, the schema constant', () => {
    const out = buildTelemetry(sources({
      platformVersion: '3.1.28', signature: 'ds1-9f2c1a0b4d77',
    }));
    const report = out.report as Record<string, unknown>;
    expect((out.platform as Record<string, unknown>).version).toBe('3.1.28');
    expect(report.signature).toBe('ds1-9f2c1a0b4d77');
    expect(report.schema).toBe(TELEMETRY_SCHEMA_VERSION);
  });

  it('keeps a pre-release semver and refuses a digest of the wrong length or alphabet', () => {
    expect((buildTelemetry(sources({ platformVersion: '3.2.0-rc.1' }))
      .platform as Record<string, unknown>).version).toBe('3.2.0-rc.1');
    for (const bad of ['ds1-9F2C1A0B4D77', 'ds1-9f2c1a0b4d7', 'ds1-9f2c1a0b4d777', 'ds2-9f2c1a0b4d77']) {
      expect((buildTelemetry(sources({ signature: bad })).report as Record<string, unknown>).signature,
        `signature admitted ${bad}`).toBe(UNRECOGNISED);
    }
  });

  it('bounds the version tail, so a "family" shape cannot carry a word or a wall of text', () => {
    // N3: `platform.version` is the only declared FAMILY rather than an exact artifact,
    // and an unbounded tail is not a shape. The tail is capped at short lowercase tokens.
    const ver = (v: string): unknown =>
      (buildTelemetry(sources({ platformVersion: v })).platform as Record<string, unknown>).version;
    for (const healthy of ['3.1.28', '1.0.0', '3.2.0-rc.1', '3.1.28-dev.1', '4.0.0-beta.2']) {
      expect(ver(healthy), `version refused the healthy shape ${healthy}`).toBe(healthy);
    }
    for (const bad of ['1.2.3-SarahDivorceSettlement', `1.2.3-${'A'.repeat(500)}`,
      `1.2.3-${'a'.repeat(40)}`, '1.2.3-rc.1.2.3.4', '1.2.3.4', 'v3.1.28', '3.1.28 ']) {
      expect(ver(bad), `version admitted ${bad.slice(0, 32)}`).toBe(UNRECOGNISED);
    }
  });

  it('refuses a non-string whose toString() would satisfy the pattern', () => {
    // N1: `RegExp.test` coerces through toString(), and `asShape` returns the VALUE.
    // Without the typeof guard a Buffer lands in the attachment as {"type":"Buffer",…}.
    // `TelemetrySources` declares these as `string`, but gather.ts fills them from
    // better-sqlite3, which returns `any` — a BLOB column is the realistic route.
    const hostile: unknown[] = [
      Buffer.from('ds1-9f2c1a0b4d77'),
      new String('ds1-9f2c1a0b4d77'),
      { toString: () => 'ds1-9f2c1a0b4d77' },
      ['ds1-9f2c1a0b4d77'],
    ];
    for (const value of hostile) {
      const out = buildTelemetry(sources({
        signature: value as string, platformVersion: value as string,
      }));
      const report = out.report as Record<string, unknown>;
      const platform = out.platform as Record<string, unknown>;
      expect(typeof report.signature, 'signature emitted a non-string').toBe('string');
      expect(typeof platform.version, 'version emitted a non-string').toBe('string');
      expect(report.signature).toBe(UNRECOGNISED);
      expect(platform.version).toBe(UNRECOGNISED);
      expect(JSON.stringify(out)).not.toContain('Buffer');
      expect(JSON.stringify(out)).not.toContain('ds1-9f2c1a0b4d77');
    }
  });
});

describe('(6) a null source is ABSENT, and a sentinel is never a member', () => {
  const allNull = (): TelemetrySources => sources({
    turns: [{ kind: null, subjectKind: null, lane: null, exitReason: null,
              answered: false, effectfulCalls: 0, durationMs: null }],
    calls: [{ providerKind: null, modelOrdinal: 0, requestType: null,
              inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
              latencyMs: null, inputTokensEstimated: false }],
    toolCalls: [{ name: 'load_tool_docs', actionType: null, result: null,
                  argShape: [{ key: 'tools', type: 'array', bytes: 0 }],
                  argsTotalBytes: 0, failureHitCount: 0 }],
    work: [{ kind: null, state: null, ageMinutes: 0 }],
    settings: {
      providerKind: null, behavesLike: null, firstChunkTimeoutMs: null, streamIdleTimeoutMs: null,
      maxUnattendedMinutes: null, prefillTokensPerSec: null, toolsGrantedCount: 0,
      contextReceiptMode: null,
    },
  });

  it('emits ABSENT for a null column, never a fabricated member and never UNRECOGNISED', () => {
    // `turns.exit_reason` is NULL for every OPEN turn, and an open turn is exactly what a
    // silence-lane report captures — so this is production traffic, not a hypothetical.
    const emitted = emittedPaths(buildTelemetry(allNull()));
    for (const [p, v] of emitted) {
      const f = whitelistField(p)!;
      if (f.kind !== 'enum') continue;
      const wasNull = ['turn.kind', 'turn.subject_kind', 'turn.lane', 'turn.exit_reason',
        'call.provider_kind', 'call.request_type', 'tool.action_type', 'tool.result',
        'work.kind', 'work.state', 'settings.provider_kind', 'settings.behaves_like',
        'settings.context_receipt_mode'].includes(p);
      if (!wasNull) continue;
      expect(v, `${p} fabricated a value for a null column`).toBe(ABSENT);
      expect(f.members ?? [], `${p} emitted a sentinel that is also a declared member`)
        .not.toContain(ABSENT);
    }
  });

  it('never emits an enum value that is not a declared member of its own field', () => {
    for (const src of [fullSources(), allNull()]) {
      for (const [p, v] of emittedPaths(buildTelemetry(src))) {
        const f = whitelistField(p)!;
        if (f.kind !== 'enum' || typeof v !== 'string') continue;
        if (v === ABSENT || v === UNRECOGNISED) continue;
        expect(enumMembers(f, 'load_tool_docs').includes(v),
          `${p} emitted ${v}, which its declared domain does not contain`).toBe(true);
      }
    }
  });

  it('declares the real request_type domain, so healthy traffic is not sentinelled', () => {
    // I5: five of the six originally pinned members had zero writers. These are measured
    // from the live writers (agent/model.ts, tools/cat/media.ts, services/*).
    const f = whitelistField('call.request_type')!;
    for (const real of ['agent_turn', 'light', 'standard', 'heavy', 'budget_fallback',
      'ollama', 'agent-sdk', 'completion', 'image_generation', 'transcription',
      'music_generation', 'audio_generation', 'video_generation']) {
      expect(f.members, `request_type does not admit the live value ${real}`).toContain(real);
    }
    const out = buildTelemetry(sources({
      calls: [{ providerKind: 'ollama', modelOrdinal: 0, requestType: 'standard',
                inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
                latencyMs: 1, inputTokensEstimated: false }],
    }));
    expect((out.calls as Record<string, unknown>[])[0].request_type).toBe('standard');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// (7) THE ONE TIMESTAMP ON THE ATTACHMENT IS UTC — ON EVERY BOX (final review, FR-4).
//
// `report.created_at` is the whitelist's only `'timestamp'` row and `iso()` is its only
// coercer. The value handed to it is the `dojo_reports.created_at` column, whose DEFAULT is
// SQLite's `datetime('now')` — a UTC instant written as `YYYY-MM-DD HH:MM:SS`, with no `T`
// and no zone. That shape is not ISO 8601, so `new Date(s)` falls to V8's LEGACY parser,
// which reads a zoneless stamp as LOCAL time; the instant is then re-spelled as UTC by
// `toISOString()` and comes out shifted by the reporter's own offset.
//
// TWO THINGS ARE WRONG WITH THAT AND ONLY ONE OF THEM IS ACCURACY:
//   • the attachment states a time the box did not record, on a public page; and
//   • the difference between that stamp and the issue's own GitHub timestamp is the
//     reporter's UTC offset — a location fact about the user, published by the platform,
//     which no whitelist row declares and no owner approved. `collect.ts` names this exact
//     trap in its header and defends against it with `julianday`; this is the same trap one
//     file over, at the T1/T3 boundary, where nothing owned it.
//
// THE CLAUSES BELOW PIN THE BOX'S ZONE THEMSELVES rather than trusting the runner's. A clause
// that only asserted an exact ISO string would be unfalsifiable on a machine at UTC+0 — there
// is nothing to fail there — so `TZ` is set to a HALF-HOUR zone for the duration, which also
// refuses a "round to whole hours" repair.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('(7) the stored stamp is UTC, and the attachment says so on every box', () => {
  /** Byte-for-byte what `datetime('now')` writes into `dojo_reports.created_at`. */
  const STORED = '2026-09-24 07:00:00';
  const SAME_INSTANT = '2026-09-24T07:00:00.000Z';

  /** +05:30. A whole-hour zone would let a fix that rounds to hours ride green. */
  const inZone = <T>(tz: string, fn: () => T): T => {
    const before = process.env.TZ;
    process.env.TZ = tz;
    try { return fn(); } finally {
      if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    }
  };

  it('the reporter\'s offset never reaches the stamp — the stored shape is read as UTC', () => {
    // Non-vacuity: prove the zone actually took, or the assertion below is about nothing.
    inZone('Asia/Kolkata', () => {
      expect(new Date(STORED).toISOString(),
        'TZ did not take in this runtime — this clause would pass over an unshifted parse')
        .not.toBe(SAME_INSTANT);
      expect(iso(STORED), 'the stored UTC stamp was shifted by the reporter\'s offset').toBe(SAME_INSTANT);
    });
  });

  it('...and the same stamp on a third zone gives the same instant, so nothing is local', () => {
    const answers = ['Asia/Kolkata', 'America/Los_Angeles', 'Europe/Berlin', 'UTC']
      .map(tz => inZone(tz, () => iso(STORED)));
    expect(new Set(answers).size,
      'the attachment\'s timestamp depends on where the reporter is sitting').toBe(1);
    expect(answers[0]).toBe(SAME_INSTANT);
  });

  it('carries that instant onto the attachment itself, through the real builder', () => {
    inZone('Asia/Kolkata', () => {
      const out = buildTelemetry(sources({ createdAt: STORED }));
      expect((out.report as Record<string, unknown>).created_at).toBe(SAME_INSTANT);
    });
  });

  it('an already-ISO stamp is not shifted the other way', () => {
    // The repair must not become a second conversion applied to a value that needs none.
    inZone('Asia/Kolkata', () => {
      expect(iso(SAME_INSTANT)).toBe(SAME_INSTANT);
      expect(iso('2026-09-24T07:00:00Z')).toBe(SAME_INSTANT);
      expect(iso('2026-09-24T07:00:00+05:30')).toBe('2026-09-24T01:30:00.000Z');
    });
  });

  it('still fails CLOSED on anything that is not an instant', () => {
    for (const bad of [null, undefined, '', 'yesterday', '2026-13-45 99:99:99', 'taxes.pdf']) {
      expect(iso(bad as string | null | undefined), `${String(bad)} was read as a time`).toBeNull();
    }
  });
});
