import { createLogger } from '../logger.js';
import type { DiagnosticItem } from './diagnostic.js';

const logger = createLogger('healer-diagnostic');

/** A throwing check becomes ONE uncapped warning that names it (reason in the server log). */
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
