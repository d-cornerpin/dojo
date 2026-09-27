// ════════════════════════════════════════════════════════════════════════════
// IS THE TOOL-MANUAL SET COMPLETE? ONE RULE, TWO READERS.
//
// `tools/index-generator.ts` writes one manual per registered tool at boot so
// `load_tool_docs` has something to serve. Until the installed-box audit nothing
// compared what it WROTE against what the registry DECLARES, so a box whose
// `~/.dojo/tools` was not writable logged one `warn` per tool, reported
// `count: 0` at INFO, and went on serving the PREVIOUS version's manuals for
// ever. Every agent read them as current.
//
// ── WHY THE RULE LIVES IN `shared` AND NOT IN EITHER CALLER ──
// Two surfaces must say the same thing about one fact: the boot log the owner
// greps and the Vitals card the owner looks at. A copy in each is how they come
// to disagree — and the disagreement would be about whether the platform is
// currently lying to its own agents. `shared` is the only module both the server
// and the dashboard import, so it is the only place the rule can have one owner.
//
// PURE by construction: no database, no filesystem, no platform identity. The
// server records the numbers, the dashboard renders them, and neither decides
// what "incomplete" means.
// ════════════════════════════════════════════════════════════════════════════

/**
 * What boot measured about the tool-manual set. `null` everywhere it has not
 * reported yet, which is NOT the same as healthy and is why the rule below
 * stays silent rather than green for it.
 */
export interface ToolDocsHealth {
  /** Unique tool names the registry declares — the number that SHOULD be on disk. */
  expected: number;
  /** Manuals actually written this boot. */
  written: number;
  /** `expected - written`, never negative. */
  missing: number;
  /** The directory the manuals were written to. */
  dir: string;
  /** The first real failure text (an errno, a thrown message), or null. */
  lastError: string | null;
  /** When boot last measured this, ISO, or null. */
  checkedAt: string | null;
}

/**
 * THE SENTENCE THE OWNER READS, or `null` when there is nothing to say.
 *
 * Silent in exactly two cases, and both are deliberate:
 *   * no report at all — boot has not reached the generator yet (a fresh
 *     process serving a dashboard poll), and an alarm about an unasked
 *     question is noise;
 *   * nothing missing — the set is complete, which needs no row on a health
 *     page.
 *
 * Anything missing speaks, because the failure it describes is SILENT by
 * nature: stale manuals read exactly like current ones.
 */
export function toolDocsShortfall(d: ToolDocsHealth | null | undefined): string | null {
  if (!d) return null;
  if (!Number.isFinite(d.missing) || d.missing <= 0) return null;

  const manuals = d.missing === 1 ? 'manual' : 'manuals';
  const parts = [
    `${d.missing} of ${d.expected} tool ${manuals} could not be written`,
    d.dir ? ` to ${d.dir}` : '',
    `. Agents asking for those ${d.missing === 1 ? 'instructions' : 'instructions'} get whatever was on disk before`,
    ' — after an upgrade that means the previous version\'s manuals, which read exactly like current ones.',
  ];
  if (d.lastError) parts.push(` Last error: ${d.lastError}`);
  return parts.join('');
}
