// Providers' own "input too long" answers differ in wording per provider: match substrings, not codes.
// A leaf: the summary writer and the recovery cascade read one predicate; neither pulls the other's graph.

export function isContextOverflowError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('maximum context length') ||
    lower.includes('context_length_exceeded') ||
    lower.includes('prompt is too long') ||
    lower.includes('context length is') ||
    lower.includes('exceeds the context window') ||
    lower.includes('reduce the length') ||
    lower.includes('please reduce the length of the messages') ||
    lower.includes('input is too long') ||
    lower.includes('context window of')
  );
}
