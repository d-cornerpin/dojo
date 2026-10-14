// The provider's own "your input is too long for my window" answer, as prose. A leaf: the summary writer
// (t152) and the recovery cascade read the one predicate, and neither may pull the other's module graph.

/**
 * Detect provider responses that indicate the prompt exceeded the model's
 * context window. Different providers phrase this differently, so we match
 * on common substrings rather than error codes.
 */
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
