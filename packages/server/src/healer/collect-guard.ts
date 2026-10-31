// One guard for the Healer report's checks: a check that throws becomes ONE visible warning, so
// the rest of the report is still built and a failed check never reads as "all good".
import { createLogger } from '../logger.js';
import type { DiagnosticItem } from './diagnostic.js';

const logger = createLogger('healer-diagnostic');

/**
 * Run one report check inside a guard. If it throws, the report still gets built: the missing
 * items are replaced by ONE warning that names the check (no stack, no row data; the reason is in
 * the server log), so a failed check never reads as "all good". The failure item is never capped.
 * Used by diagnostic.ts and harness-sections.ts.
 */
export function collect(label: string, fn: () => DiagnosticItem[]): DiagnosticItem[] {
  try {
    return fn();
  } catch (err) {
    logger.warn(`Healer check "${label}" failed: ${err instanceof Error ? err.message : String(err)}`);
    return [{
      severity: 'warning',
      code: 'COLLECTOR_FAILED',
      title: `The ${label} check could not run`,
      detail: `The ${label} part of the health report could not be built, so it is missing from this report. The reason is in the server log.`,
    }];
  }
}
