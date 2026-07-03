// ════════════════════════════════════════
// D15: plain-text channel formatter
//
// SMS (and, as a stronger pass, iMessage) can't render markdown, so a reply
// containing **bold**, `code`, ``` fences, "| tables |", "- bullets", or
// [links](url) arrives as literal syntax. This is ONE shared formatter that
// strips markdown down to readable plain text. It shares intent with the voice
// sanitizer (voice/text-sanitize.ts) but is deliberately kept separate so this
// change never touches voice code. Idempotent on plain input (no markdown ->
// unchanged), so it is safe to apply to every outbound body.
// ════════════════════════════════════════

export function formatForPlainTextChannel(input: string): string {
  if (!input) return input;
  let s = input.replace(/\r\n/g, '\n');

  // Fenced code blocks: drop the ``` fences, keep the code inside.
  s = s.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, '');
  // Inline code: drop the backticks.
  s = s.replace(/`([^`]+)`/g, '$1');
  // Images then links: ![alt](url) -> alt ; [text](url) -> text (url)
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // Emphasis: **bold**, __bold__, *italic*, _italic_, ~~strike~~
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');
  s = s.replace(/~~(.*?)~~/g, '$2');
  // NOTE: these are line-oriented, so use [ \t] not \s inside character classes
  // and anchors, \s matches newlines and would merge adjacent lines together.
  // Headings: strip leading #'s.
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  // Blockquotes: strip leading '>'.
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
  // Table separator rows (---|:--:) -> removed.
  s = s.replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/gm, '');
  // Table body rows "| a | b |" -> "a, b".
  s = s.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) =>
    row.split('|').map((c) => c.trim()).filter(Boolean).join(', '));
  // Bullets: -, *, + -> a real bullet.
  s = s.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ');
  // Horizontal rules on their own line.
  s = s.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '');
  // Collapse 3+ blank lines to a single blank line.
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}
