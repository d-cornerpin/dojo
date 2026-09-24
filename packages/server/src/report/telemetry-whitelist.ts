// ════════════════════════════════════════════════════════════════════════════
// THE TELEMETRY WHITELIST — CONSTRUCTION, NEVER REDACTION (DOJO-REPORT T1)
//
// This is the field list that decides what a problem report is ALLOWED to say
// about a user's box on a public GitHub issue. It is the whole privacy model's
// foundation: the sanitized brief is written by an agent and gated by a human,
// but the telemetry attachment is machine-built, and this file is what it is
// built FROM.
//
// ── WHY A DECLARATION LIST AND NOT A SCRUBBER (owner ruling D1, amended) ──
// The obvious design is to gather a blob of evidence and redact the dangerous
// parts out of it. That design FAILS OPEN: redaction is subtractive, so an
// unrecognised shape — a new field, a new error string, a path the pattern did
// not match — survives the scrub and lands on a public page. Construction is
// additive and FAILS CLOSED: the builder walks THIS list and emits nothing that
// is not on it, so a mistake is a MISSING field, never a leaked one.
//
// ── WHY THE KINDS ARE A CLOSED UNION WITH NO `text` MEMBER ──
// A whitelist of field NAMES would still let a later edit add
// `tool.error_message` and nothing would object — the list would still be "a
// whitelist", and the review that waved it through would still have been
// looking at a list of names. So a field here is a typed DECLARATION, and
// `TelemetryFieldKind` has no member that can carry prose. Free text authored
// by the user or by their content is therefore UNREPRESENTABLE at the type
// level: there is no kind to declare it as. That is the property
// `__tests__/the-telemetry-whitelist-admits-no-free-text.test.ts` holds, and it
// is the reason that test is the enforcement rather than a description.
//
// An `'enum'` field must name its closed domain exactly once: either `members`
// inline, or a `membersFrom` source that is a PLATFORM-DECLARED closed set (the
// live tool registry, or a tool's own `input_schema.properties`). `membersFrom`
// exists so the two sets that the platform already owns cannot drift into a
// frozen copy here — a tool renamed in the registry is renamed in the telemetry
// the same day, and a tool that does not exist is not a member of anything.
//
// ── WHAT IS DELIBERATELY ABSENT FROM V1, SO NOBODY "HELPFULLY" ADDS IT ──
//
//  • NO model id, NO provider id, NO provider NAME. A provider's name is text
//    the USER typed ("Dave's Mac Studio"); it is their content, and their
//    content never qualifies. `call.model_ordinal` carries the correlation a
//    triager actually needs — "these six calls were the same model" — without
//    carrying an identifier at all.
//
//  • NO error-message string of ANY kind. D1's example list says
//    "platform-authored error messages", and D1's MECHANISM ruling — fails
//    closed, a mistake is a missing field — outranks the example where the two
//    pull apart. They pull apart here: a platform-authored message routinely
//    interpolates the user's content. `auditLog(agentId, 'file_read', filePath,
//    'error', 'File not found')` puts the user's file path in the row;
//    `agent/tools/cat/fs.ts:198-268` is fifteen such rows. So this list admits
//    the platform's VERDICTS — `turns.exit_reason`, `audit_log.result`,
//    `audit_log.action_type`, tool names checked against the live registry —
//    and admits no free-form message. The columns that hold the prose are named
//    as forbidden SOURCES in the conformance test, by name, so that a future
//    field cannot quietly cite one.
//
//  • NO `provider_error.class` / `.status` / `.basis`. Not because they would
//    be unsafe — they are closed enums — but because NOTHING PERSISTS THEM at
//    this HEAD. `turn.exit_reason` is the platform's persisted verdict and
//    already carries `provider_error` and `stream_idle` as members.
//
// Adding any of these later is an additive change here plus a clause in the
// conformance test. That is the designed growth path, and it is deliberately a
// path that a reviewer walks down on purpose rather than one an edit slips
// through.
//
// ── WHAT READS THIS ──
// `telemetry-build.ts` — the ONLY producer of an attachment — and the
// conformance test. Nothing else may build telemetry; a second builder would be
// a second whitelist, which is no whitelist.
// ════════════════════════════════════════════════════════════════════════════

import { registryToolDefinitions } from '../agent/tools/registry.js';
import { BEHAVES_LIKE_PROFILES } from '../agent/model-contract.js';

/**
 * EVERY SHAPE A TELEMETRY VALUE MAY TAKE. There is no `'text'` member and there
 * must never be one: this union is the type-level statement that prose cannot
 * be declared, and every other guard in this feature rests on it.
 */
export type TelemetryFieldKind =
  | 'enum' | 'count' | 'millis' | 'bytes' | 'timestamp' | 'ordinal' | 'bool' | 'version' | 'digest';

export interface TelemetryField {
  readonly path: string;
  readonly kind: TelemetryFieldKind;
  /** The platform surface this value is derived from. Prose, for the reader; never emitted. */
  readonly source: string;
  /** REQUIRED for kind 'enum' unless `membersFrom` is set. */
  readonly members?: readonly string[];
  /** REQUIRED for kind 'enum' unless `members` is set. A platform-declared closed set. */
  readonly membersFrom?: 'tool-registry' | 'tool-input-schema';
}

/** Stamped into every attachment so a triager can tell two generations apart. */
export const TELEMETRY_SCHEMA_VERSION = 'dojo-telemetry-1';

/** What an off-domain value becomes. Never the value; never a silent drop. */
export const UNRECOGNISED = '<unrecognised>';

export const TELEMETRY_WHITELIST: readonly TelemetryField[] = [
  // ── the report's own identity ──
  { path: 'report.schema',            kind: 'version',   source: 'TELEMETRY_SCHEMA_VERSION' },
  { path: 'report.created_at',        kind: 'timestamp', source: 'report row created_at' },
  { path: 'report.signature',         kind: 'digest',    source: 'report/signature.ts' },
  { path: 'report.lane',              kind: 'enum',      source: 'agent choice from FAILURE_LANES',
    members: ['tool-error', 'wrong-answer', 'silence', 'permission', 'other'] },
  // ── the box ──
  { path: 'platform.version',         kind: 'version',   source: 'gateway/routes/update.ts getCurrentVersion()' },
  { path: 'platform.os',              kind: 'enum',      source: 'process.platform',
    members: ['darwin', 'linux', 'win32', 'other'] },
  { path: 'platform.node_major',      kind: 'count',     source: 'process.versions.node' },
  // ── the window ──
  { path: 'window.minutes',           kind: 'count',     source: 'report/window.ts' },
  { path: 'window.turns',             kind: 'count',     source: 'report/window.ts' },
  { path: 'window.truncated',         kind: 'bool',      source: 'report/window.ts' },
  // ── turns (table `turns`) ──
  { path: 'turn.ordinal',             kind: 'ordinal',   source: 'position in window' },
  { path: 'turn.kind',                kind: 'enum',      source: 'turns.kind',
    members: ['user', 'a2a', 'engine', 'none'] },
  { path: 'turn.subject_kind',        kind: 'enum',      source: 'turns.subject_kind',
    members: ['conv', 'engine_event', 'a2a_thread', 'continuation', 'none'] },
  { path: 'turn.lane',                kind: 'enum',      source: 'turns.lane',
    members: ['voice', 'phone', 'none'] },
  { path: 'turn.exit_reason',         kind: 'enum',      source: 'turns.exit_reason (TurnExitReason)',
    members: ['answered', 'no_reply_intended', 'park', 'handoff', 'delegation_exit', 'iteration_cap',
      'brake', 'identical_call', 'stop', 'preempt', 'provider_error', 'stream_idle', 'abort',
      'terminated', 'budget', 'compile_pending', 'unknown'] },
  { path: 'turn.answered',            kind: 'bool',      source: 'turns.answered' },
  { path: 'turn.effectful_calls',     kind: 'count',     source: 'turns.effectful_calls' },
  { path: 'turn.duration_ms',         kind: 'millis',    source: 'turns.ended_at - turns.started_at' },
  // ── model calls (table `cost_records`) ──
  { path: 'call.ordinal',             kind: 'ordinal',   source: 'position in window' },
  { path: 'call.provider_kind',       kind: 'enum',      source: 'providers.type',
    members: ['anthropic', 'openai', 'openai-compatible', 'ollama'] },
  { path: 'call.model_ordinal',       kind: 'ordinal',   source: 'per-report ordinal for a distinct model id' },
  { path: 'call.request_type',        kind: 'enum',      source: 'cost_records.request_type',
    members: ['agent_turn', 'summarize', 'embedding', 'router', 'healer', 'other'] },
  { path: 'call.input_tokens',        kind: 'count',     source: 'cost_records.input_tokens' },
  { path: 'call.output_tokens',       kind: 'count',     source: 'cost_records.output_tokens' },
  { path: 'call.cache_read_tokens',   kind: 'count',     source: 'cost_records.cache_read_tokens' },
  { path: 'call.cache_creation_tokens', kind: 'count',   source: 'cost_records.cache_creation_tokens' },
  { path: 'call.latency_ms',          kind: 'millis',    source: 'cost_records.latency_ms' },
  { path: 'call.input_tokens_estimated', kind: 'bool',   source: 'cost_records.estimated_input_tokens IS NOT NULL' },
  // ── tool calls (tables `audit_log`, `agent_tool_failures`; shapes from the assistant tool_use blocks) ──
  { path: 'tool.ordinal',             kind: 'ordinal',   source: 'position in window' },
  { path: 'tool.name',                kind: 'enum',      source: 'registryToolDefinitions()', membersFrom: 'tool-registry' },
  { path: 'tool.action_type',         kind: 'enum',      source: 'audit_log.action_type',
    members: ['tool_call', 'file_read', 'file_write', 'exec', 'model_call', 'error'] },
  { path: 'tool.result',              kind: 'enum',      source: 'audit_log.result',
    members: ['success', 'denied', 'error'] },
  { path: 'tool.arg_shape.key',       kind: 'enum',      source: "the tool's own input_schema.properties",
    membersFrom: 'tool-input-schema' },
  { path: 'tool.arg_shape.type',      kind: 'enum',      source: 'JSON type of the argument VALUE, never the value',
    members: ['string', 'number', 'boolean', 'array', 'object', 'null'] },
  { path: 'tool.arg_shape.bytes',     kind: 'bytes',     source: 'JSON.stringify(value).length' },
  { path: 'tool.args_total_bytes',    kind: 'bytes',     source: 'JSON.stringify(args).length' },
  { path: 'tool.failure_hit_count',   kind: 'count',     source: 'agent_tool_failures.hit_count' },
  // ── work rows (table `work`) ──
  { path: 'work.ordinal',             kind: 'ordinal',   source: 'position in window' },
  { path: 'work.kind',                kind: 'enum',      source: 'work.kind',
    members: ['ask', 'task', 'project', 'occurrence', 'commitment'] },
  { path: 'work.state',               kind: 'enum',      source: 'work.state',
    members: ['open', 'claimed', 'done', 'failed', 'abandoned', 'paused', 'blocked', 'on_deck'] },
  { path: 'work.age_minutes',         kind: 'count',     source: 'now - work.created_at' },
  // ── the settings that shape a turn ──
  { path: 'settings.provider_kind',   kind: 'enum',      source: 'providers.type',
    members: ['anthropic', 'openai', 'openai-compatible', 'ollama'] },
  { path: 'settings.behaves_like',    kind: 'enum',      source: 'providers.behaves_like',
    members: [...BEHAVES_LIKE_PROFILES, 'none'] },
  { path: 'settings.first_chunk_timeout_ms',  kind: 'millis', source: 'providers.first_chunk_timeout_ms' },
  { path: 'settings.stream_idle_timeout_ms',  kind: 'millis', source: 'providers.stream_idle_timeout_ms' },
  { path: 'settings.max_unattended_minutes',  kind: 'count',  source: 'providers.max_unattended_minutes' },
  { path: 'settings.prefill_tokens_per_sec',  kind: 'count',  source: 'providers.prefill_tokens_per_sec' },
  { path: 'settings.tools_granted_count',     kind: 'count',  source: 'getFilteredTools(agentId).length' },
  { path: 'settings.context_receipt_mode',    kind: 'enum',   source: 'config.context_receipt_mode',
    members: ['off', 'meta', 'full'] },
];

const BY_PATH = new Map(TELEMETRY_WHITELIST.map(f => [f.path, f]));

/** The declaration for a path, or `undefined` — which the builder treats as "emit nothing". */
export function whitelistField(path: string): TelemetryField | undefined { return BY_PATH.get(path); }

/**
 * THE CLOSED DOMAIN OF AN ENUM FIELD, resolved against the LIVE platform.
 *
 * An unresolvable domain returns `[]` rather than throwing, and an empty domain
 * matches nothing — so the failure mode of every branch here is `UNRECOGNISED`,
 * which is the direction this whole file is built to fail in.
 */
export function enumMembers(f: TelemetryField, toolName?: string): readonly string[] {
  if (f.members) return f.members;
  if (f.membersFrom === 'tool-registry') return registryToolDefinitions().map(d => d.name);
  if (f.membersFrom === 'tool-input-schema') {
    if (toolName === undefined) return [];
    const def = registryToolDefinitions().find(d => d.name === toolName);
    return def ? Object.keys(def.input_schema.properties) : [];
  }
  return [];
}
