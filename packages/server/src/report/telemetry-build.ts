// The only producer of an attachment, built from platform facts (`TelemetrySources`, gathered by
// `report/gather.ts`) with no parameter for agent text. It builds by iterating the whitelist through
// `emit()`, never its input, so nothing may be spread in around that gate; every value goes through
// a coercer. It imports only the whitelist and the coercion layer, and must stay that way.

import { TELEMETRY_SCHEMA_VERSION } from './telemetry-whitelist.js';
import { nonNeg, iso, asEnum, asShape, emit } from './telemetry-coerce.js';

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
  prefillTokensPerSec: number | null;
  toolsGrantedCount: number; contextReceiptMode: string | null;
}

export interface TelemetrySources {
  readonly reportId: string;
  // The report row's `created_at` as the database wrote it (UTC, zoneless); `iso()` converts it.
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

/** Platform facts in, whitelisted telemetry out. `reportId` is not emitted: it keys the local bundle
 *  and is no use off the box (`report.signature` correlates reports of one failure). */
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
      // The argument SHAPE, never a value. The key is checked against THIS tool's own
      // `input_schema.properties`, so a key the tool never declared comes out as the sentinel.
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
      prefill_tokens_per_sec: nonNeg(s.settings.prefillTokensPerSec),
      tools_granted_count: nonNeg(s.settings.toolsGrantedCount),
      context_receipt_mode: asEnum('settings.context_receipt_mode', s.settings.contextReceiptMode),
    }),
  };
}
