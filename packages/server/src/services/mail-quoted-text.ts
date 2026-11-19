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

  // Keep only the text before the cut, drop inline `>` quotes and the line that introduces one, strip trailing spaces.
  const kept: string[] = [];
  for (let i = 0; i < cut; i++) {
    if (lines[i].trimStart().startsWith('>') || isAttribution(lines, i)) continue;
    kept.push(lines[i].replace(/[ \t]+$/, ''));
  }

  let start = 0;
  let end = kept.length;
  while (start < end && kept[start].trim() === '') start++;
  while (end > start && kept[end - 1].trim() === '') end--;

  return kept.slice(start, end).join('\n');
}

// Block starts: `On ... wrote:` (or its wrap), an Original/Forwarded banner, From: + Sent:/Date:, `Begin forwarded`.
function isBlockStart(lines: string[], i: number): boolean {
  const t = lines[i].trim().toLowerCase();

  if (t.startsWith('on ')) {
    if (t.endsWith('wrote:')) return true;
    if ((lines[i + 1] ?? '').trim().toLowerCase().endsWith('wrote:')) return true;
  }

  if (/^-{2,}\s*(?:original message|forwarded message)\s*-{2,}$/.test(t)) return true;

  if (t.startsWith('from:')) {
    const next = (lines[i + 1] ?? '').trim().toLowerCase();
    if (next.startsWith('sent:') || next.startsWith('date:')) return true;
  }

  if (t === 'begin forwarded message:') return true;

  return false;
}

// A "who wrote this" line in any language: it ends in ':', names an address or a date ('@' or a digit), and a `>`
// quote follows it directly. Only it goes (with its quote); the owner's lines after the quote stay.
function isAttribution(lines: string[], i: number): boolean {
  const t = lines[i].trim();
  return t.endsWith(':') && /[@\d]/.test(t) && (lines[i + 1] ?? '').trimStart().startsWith('>');
}
