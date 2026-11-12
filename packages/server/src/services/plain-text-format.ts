// Strips markdown to plain text for SMS and iMessage; unchanged on plain input, so safe on every outbound
// body. Kept separate from voice/text-sanitize.ts.

export function formatForPlainTextChannel(input: string): string {
  if (!input) return input;
  let s = input.replace(/\r\n/g, '\n');

  s = s.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, '');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // Emphasis: an open marker must be followed by a non-space and a close marker preceded by one, so `*` as an
  // operator (2 * 3 * 4) is left alone; `_` and `__` also cannot sit inside a word (snake_case_word).
  s = s.replace(/(\*\*)(?=\S)(.*?)(?<=\S)\1/g, '$2');
  s = s.replace(/(?<![A-Za-z0-9])(__)(?=\S)(.*?)(?<=\S)\1(?![A-Za-z0-9])/g, '$2');
  s = s.replace(/(?<![A-Za-z0-9*])(\*)(?=\S)(.*?)(?<=\S)\1(?![A-Za-z0-9*])/g, '$2');
  s = s.replace(/(?<![A-Za-z0-9])(_)(?=\S)(.*?)(?<=\S)\1(?![A-Za-z0-9])/g, '$2');
  s = s.replace(/~~(.*?)~~/g, '$1');
  // Line-oriented: use [ \t] not \s in classes and anchors, since \s matches newlines and merges lines.
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
  s = s.replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/gm, '');
  s = s.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) =>
    row.split('|').map((c) => c.trim()).filter(Boolean).join(', '));
  s = s.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ');
  s = s.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}
