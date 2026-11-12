// Whether this box's tool manuals match what the registry asked for. The check lives in this recorder
// (not at the call site) so it runs on every boot. A leaf whose only import is the logger, so `/health`
// does not import the tool registry the generator pulls in. The wording is `@dojo/shared`'s
// `toolDocsShortfall`, the rule the dashboard's Vitals card reads, so log and card cannot disagree.

import { toolDocsShortfall, type ToolDocsHealth } from '@dojo/shared';
import { createLogger } from '../logger.js';

const logger = createLogger('tool-docs-freshness');

/** `null` until boot has measured, deliberately not a hopeful zero-state. */
let current: ToolDocsHealth | null = null;

/** Record what the generator wrote against what the registry asked for. A shortfall logs an ERROR. */
export function recordToolDocsGeneration(measured: {
  expected: number;
  written: number;
  dir: string;
  lastError: string | null;
  pruned?: number;
}): ToolDocsHealth {
  const missing = Math.max(0, measured.expected - measured.written);
  current = {
    expected: measured.expected,
    written: measured.written,
    missing,
    dir: measured.dir,
    lastError: measured.lastError,
    checkedAt: new Date().toISOString(),
  };

  const shortfall = toolDocsShortfall(current);
  if (shortfall) {
    logger.error('Tool manuals are INCOMPLETE — agents may be reading stale instructions', {
      expected: current.expected,
      written: current.written,
      missing: current.missing,
      dir: current.dir,
      lastError: current.lastError,
      detail: shortfall,
    });
  } else {
    logger.info('Tool docs generated', {
      count: current.written,
      expected: current.expected,
      pruned: measured.pruned ?? 0,
      dir: current.dir,
    });
  }
  return current;
}

/** The generator threw outright, so nothing was written; recorded (not only logged) for `/health`. */
export function recordToolDocsFailure(dir: string, error: unknown, expected = 0): ToolDocsHealth {
  return recordToolDocsGeneration({
    expected: Math.max(expected, 1),
    written: 0,
    dir,
    lastError: error instanceof Error ? error.message : String(error),
  });
}

/** What boot measured, or `null` when it has not run. Read by `/health`. */
export function toolDocsStatus(): ToolDocsHealth | null {
  return current;
}

export function resetToolDocsStatusForTests(): void {
  current = null;
}
