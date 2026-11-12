// Shapes what `collect.ts` returned into two outputs, and the split is the privacy model: `sources` is a
// subset of `TelemetrySources` by type (closed-domain facts); `bundle` is raw and never leaves the box;
// `audit_log.target` and `.detail` appear in exactly one of them. Calls pair by `call_id`,
// never by position. Every string the agent reads is scrubbed as `writeBundle` does. Nothing here posts.

import { redactHandedCredentials } from '../credentials/secret-values.js';
import { recentTail } from '../memory/message-store.js';
import { getCurrentVersion } from '../gateway/routes/update.js';
import { shapeOfArgs, toolCallsFromTail } from './arg-shape.js';
import {
  readAudit, readCalls, readFailures, readSettings, readTurns, readWork,
  num, numOrNull, sqlStamp, str, type Row,
} from './collect.js';
import { boundBundleSections } from './bounds.js';
import { agentLogSlice } from './log-slice.js';
import { COLLECTOR_CAPS, resolveWindow, type GatherWindow, type WindowRequest } from './window.js';
import type { DominantFailure } from './signature.js';
import type { CallFacts, TelemetrySources, ToolCallFacts, TurnFacts, WorkFacts } from './telemetry-build.js';

/** What `gatherEvidence` answers. `sources` is telemetry-bound; `bundle` never leaves. */
export interface Evidence {
  window: GatherWindow;
  sources: Omit<TelemetrySources, 'reportId' | 'createdAt' | 'signature' | 'lane'>;
  dominant: DominantFailure;
  bundle: Record<string, unknown>;
}

function osOf(p: string): string {
  return p === 'darwin' || p === 'linux' || p === 'win32' ? p : 'other';
}

/** Tool name to its in-window non-success tally: total count and dominant verdict (ties break by name). */
function failuresByTool(calls: readonly ToolCallFacts[]): { tool: string; result: string; count: number }[] {
  const tally = new Map<string, Map<string, number>>();
  for (const c of calls) {
    if (c.result === null || c.result === 'success') continue;
    const byResult = tally.get(c.name) ?? new Map<string, number>();
    byResult.set(c.result, (byResult.get(c.result) ?? 0) + 1);
    tally.set(c.name, byResult);
  }
  return [...tally].map(([tool, byResult]) => ({
    tool,
    result: [...byResult].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
    count: [...byResult.values()].reduce((n, v) => n + v, 0),
  }));
}

/** The failure shape the signature hashes, from in-window evidence only: the cumulative per-agent streak
 *  counter reads failures from outside the window, so it is not used. Tool failures outrank turn exits. */
function dominantOf(calls: readonly ToolCallFacts[], turns: readonly TurnFacts[]): DominantFailure {
  const toolFailures = failuresByTool(calls)
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
  const exits = new Map<string, number>();
  for (const t of turns) {
    if (t.answered || t.exitReason === null || t.exitReason === 'answered') continue;
    exits.set(t.exitReason, (exits.get(t.exitReason) ?? 0) + 1);
  }
  const turnExits = [...exits]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([exitReason, count]) => ({ exitReason, count }));
  return { toolFailures, turnExits };
}

/** One pass over the whole serialized document, as `writeBundle` does. */
function scrub(agentId: string, bundle: Record<string, unknown>): Record<string, unknown> {
  try {
    const text = redactHandedCredentials(agentId, JSON.stringify(bundle) ?? '{}');
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A bundle that will not serialize fails to nothing, never to the unscrubbed object.
    return { unavailable: true, reason: 'evidence could not be serialized for scrubbing' };
  }
}

export function gatherEvidence(agentId: string, req: WindowRequest, now: Date = new Date()): Evidence {
  const window = resolveWindow(req, now);
  const since = sqlStamp(window.sinceIso);
  const sinceMs = now.getTime() - window.minutes * 60_000;

  // The resolved window, not the standing cap: it is what the attachment publishes and the agent is told.
  const turnRows = readTurns(agentId, since, window.turns);
  const callRows = readCalls(agentId, since);
  const auditRows = readAudit(agentId, since);
  const failureRows = readFailures(agentId, since);
  const workRows = readWork(agentId, sinceMs);

  const turns: TurnFacts[] = turnRows.map(r => ({
    kind: str(r.kind), subjectKind: str(r.subject_kind), lane: str(r.lane),
    exitReason: str(r.exit_reason), answered: r.answered === 1,
    effectfulCalls: num(r.effectful_calls), durationMs: numOrNull(r.duration_ms),
  }));

  // `modelOrdinal` correlates calls by model without carrying the id, which dies with this Map.
  const ordinals = new Map<string, number>();
  const calls: CallFacts[] = callRows.map((r) => {
    const model = str(r.model_id) ?? '';
    if (!ordinals.has(model)) ordinals.set(model, ordinals.size);
    return {
      providerKind: str(r.provider_kind), modelOrdinal: ordinals.get(model) ?? 0,
      requestType: str(r.request_type), inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens), cacheReadTokens: num(r.cache_read_tokens),
      cacheCreationTokens: num(r.cache_creation_tokens), latencyMs: numOrNull(r.latency_ms),
      inputTokensEstimated: r.estimated_input_tokens !== null && r.estimated_input_tokens !== undefined,
    };
  });

  // Audit rows are newest-first, so the first sighting of a call id is the outcome that stands.
  const outcomes = new Map<string, Row>();
  for (const r of auditRows) { const id = str(r.call_id); if (id && !outcomes.has(id)) outcomes.set(id, r); }
  const hits = new Map<string, number>();
  for (const f of failureRows) hits.set(str(f.tool_name) ?? '', num(f.hit_count));

  // `recentTail` takes no time argument, so filter here: an out-of-window call would render like an
  // in-window call whose audit row is missing (`result: null`).
  const tail = toolCallsFromTail(
    recentTail(agentId, { limit: COLLECTOR_CAPS.toolCalls }).filter(m => m.createdAt >= since),
  );
  const toolCalls: ToolCallFacts[] = tail.slice(-COLLECTOR_CAPS.toolCalls).map((c) => {
    const outcome = c.id ? outcomes.get(c.id) : undefined;
    const { argShape, argsTotalBytes } = shapeOfArgs(c.name, c.args);
    return {
      name: c.name, actionType: str(outcome?.action_type ?? null), result: str(outcome?.result ?? null),
      argShape, argsTotalBytes, failureHitCount: hits.get(c.name) ?? 0,
    };
  });

  const work: WorkFacts[] = workRows.map(r => ({
    kind: str(r.kind), state: str(r.state),
    ageMinutes: Math.max(0, Math.round((now.getTime() - num(r.opened_at)) / 60_000)),
  }));

  // The seventh collector: this agent's log lines in the window, newest first (`log-slice.ts`).
  const logSlice = agentLogSlice(agentId, window.sinceIso, COLLECTOR_CAPS.toolCalls);
  const logs = logSlice.rows;

  // `bounds` goes FIRST in the document so the agent reads what is missing before what is there.
  // `writeBundle` writes this same bounded object; `sources` stays unbounded.
  const bounded = boundBundleSections({
    turns: turnRows, calls: callRows, auditLog: auditRows,
    toolFailures: failureRows, work: workRows, logs,
    // Arrives oldest-first (`toolCallsFromTail`); reversed so every section is newest-first.
    toolCalls: [...toolCalls].reverse()
      .map(t => ({ name: t.name, result: t.result, argShape: t.argShape })),
  });

  // The log read is global and narrowed afterwards, so a full read can hide in-window lines while kept and
  // collected counts agree; the note is added here because `bounds.ts` reads nothing.
  if (logSlice.globalReadSaturated) {
    bounded.notes.push(
      `logs: the engine log was read to its ${COLLECTOR_CAPS.toolCalls}-line global limit before `
      + 'this agent\'s lines were selected from it, so older entries inside this window may exist '
      + 'that this bundle never saw. A short or empty `logs` section here is not evidence that the '
      + 'agent was quiet.',
    );
  }

  return {
    window,
    sources: {
      platformVersion: getCurrentVersion(), osPlatform: osOf(process.platform),
      nodeMajor: Number.parseInt(process.versions.node.split('.')[0], 10),
      windowMinutes: window.minutes, windowTurns: window.turns, windowTruncated: window.truncated,
      turns, calls, toolCalls, work, settings: readSettings(agentId),
    },
    dominant: dominantOf(toolCalls, turns),
    bundle: scrub(agentId, { bounds: bounded.notes, window, ...bounded.sections }),
  };
}
