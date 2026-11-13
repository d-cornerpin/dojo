// Two gates on a person's message that are not judgments: an engine-injected row is never the person's intent, and
// an explicit request to open a tracker entry is the agent's own to build. `inbound-routing.ts` asks the rest.

// Engine-injected user-role messages are never user intent: they carry action verbs and would
// make the receiving agent auto-create a project from the engine's own handoff text.
const ENGINE_MESSAGE_PREFIXES: readonly string[] = [
  '[ENGINE RENAME REQUEST]',
  '[PLATFORM MIGRATION]',
  '[TECHNIQUE IMPORT]',
  '[SOURCE: ',
  '[A2A:',
  '[scheduler:',
  '[System:',
  '[SYSTEM ',
];

export function looksLikeEngineMessage(query: string): boolean {
  const trimmed = query.trimStart();
  return ENGINE_MESSAGE_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

const EXPLICIT_CREATION_PATTERNS: readonly RegExp[] = [
  /\b(start|create|make|set ?up|open|build|spin ?up)\s+(a |an |the |another )?(new\s+)?(tracker\s+)?project\b/i,
  /\b(start|create|make|add|put|register)\s+(a |an |the |another )?(new\s+)?(tracker\s+)?task\b/i,
  /\b(track|log|put|add)\s+(this|it|that|these|them)\s+(in|into|on|to)\s+(the\s+)?tracker\b/i,
  /\b(open|create|make|start)\s+(a |an |the )?(tracker\s+entry|tracker\s+item|tracker\s+record)\b/i,
];

export function userExplicitlyAsksToCreateTracker(query: string): boolean {
  return EXPLICIT_CREATION_PATTERNS.some((re) => re.test(query));
}
