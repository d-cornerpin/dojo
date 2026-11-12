// Spoken acknowledgments played through the active TTS burst while tools run on a voice turn. The
// trailing punctuation gives the clause splitter a clean boundary so the filler is its own audio chunk.
const FILLER_PHRASES: readonly string[] = [
  'On it.',
  'One sec.',
  'Hold on.',
  'Give me a sec.',
  'Looking into it.',
  'Checking.',
  'Let me grab that.',
  'Hang on a moment.',
  'Working on it.',
  'Pulling that up.',
  'Sec.',
  'Right on it.',
  'Give me a minute.',
  'Let me check.',
  'Looking that up.',
  'Coming right up.',
  'Just a sec.',
  'On it now.',
  'Let me dig in.',
  'Checking on that.',
] as const;

// A random phrase from the list.
export function pickFillerPhrase(): string {
  const idx = Math.floor(Math.random() * FILLER_PHRASES.length);
  return FILLER_PHRASES[idx] ?? FILLER_PHRASES[0];
}
