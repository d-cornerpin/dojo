// ════════════════════════════════════════════════════════════════════════════
// THE TELEMETRY BUILDER — THE ONLY PRODUCER OF AN ATTACHMENT (DOJO-REPORT T1)
//
// `buildTelemetry` is the single function that turns platform facts into the
// object that rides along on a public GitHub issue. It is deliberately the
// dullest module in the feature, and every dull thing about it is load-bearing:
//
//  1. IT TAKES NO AGENT INPUT. Its one argument is a `TelemetrySources` record
//     of platform-measured facts, gathered by `report/gather.ts` from the
//     platform's own tables. No agent string, no brief, no tool result and no
//     user message has a way in — not because we filter them, but because there
//     is no parameter to put one in.
//
//  2. IT CAN REACH NOTHING. It imports exactly one module: the whitelist. So it
//     cannot widen its own inputs without that widening being VISIBLE as a new
//     import — which is why the conformance test reads this file's import list
//     statically and refuses `node:fs`, `/db/`, `/agent/`, `better-sqlite3` and
//     friends. An edit that "just needs the provider name" has to break that
//     clause to get it, in a diff a reviewer is looking straight at.
//
//  3. IT BUILDS BY ITERATING THE WHITELIST, never by iterating its input — that
//     is what `emit()` below is for. A field deleted from the whitelist
//     disappears from the attachment; a value computed here that the whitelist
//     does not declare is silently NOT emitted. Construction, never redaction:
//     the failure mode is a missing field.
//
//  4. EVERY VALUE GOES THROUGH A COERCER. An off-domain enum becomes `UNRECOGNISED`,
//     never the value and never a silent drop; a non-finite or negative number and
//     an unparseable timestamp both become `null`.
//
// ── WHY THERE ARE FOUR COERCERS AND NOT THREE ──
// The plan pinned three (`nonNeg`, `iso`, `asEnum`) and, in the same breath, the
// stronger rule: "it never writes a value it did not route through one of them".
// Those two cannot both hold — `'version'` and `'digest'` are strings no enum
// declares and no number coercer accepts, so with three the platform version and
// the report signature would be the only raw values written. `asToken` closes
// that hole. The stronger rule wins: it is what the privacy model rests on.
//
// ── WHY `asEnum` MAPS NULL TO `'none'` AND NOT TO `UNRECOGNISED` ──
// A null column is a FACT ("this turn had no lane"), not a failure to recognise
// something, and a triager reading `<unrecognised>` would hunt a bug that is not
// there. Every nullable enum field declares `'none'` as a member, so it is
// on-domain by declaration rather than by exception.
// ════════════════════════════════════════════════════════════════════════════

import {
  TELEMETRY_WHITELIST, TELEMETRY_SCHEMA_VERSION, UNRECOGNISED, whitelistField, enumMembers,
} from './telemetry-whitelist.js';

// ── What the gather phase hands in. Platform facts only; no agent text. ──
export interface TurnFacts {
  kind: string | null; subjectKind: string | null; lane: string | null;
  exitReason: string | null; answered: boolean; effectfulCalls: number; durationMs: number | null;
}
export interface CallFacts {
  providerKind: string | null; modelOrdinal: number; requestType: string | null;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number;
  latencyMs: number | null; inputTokensEstimated: boolean;
}
export interface ToolCallFacts {
  name: string; actionType: string | null; result: string | null;
  argShape: readonly { key: string; type: string; bytes: number }[];
  argsTotalBytes: number; failureHitCount: number;
}
export interface WorkFacts { kind: string | null; state: string | null; ageMinutes: number }
export interface SettingsFacts {
  providerKind: string | null; behavesLike: string | null;
  firstChunkTimeoutMs: number | null; streamIdleTimeoutMs: number | null;
  maxUnattendedMinutes: number | null; prefillTokensPerSec: number | null;
  toolsGrantedCount: number; contextReceiptMode: string | null;
}

export interface TelemetrySources {
  readonly reportId: string;
  readonly createdAt: string;         // ISO
  readonly signature: string;
  readonly lane: string;
  readonly platformVersion: string;
  readonly osPlatform: string;
  readonly nodeMajor: number;
  readonly windowMinutes: number;
  readonly windowTurns: number;
  readonly windowTruncated: boolean;
  readonly turns: readonly TurnFacts[];
  readonly calls: readonly CallFacts[];
  readonly toolCalls: readonly ToolCallFacts[];
  readonly work: readonly WorkFacts[];
  readonly settings: SettingsFacts;
}

export interface TelemetryAttachment { readonly [k: string]: unknown }

// ── The coercers. Nothing is written that did not come out of one of these. ──

const nonNeg = (n: number | null | undefined): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;

const iso = (s: string | null | undefined): string | null =>
  typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;

const asEnum = (path: string, value: string | null | undefined, toolName?: string): string => {
  const f = whitelistField(path);
  if (!f || f.kind !== 'enum') return UNRECOGNISED;
  if (value === null || value === undefined) return 'none';
  return enumMembers(f, toolName).includes(value) ? value : UNRECOGNISED;
};

/**
 * A bare version or digest token: `3.1.28`, `ds1-9f2c1a0b4d77`, `dojo-telemetry-1`.
 * No whitespace, no `/`, no quote, no `@`, bounded length — so no path, no
 * sentence and no identifier the user typed can survive it.
 */
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const asToken = (s: string | null | undefined): string =>
  typeof s === 'string' && SAFE_TOKEN.test(s) ? s : UNRECOGNISED;

/**
 * ONE RECORD, KEYED BY THE WHITELIST. Walks the whitelist rows directly under
 * `prefix` and emits only those the caller supplied a value for. Both
 * directions fail closed on purpose: a whitelist row with no value here is
 * OMITTED (a missing field, the designed mistake), and a value here with no
 * whitelist row is NEVER EMITTED — the whitelist decides the key set, so a
 * "helpful" extra value cannot reach the wire without being declared first.
 * Dotted leaves are skipped: a nested section is its own `emit()` call.
 */
function emit(prefix: string, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of TELEMETRY_WHITELIST) {
    if (!f.path.startsWith(`${prefix}.`)) continue;
    const leaf = f.path.slice(prefix.length + 1);
    if (leaf.includes('.')) continue;
    if (!(leaf in values)) continue;
    out[leaf] = values[leaf];
  }
  return out;
}

/**
 * THE ATTACHMENT. Platform facts in, whitelisted telemetry out. `sources.reportId`
 * is deliberately NOT emitted: the id keys the LOCAL bundle (`~/.dojo/reports/<id>/`)
 * and is of no use off the box — `report.signature` is what correlates two
 * reports of the same failure.
 */
export function buildTelemetry(sources: TelemetrySources): TelemetryAttachment {
  const s = sources;
  return {
    report: emit('report', {
      schema: asToken(TELEMETRY_SCHEMA_VERSION),
      created_at: iso(s.createdAt),
      signature: asToken(s.signature),
      lane: asEnum('report.lane', s.lane),
    }),
    platform: emit('platform', {
      version: asToken(s.platformVersion),
      os: asEnum('platform.os', s.osPlatform),
      node_major: nonNeg(s.nodeMajor),
    }),
    window: emit('window', {
      minutes: nonNeg(s.windowMinutes),
      turns: nonNeg(s.windowTurns),
      truncated: Boolean(s.windowTruncated),
    }),
    turns: s.turns.map((t, i) => emit('turn', {
      ordinal: nonNeg(i),
      kind: asEnum('turn.kind', t.kind),
      subject_kind: asEnum('turn.subject_kind', t.subjectKind),
      lane: asEnum('turn.lane', t.lane),
      exit_reason: asEnum('turn.exit_reason', t.exitReason),
      answered: Boolean(t.answered),
      effectful_calls: nonNeg(t.effectfulCalls),
      duration_ms: nonNeg(t.durationMs),
    })),
    calls: s.calls.map((c, i) => emit('call', {
      ordinal: nonNeg(i),
      provider_kind: asEnum('call.provider_kind', c.providerKind),
      model_ordinal: nonNeg(c.modelOrdinal),
      request_type: asEnum('call.request_type', c.requestType),
      input_tokens: nonNeg(c.inputTokens),
      output_tokens: nonNeg(c.outputTokens),
      cache_read_tokens: nonNeg(c.cacheReadTokens),
      cache_creation_tokens: nonNeg(c.cacheCreationTokens),
      latency_ms: nonNeg(c.latencyMs),
      input_tokens_estimated: Boolean(c.inputTokensEstimated),
    })),
    tools: s.toolCalls.map((t, i) => ({
      ...emit('tool', {
        ordinal: nonNeg(i),
        name: asEnum('tool.name', t.name),
        action_type: asEnum('tool.action_type', t.actionType),
        result: asEnum('tool.result', t.result),
        args_total_bytes: nonNeg(t.argsTotalBytes),
        failure_hit_count: nonNeg(t.failureHitCount),
      }),
      // The argument SHAPE, never an argument value. The key is checked against
      // THIS tool's own `input_schema.properties`, so a key the tool never declared
      // — the shape an injected or malformed call takes — comes out as the sentinel.
      arg_shape: t.argShape.map((a) => emit('tool.arg_shape', {
        key: asEnum('tool.arg_shape.key', a.key, t.name),
        type: asEnum('tool.arg_shape.type', a.type),
        bytes: nonNeg(a.bytes),
      })),
    })),
    work: s.work.map((w, i) => emit('work', {
      ordinal: nonNeg(i),
      kind: asEnum('work.kind', w.kind),
      state: asEnum('work.state', w.state),
      age_minutes: nonNeg(w.ageMinutes),
    })),
    settings: emit('settings', {
      provider_kind: asEnum('settings.provider_kind', s.settings.providerKind),
      behaves_like: asEnum('settings.behaves_like', s.settings.behavesLike),
      first_chunk_timeout_ms: nonNeg(s.settings.firstChunkTimeoutMs),
      stream_idle_timeout_ms: nonNeg(s.settings.streamIdleTimeoutMs),
      max_unattended_minutes: nonNeg(s.settings.maxUnattendedMinutes),
      prefill_tokens_per_sec: nonNeg(s.settings.prefillTokensPerSec),
      tools_granted_count: nonNeg(s.settings.toolsGrantedCount),
      context_receipt_mode: asEnum('settings.context_receipt_mode', s.settings.contextReceiptMode),
    }),
  };
}
