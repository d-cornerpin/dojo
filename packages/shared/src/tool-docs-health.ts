// One rule for whether the tool-manual set is complete, shared by the boot log (server) and the Vitals card
// (dashboard) so they cannot disagree. Pure: the server records the numbers, the dashboard renders them.

export interface ToolDocsHealth {
  expected: number;
  written: number;
  missing: number;
  dir: string;
  lastError: string | null;
  checkedAt: string | null;
}

// Null when nothing is reported or missing; anything missing speaks, since stale manuals read like current ones.
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
