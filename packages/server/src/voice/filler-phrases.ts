/**
 * Short spoken acknowledgments fired when the agent is about to run
 * tools on a voice-triggered turn. Plays through the active TTS burst
 * so the user doesn't sit in silence while tool calls execute.
 *
 * Picked at random per turn. Mix of register/length so repeated use
 * doesn't sound robotic - one-word ("checking"), casual two-word ("on
 * it"), and short phrasal ("give me a sec") all sit alongside each
 * other.
 *
 * Punctuation matters: trailing comma/period gives Kokoro's clause
 * splitter a clean boundary so the filler renders as its own audio
 * chunk and the actual response (when it arrives) doesn't blend with
 * it mid-word.
 */
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

/**
 * Returns a random filler phrase. Cheap (constant-time index pick),
 * deterministic per call from Math.random.
 */
export function pickFillerPhrase(): string {
  const idx = Math.floor(Math.random() * FILLER_PHRASES.length);
  return FILLER_PHRASES[idx] ?? FILLER_PHRASES[0];
}
