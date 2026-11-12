// The seventh collector, with no table: `readLogEntries` has no agent filter or window, so it narrows here.
// A report must not re-swallow the last one: rows naming this tool in `meta.tool` lose `args`, `rawSnippet`
// (agent and user text); the rest of `meta`, including the platform's own `error`, is kept.

import { readLogEntries } from '../logger.js';

export const SELF_TOOL = 'dojo_report';

export const SELF_PAYLOAD_FIELDS = ['args', 'rawSnippet'] as const;

export type LogRow = ReturnType<typeof readLogEntries>[number];

export function withoutOwnPayload(e: LogRow): LogRow {
  if (e.meta?.tool !== SELF_TOOL) return e;
  const dropped = SELF_PAYLOAD_FIELDS.filter(f => e.meta !== undefined && f in e.meta);
  if (dropped.length === 0) return e;
  const meta: Record<string, unknown> = { ...e.meta };
  for (const f of dropped) delete meta[f];
  meta.omitted = `${dropped.join(', ')} — this tool's own payload. A report refers to an earlier `
    + 'report by its id and never re-swallows its text.';
  return { ...e, meta };
}

export interface LogSlice {
  rows: LogRow[];
  globalReadSaturated: boolean;
}

/** Newest first. `globalReadSaturated`: the global read came back full, so older lines may be unseen. */
export function agentLogSlice(agentId: string, sinceIso: string, limit: number): LogSlice {
  const read = readLogEntries({ limit });
  return {
    globalReadSaturated: read.length >= limit,
    rows: read
      .filter(e => e.agentId === agentId && e.timestamp >= sinceIso)
      .map(withoutOwnPayload),
  };
}
