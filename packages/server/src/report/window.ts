// The agent names the window and the tool bounds it. The cap is never a silent trim: `truncated` reaches
// the attachment and the tool result the agent reads; `askedFor` is agent prose, never in the attachment.
// A non-positive or non-finite ask falls back to the standing window and is NOT `truncated`. These are row
// caps; the character budgets are in `bounds.ts` and the byte cap on the bundle in `bundle.ts`.

export const REPORT_WINDOW_MAX_TURNS = 20;
export const REPORT_WINDOW_MAX_MINUTES = 120;

// Each cap is the LIMIT of one prepared statement in `gather.ts`.
export const COLLECTOR_CAPS = {
  turns: 20, calls: 60, toolCalls: 200, work: 25, toolFailures: 25,
} as const;

export interface WindowRequest { turns?: number | null; minutes?: number | null }

export interface GatherWindow {
  turns: number;
  minutes: number;
  sinceIso: string;
  truncated: boolean;
  askedFor: string;
}

export function resolveWindow(req: WindowRequest, now: Date = new Date()): GatherWindow {
  const askedTurns = typeof req.turns === 'number' && Number.isFinite(req.turns) && req.turns > 0
    ? Math.floor(req.turns) : null;
  const askedMinutes = typeof req.minutes === 'number' && Number.isFinite(req.minutes) && req.minutes > 0
    ? Math.floor(req.minutes) : null;
  const turns = Math.min(askedTurns ?? REPORT_WINDOW_MAX_TURNS, REPORT_WINDOW_MAX_TURNS);
  const minutes = Math.min(askedMinutes ?? REPORT_WINDOW_MAX_MINUTES, REPORT_WINDOW_MAX_MINUTES);
  const truncated =
    (askedTurns !== null && askedTurns > REPORT_WINDOW_MAX_TURNS) ||
    (askedMinutes !== null && askedMinutes > REPORT_WINDOW_MAX_MINUTES);
  return {
    turns, minutes,
    sinceIso: new Date(now.getTime() - minutes * 60_000).toISOString(),
    truncated,
    askedFor: `${askedTurns ?? 'default'} turns / ${askedMinutes ?? 'default'} minutes`,
  };
}
