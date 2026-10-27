// The sender's own new text in a stored message: everything up to the first
// quoted/forwarded block, with inline `>` quotes dropped. Pure, no deps.
export function newTextOf(body: string): string {
  if (typeof body !== 'string') return '';

  const lines = body.replace(/\r\n/g, '\n').split('\n');

  // Cut at the first line that begins a quoted/forwarded block; drop it and all after.
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (isBlockStart(lines, i)) {
      cut = i;
      break;
    }
  }

  // Keep only the text before the cut, drop inline `>` quotes, and strip trailing spaces.
  const kept: string[] = [];
  for (let i = 0; i < cut; i++) {
    if (lines[i].trimStart().startsWith('>')) continue;
    kept.push(lines[i].replace(/[ \t]+$/, ''));
  }

  // Trim blank lines at both ends, keeping the sender's own breaks in between.
  let start = 0;
  let end = kept.length;
  while (start < end && kept[start].trim() === '') start++;
  while (end > start && kept[end - 1].trim() === '') end--;

  return kept.slice(start, end).join('\n');
}

// A line begins a quoted/forwarded block when (trimmed, case-insensitive) it is
// an `On … wrote:` line (or its two-line wrap), an `----- Original/Forwarded
// Message -----` banner, an Outlook `From:` / `Sent:`|`Date:` header, or
// `Begin forwarded message:`.
function isBlockStart(lines: string[], i: number): boolean {
  const t = lines[i].trim().toLowerCase();

  // On … wrote: on the same line, or the two-line wrap where the next line carries wrote:.
  if (t.startsWith('on ')) {
    if (t.endsWith('wrote:')) return true;
    if ((lines[i + 1] ?? '').trim().toLowerCase().endsWith('wrote:')) return true;
  }

  // ----- Original Message ----- / ---------- Forwarded message ---------
  if (/^-{2,}\s*(?:original message|forwarded message)\s*-{2,}$/.test(t)) return true;

  // Outlook header block: a From: line immediately followed by Sent: or Date:.
  if (t.startsWith('from:')) {
    const next = (lines[i + 1] ?? '').trim().toLowerCase();
    if (next.startsWith('sent:') || next.startsWith('date:')) return true;
  }

  // Begin forwarded message:
  if (t === 'begin forwarded message:') return true;

  return false;
}
