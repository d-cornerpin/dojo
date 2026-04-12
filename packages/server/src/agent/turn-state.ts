// Per-agent turn state shared between the runtime and context assembler.
// Lives in its own module to avoid circular imports (runtime ↔ assembler).

// Timestamp of when each agent's current turn started — context assembly
// uses this to exclude user messages that arrived mid-turn so they get
// a fresh run via the wakeup mechanism.
export const turnBoundary = new Map<string, string>();
