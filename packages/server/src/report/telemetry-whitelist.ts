// The telemetry whitelist: construction, never redaction. Redaction fails open (an unrecognised
// shape survives the scrub); the builder emits nothing that is not on this list, so a mistake is
// a missing field. `TelemetryFieldKind` has no member that can carry prose, and every field declares
// its own domain (closed `members`, a platform-declared `membersFrom`, or a bounded `pattern`).
// Deliberately absent: model, provider and provider-name strings (user-typed text; see
// `call.model_ordinal`), and any error-message string (platform messages interpolate user paths and
// exec targets), so only verdicts are admitted. Adding one later needs a conformance clause too.

import { registryToolDefinitions } from '../agent/tools/registry.js';
import { BEHAVES_LIKE_PROFILES } from '../agent/model-contract.js';

/** Every shape a value may take. There is no 'text' member and there must never be one. */
export type TelemetryFieldKind =
  | 'enum' | 'count' | 'millis' | 'bytes' | 'timestamp' | 'ordinal' | 'bool' | 'version' | 'digest';

export interface TelemetryField {
  readonly path: string;
  readonly kind: TelemetryFieldKind;
  readonly source: string;
  readonly members?: readonly string[];
  readonly membersFrom?: 'tool-registry' | 'tool-input-schema';
  /** REQUIRED for 'version' and 'digest', forbidden otherwise: an anchored, flagless, bounded shape.
   *  Flags are refused by test because `/m` turns ^ and $ into line anchors. */
  readonly pattern?: RegExp;
}

export const TELEMETRY_SCHEMA_VERSION = 'dojo-telemetry-1';

export const UNRECOGNISED = '<unrecognised>';

/** What a null source becomes: distinct from `UNRECOGNISED`, and never a member of any domain. */
export const ABSENT = '<absent>';

export const TELEMETRY_WHITELIST: readonly TelemetryField[] = [
  { path: 'report.schema',            kind: 'version',   source: 'TELEMETRY_SCHEMA_VERSION',
    pattern: /^dojo-telemetry-1$/ },                 // equality with the constant, anchored
  { path: 'report.created_at',        kind: 'timestamp', source: 'report row created_at' },
  { path: 'report.signature',         kind: 'digest',    source: 'report/signature.ts',
    pattern: /^ds[12]-[0-9a-f]{12}$/ },               // ds2 is what signature.ts mints; ds1 is an earlier scheme
  { path: 'report.lane',              kind: 'enum',      source: 'agent choice from FAILURE_LANES',
    members: ['tool-error', 'wrong-answer', 'silence', 'permission', 'other'] },
  { path: 'platform.version',         kind: 'version',   source: 'gateway/routes/update.ts getCurrentVersion()',
    pattern: /^\d+\.\d+\.\d+(-[a-z0-9]{1,8}(\.[a-z0-9]{1,8}){0,2})?$/ },  // bounded semver
  { path: 'platform.os',              kind: 'enum',      source: 'process.platform',
    members: ['darwin', 'linux', 'win32', 'other'] },
  { path: 'platform.node_major',      kind: 'count',     source: 'process.versions.node' },
  { path: 'window.minutes',           kind: 'count',     source: 'report/window.ts' },
  { path: 'window.turns',             kind: 'count',     source: 'report/window.ts' },
  { path: 'window.truncated',         kind: 'bool',      source: 'report/window.ts' },
  { path: 'turn.ordinal',             kind: 'ordinal',   source: 'position in window' },
  { path: 'turn.kind',                kind: 'enum',      source: 'turns.kind',
    members: ['user', 'a2a', 'engine', 'none'] },
  { path: 'turn.subject_kind',        kind: 'enum',      source: 'turns.subject_kind',
    members: ['conv', 'engine_event', 'a2a_thread', 'continuation', 'none'] },
  { path: 'turn.lane',                kind: 'enum',      source: 'turns.lane',
    members: ['voice', 'phone', 'none'] },
  // Every member is one `TurnExitReason` can emit; a member nothing writes claims a false possibility.
  { path: 'turn.exit_reason',         kind: 'enum',      source: 'turns.exit_reason (TurnExitReason)',
    members: ['answered', 'no_reply_intended', 'park', 'handoff', 'iteration_cap',
      'brake', 'identical_call', 'stop', 'preempt', 'provider_error', 'stream_idle', 'abort',
      'terminated', 'budget', 'unknown'] },
  { path: 'turn.answered',            kind: 'bool',      source: 'turns.answered' },
  { path: 'turn.effectful_calls',     kind: 'count',     source: 'turns.effectful_calls' },
  { path: 'turn.duration_ms',         kind: 'millis',    source: 'turns.ended_at - turns.started_at' },
  { path: 'call.ordinal',             kind: 'ordinal',   source: 'position in window' },
  { path: 'call.provider_kind',       kind: 'enum',      source: 'providers.type',
    members: ['anthropic', 'openai', 'openai-compatible', 'ollama'] },
  { path: 'call.model_ordinal',       kind: 'ordinal',   source: 'per-report ordinal for a distinct model id' },
  // The measured set of `cost_records.request_type` (open string, no CHECK). `completion` must stay:
  // `agent/model.ts` records it for a call that declares no purpose.
  { path: 'call.request_type',        kind: 'enum',      source: 'cost_records.request_type (no CHECK; this list is its only domain)',
    members: ['light', 'standard', 'heavy', 'budget_fallback', 'ollama', 'agent_turn',
      'agent-sdk', 'completion', 'image_generation', 'transcription', 'music_generation',
      'audio_generation', 'video_generation',
      'ask_title', 'multistep_classify', 'memory_summarize', 'continuity_brief',
      'vision_caption', 'page_summary', 'speech'] },
  { path: 'call.input_tokens',        kind: 'count',     source: 'cost_records.input_tokens' },
  { path: 'call.output_tokens',       kind: 'count',     source: 'cost_records.output_tokens' },
  { path: 'call.cache_read_tokens',   kind: 'count',     source: 'cost_records.cache_read_tokens' },
  { path: 'call.cache_creation_tokens', kind: 'count',   source: 'cost_records.cache_creation_tokens' },
  { path: 'call.latency_ms',          kind: 'millis',    source: 'cost_records.latency_ms' },
  { path: 'call.input_tokens_estimated', kind: 'bool',   source: 'cost_records.estimated_input_tokens IS NOT NULL' },
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
  { path: 'work.ordinal',             kind: 'ordinal',   source: 'position in window' },
  { path: 'work.kind',                kind: 'enum',      source: 'work.kind',
    members: ['ask', 'task', 'project', 'occurrence', 'commitment'] },
  { path: 'work.state',               kind: 'enum',      source: 'work.state',
    members: ['open', 'claimed', 'handed_in', 'sent_back', 'done', 'failed', 'abandoned', 'blocked'] },
  { path: 'work.age_minutes',         kind: 'count',     source: 'now - work.created_at' },
  { path: 'settings.provider_kind',   kind: 'enum',      source: 'providers.type',
    members: ['anthropic', 'openai', 'openai-compatible', 'ollama'] },
  { path: 'settings.behaves_like',    kind: 'enum',      source: 'providers.behaves_like',
    members: [...BEHAVES_LIKE_PROFILES, 'none'] },
  { path: 'settings.first_chunk_timeout_ms',  kind: 'millis', source: 'providers.first_chunk_timeout_ms' },
  { path: 'settings.stream_idle_timeout_ms',  kind: 'millis', source: 'providers.stream_idle_timeout_ms' },
  { path: 'settings.prefill_tokens_per_sec',  kind: 'count',  source: 'providers.prefill_tokens_per_sec' },
  { path: 'settings.tools_granted_count',     kind: 'count',  source: 'getFilteredTools(agentId).length' },
  { path: 'settings.context_receipt_mode',    kind: 'enum',   source: 'config.context_receipt_mode',
    members: ['off', 'meta', 'full'] },
];

// `readonly` is compile-time only: freezing stops mutation, and the conformance test admits only short
// machine-token members, so keep every member list a literal, never computed from user data.
for (const f of TELEMETRY_WHITELIST) {
  if (f.members) Object.freeze(f.members);
  Object.freeze(f);
}
Object.freeze(TELEMETRY_WHITELIST);

const BY_PATH = new Map(TELEMETRY_WHITELIST.map(f => [f.path, f]));

export function whitelistField(path: string): TelemetryField | undefined { return BY_PATH.get(path); }

/** The closed domain of an enum field, resolved against the live platform. An unresolvable domain
 *  is `[]`, which matches nothing, so every branch fails toward `UNRECOGNISED`. */
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
