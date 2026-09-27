// ════════════════════════════════════════════════════════════════════════════
// WHETHER THIS BOX'S TOOL MANUALS ARE THE ONES IT SHIPPED WITH (installed-box audit).
//
// ── THE DEFECT THIS MODULE EXISTS FOR ──
// `index-generator.ts` wrote each `~/.dojo/tools/<tool>.md` inside its own
// try/catch, logged `warn` on failure, and counted only successes. Nothing
// compared the count against the registry, so an unwritable docs directory —
// which does NOT make `mkdirSync(…, {recursive:true})` throw, because the
// directory already exists — produced N warn lines, `count: 0`, an INFO line
// reading "Tool docs generated", and a box that served the previous version's
// manuals for ever. The failure is silent by construction: a stale manual reads
// exactly like a current one.
//
// ── WHY A LEAF MODULE RATHER THAN A FIELD ON THE GENERATOR ──
// Two readers need this answer and neither may import the other's world. The
// generator statically imports the WHOLE tool registry (`registryToolDefinitions`),
// and `/health` must not pull that into its module graph to answer a liveness
// poll — the same reasoning that split the doc READER out of the generator
// (RULING P5-R15 part 2). So the numbers live here, in a module whose only
// import is the logger, and the generator writes them on its way past.
//
// ── ONE SPEAKER ──
// The comparison happens HERE, in the recorder, not at the call site: a check
// the caller performs is a check a future caller forgets, and this one runs on
// every boot by construction. The WORDING is `@dojo/shared`'s
// `toolDocsShortfall` — the same rule the dashboard's Vitals card reads — so the
// log the owner greps and the card the owner looks at cannot come to disagree
// about whether the platform is lying to its own agents.
// ════════════════════════════════════════════════════════════════════════════

import { toolDocsShortfall, type ToolDocsHealth } from '@dojo/shared';
import { createLogger } from '../logger.js';

const logger = createLogger('tool-docs-freshness');

/** `null` until boot has measured. Deliberately not a hopeful zero-state. */
let current: ToolDocsHealth | null = null;

/**
 * Record what the generator managed, compare it with what the registry asked
 * for, and say so at the right level.
 *
 * A shortfall is an ERROR: the box is serving instructions it cannot vouch for.
 * A complete set is the ordinary INFO line boot has always written.
 */
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

/**
 * The generator threw outright — the directory could not even be created, the
 * registry could not be read. Nothing was written, and the honest `expected` is
 * whatever the caller could still establish (0 when even that failed).
 *
 * Recorded rather than only logged, because the boot catch that used to own this
 * case logged one `warn` and left `/health` with nothing to report.
 */
export function recordToolDocsFailure(dir: string, error: unknown, expected = 0): ToolDocsHealth {
  return recordToolDocsGeneration({
    expected: Math.max(expected, 1), // a throw means at least one manual is owed
    written: 0,
    dir,
    lastError: error instanceof Error ? error.message : String(error),
  });
}

/** What boot measured, or `null` when it has not run. Read by `/health`. */
export function toolDocsStatus(): ToolDocsHealth | null {
  return current;
}

/** Test seam: the record is process state, and a suite drives boot more than once. */
export function resetToolDocsStatusForTests(): void {
  current = null;
}
