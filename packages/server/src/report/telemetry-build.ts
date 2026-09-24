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
//  2. ITS OWN IMPORT SURFACE REACHES NOTHING — and that is the exact claim, not
//     "it can reach nothing" (I4). It imports two modules, the whitelist and the
//     coercion layer, and the conformance test reads the import list of BOTH
//     statically and refuses `node:fs`, `/db/`, `/agent/`, `better-sqlite3` and
//     friends. What it does NOT claim: the whitelist imports the tool registry
//     (clause (4) requires a LIVE registry, so that reach is forced) and the
//     registry's own imports pull in the engine. Nothing there is ever CALLED
//     from here. A further clause pins the whitelist's imports to exactly those
//     two platform modules, so the transitive surface is measured, not asserted.
//
//  3. IT BUILDS BY ITERATING THE WHITELIST, never by iterating its input — that
//     is what `emit()` is for. A field deleted from the whitelist disappears from
//     the attachment; a value computed here that the whitelist does not declare
//     is silently NOT emitted. Construction, never redaction: the failure mode is
//     a missing field. NOTHING may be spread in around that gate.
//
//  4. EVERY VALUE GOES THROUGH A COERCER, and every coercer takes a FIELD PATH or
//     a number — `telemetry-coerce.ts` owns that boundary and argues it in full.
//     An off-domain enum or a mis-shaped version/digest becomes `UNRECOGNISED`; a
//     null source becomes `ABSENT`; a bad number or timestamp becomes `null`.
// ════════════════════════════════════════════════════════════════════════════

import { TELEMETRY_SCHEMA_VERSION } from './telemetry-whitelist.js';
import { nonNeg, iso, asEnum, asShape, emit } from './telemetry-coerce.js';

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
  // The report row's own `created_at`, as the DATABASE wrote it: `datetime('now')`, i.e. UTC
  // in the zoneless `YYYY-MM-DD HH:MM:SS` shape. Said plainly because this comment used to
  // read "ISO" and no production caller ever passed one — `iso()` owns the conversion, and
  // FR-4 is what it cost to have the comment and the caller disagree.
  readonly createdAt: string;
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
      schema: asShape('report.schema', TELEMETRY_SCHEMA_VERSION),
      created_at: iso(s.createdAt),
      signature: asShape('report.signature', s.signature),
      lane: asEnum('report.lane', s.lane),
    }),
    platform: emit('platform', {
      version: asShape('platform.version', s.platformVersion),
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
    tools: s.toolCalls.map((t, i) => emit('tool', {
      ordinal: nonNeg(i),
      name: asEnum('tool.name', t.name),
      action_type: asEnum('tool.action_type', t.actionType),
      result: asEnum('tool.result', t.result),
      // The argument SHAPE, never an argument value. The key is checked against
      // THIS tool's own `input_schema.properties`, so a key the tool never declared
      // — the shape an injected or malformed call takes — comes out as the sentinel.
      arg_shape: t.argShape.map((a) => emit('tool.arg_shape', {
        key: asEnum('tool.arg_shape.key', a.key, t.name),
        type: asEnum('tool.arg_shape.type', a.type),
        bytes: nonNeg(a.bytes),
      })),
      args_total_bytes: nonNeg(t.argsTotalBytes),
      failure_hit_count: nonNeg(t.failureHitCount),
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
