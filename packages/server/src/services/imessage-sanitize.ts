// Strips markdown for outbound iMessage. Fenced code goes BEFORE inline code (else the inline step eats a fence
// backtick), and the italic step must never read arithmetic like "5 * 3 * 2" as emphasis.
export function sanitizeForIMessage(rawText: string): string {
  let text = rawText;
  text = text.replace(/\\n/g, '\n');                                            // literal \n -> real newline
  text = text.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_m, code: string) => code.replace(/\n+$/, '')); // code fence: drop the fence and language word, keep the code
  text = text.replace(/`([^`\n]+)`/g, '$1');                                   // `code` -> code
  text = text.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '$1');                    // **bold** -> bold
  text = text.replace(/(^|[^\w*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?!\w)/g, '$1$2'); // *italic* -> italic (never "a * b * c")
  text = text.replace(/^#{1,6}\s+/gm, '');                                     // # headers -> plain
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');                          // ![alt](url) -> alt (an image has no use in a text)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => (label.trim() === url.trim() ? url : `${label} (${url})`)); // [text](url) -> text (url), the address is kept
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
