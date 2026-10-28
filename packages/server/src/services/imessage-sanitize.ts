// Outbound-iMessage markdown cleaning, isolated as a pure, dependency-free helper
// so the strip order is unit-testable without pulling in the whole iMessage bridge
// graph. The fenced block must be stripped BEFORE the inline-code step (otherwise
// the inline step eats a backtick off each side of the fence), and the italic step
// must never read arithmetic like "5 * 3 * 2" as emphasis.
export function sanitizeForIMessage(rawText: string): string {
  let text = rawText;
  text = text.replace(/\\n/g, '\n');                                            // literal \n -> real newline
  text = text.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_m, code: string) => code.replace(/\n+$/, '')); // code fence: drop the fence and language word, keep the code
  text = text.replace(/`([^`\n]+)`/g, '$1');                                   // `code` -> code
  text = text.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '$1');                    // **bold** -> bold
  text = text.replace(/(^|[^\w*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?!\w)/g, '$1$2'); // *italic* -> italic (never "a * b * c")
  text = text.replace(/^#{1,6}\s+/gm, '');                                     // # headers -> plain
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');                          // [text](url) -> text (unchanged behaviour)
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
