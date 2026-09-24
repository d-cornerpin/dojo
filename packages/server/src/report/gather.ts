// ════════════════════════════════════════════════════════════════════════════
// THE GATHER — TWO OUTPUTS, AND THE SPLIT IS THE PRIVACY MODEL (DOJO-REPORT T3)
//
// `collect.ts` next door runs the six queries. This file shapes what they
// returned, and the shaping is where owner ruling D1 is actually enforced:
//
//  1. `sources` IS WHAT T1'S BUILDER MAY SEE — closed-domain platform facts, and
//     it is a SUBSET OF `TelemetrySources` BY TYPE, so a column with nowhere to
//     go cannot be smuggled in. `bundle` is the raw material, including the
//     columns that carry user content, and it is written under `~/.dojo` and
//     never leaves the box. `audit_log.target` and `.detail` appear in exactly
//     one of the two, and the test asserts which.
//
//  2. A CALL IS PAIRED WITH ITS OUTCOME BY `call_id`, NEVER BY POSITION. The
//     tool NAME and argument SHAPE live in the assistant message's `tool_use`
//     blocks (`audit_log` stores neither — it normalises `action_type` to a
//     six-value CHECK set); the VERDICT lives in `audit_log`. Both carry the
//     provider's call id, so the join is exact. Zipping the two lists by index
//     would attribute one tool's refusal to a different tool the first time the
//     two counts differ, which is the first time anything interesting happened.
//
//  3. EVERY STRING THE AGENT READS IS SCRUBBED, by the SAME mechanism
//     `writeBundle` applies on the way to disk — deliberately the same one and
//     not a second one, so there is a single scrub to reason about and it was
//     already mutation-proven in T2.
//
//  4. NOTHING HERE CAN POST, AND NOTHING HERE KNOWS A REPORT ID. `gatherEvidence`
//     is a pure read plus a scrub; the report row, the bundle file and the
//     telemetry are all the handler's doing, one layer up.
// ════════════════════════════════════════════════════════════════════════════

import { redactHandedCredentials } from '../credentials/secret-values.js';
import { readLogEntries } from '../logger.js';
import { recentTail } from '../memory/message-store.js';
import { getCurrentVersion } from '../gateway/routes/update.js';
import { shapeOfArgs, toolCallsFromTail } from './arg-shape.js';
import {
  readAudit, readCalls, readFailures, readSettings, readTurns, readWork,
  num, numOrNull, sqlStamp, str, type Row,
} from './collect.js';
import { COLLECTOR_CAPS, resolveWindow, type GatherWindow, type WindowRequest } from './window.js';
import type { DominantFailure } from './signature.js';
import type { CallFacts, TelemetrySources, ToolCallFacts, TurnFacts, WorkFacts } from './telemetry-build.js';

/** What `gatherEvidence` answers. `sources` is telemetry-bound; `bundle` never leaves. */
export interface Evidence {
  window: GatherWindow;
  sources: Omit<TelemetrySources, 'reportId' | 'createdAt' | 'signature' | 'lane'>;
  dominant: DominantFailure;
  /** The raw, credential-scrubbed material the agent reads. Never leaves the box. */
  bundle: Record<string, unknown>;
}

/** `process.platform` narrowed to the four members `platform.os` declares. */
function osOf(p: string): string {
  return p === 'darwin' || p === 'linux' || p === 'win32' ? p : 'other';
}

/** Tool name → its dominant NON-SUCCESS verdict in this window. Ties break lexicographically. */
function verdictByTool(calls: readonly ToolCallFacts[]): Map<string, string> {
  const tally = new Map<string, Map<string, number>>();
  for (const c of calls) {
    if (c.result === null || c.result === 'success') continue;
    const byResult = tally.get(c.name) ?? new Map<string, number>();
    byResult.set(c.result, (byResult.get(c.result) ?? 0) + 1);
    tally.set(c.name, byResult);
  }
  const out = new Map<string, string>();
  for (const [tool, byResult] of tally) {
    out.set(tool, [...byResult].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]);
  }
  return out;
}

/**
 * THE FAILURE SHAPE THE SIGNATURE HASHES. Tool failures outrank turn exits
 * (`signature.ts` argues why: an exit reason is downstream of whatever went wrong).
 * `'unrecorded'` is what a failure streak whose audit rows fell outside the window
 * becomes — an honest literal, never a verdict borrowed from some other tool.
 */
function dominantOf(
  failures: readonly Row[], calls: readonly ToolCallFacts[], turns: readonly TurnFacts[],
): DominantFailure {
  const verdicts = verdictByTool(calls);
  const toolFailures = failures.map(f => ({
    tool: str(f.tool_name) ?? 'unknown',
    result: verdicts.get(str(f.tool_name) ?? '') ?? 'unrecorded',
    count: num(f.hit_count),
  }));
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

/** THE SCRUB. One pass over the whole serialized document, exactly as `writeBundle` does. */
function scrub(agentId: string, bundle: Record<string, unknown>): Record<string, unknown> {
  try {
    const text = redactHandedCredentials(agentId, JSON.stringify(bundle) ?? '{}');
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A bundle that will not serialize is a bundle nobody may read: fail to NOTHING
    // rather than to the unscrubbed object. A missing bundle is the designed mistake.
    return { unavailable: true, reason: 'evidence could not be serialized for scrubbing' };
  }
}

export function gatherEvidence(agentId: string, req: WindowRequest, now: Date = new Date()): Evidence {
  const window = resolveWindow(req, now);
  const since = sqlStamp(window.sinceIso);
  const sinceMs = now.getTime() - window.minutes * 60_000;

  const turnRows = readTurns(agentId, since);
  const callRows = readCalls(agentId, since);
  const auditRows = readAudit(agentId, since);
  const failureRows = readFailures(agentId, since);
  const workRows = readWork(agentId, sinceMs);

  const turns: TurnFacts[] = turnRows.map(r => ({
    kind: str(r.kind), subjectKind: str(r.subject_kind), lane: str(r.lane),
    exitReason: str(r.exit_reason), answered: r.answered === 1,
    effectfulCalls: num(r.effectful_calls), durationMs: numOrNull(r.duration_ms),
  }));

  // `modelOrdinal` correlates ("these six calls were the same model") without
  // carrying an identifier. The id itself dies with this Map.
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

  // Newest row wins per call id: the audit query is newest-first, so the first
  // sighting is the outcome that stands if a call id were ever written twice.
  const outcomes = new Map<string, Row>();
  for (const r of auditRows) { const id = str(r.call_id); if (id && !outcomes.has(id)) outcomes.set(id, r); }
  const hits = new Map<string, number>();
  for (const f of failureRows) hits.set(str(f.tool_name) ?? '', num(f.hit_count));

  // WINDOW-BOUNDED, and the filter is here because `recentTail` has no time argument to
  // pass one to. Without it a tool call from last Tuesday rode into the attachment with
  // `result: null`, wearing the same shape as an in-window call whose audit row was
  // missing — two different facts rendering identically, on a public page. `createdAt` is
  // the row's own stamp in the same text shape `sqlStamp` produces, so one comparison form
  // governs every collector.
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

  // `readLogEntries` has neither an agent filter nor a window (measured); filtering
  // its OUTPUT is not a new collector, which is why this is a `.filter` and not SQL.
  const logs = readLogEntries({ limit: COLLECTOR_CAPS.toolCalls })
    .filter(e => e.agentId === agentId && e.timestamp >= window.sinceIso);

  return {
    window,
    sources: {
      platformVersion: getCurrentVersion(), osPlatform: osOf(process.platform),
      nodeMajor: Number.parseInt(process.versions.node.split('.')[0], 10),
      windowMinutes: window.minutes, windowTurns: window.turns, windowTruncated: window.truncated,
      turns, calls, toolCalls, work, settings: readSettings(agentId),
    },
    dominant: dominantOf(failureRows, toolCalls, turns),
    bundle: scrub(agentId, {
      window, turns: turnRows, calls: callRows, auditLog: auditRows,
      toolFailures: failureRows, work: workRows, logs,
      toolCalls: toolCalls.map(t => ({ name: t.name, result: t.result, argShape: t.argShape })),
    }),
  };
}
