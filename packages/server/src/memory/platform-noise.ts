// ════════════════════════════════════════════════════════════════════════
// Platform-noise taxonomy — the single source of truth for "this message row
// is platform/inter-agent plumbing, not conversation."
//
// These are rows that ride in an agent's `messages` table but are NOT part of
// its conversation with a human or its own work narrative: sub-agent completion
// notifications, PM/scheduler/healer pokes, tracker notices, session dividers,
// synthetic assembler acks, embedded SOUL prompts, Dreamer cycle scaffolding.
//
// Historically only the vault archiver stripped these (so they didn't become
// "memories"). But LIVE compaction did not — so it folded a sub-agent's
// completion dump or a PM poke into the context summaries the primary model
// reads every turn, and the model then narrated another agent's work back to
// the user (the repeated "Dreamer batch" summaries). Same taxonomy, shared
// here so compaction and the vault agree on what is plumbing vs. conversation.
//
// NOTE: inbound A2A ([A2A: …]) is intentionally NOT in this base list — an A2A
// deliverable ("Maddy delivered the Verve deck") can be genuine memory, so the
// vault keeps it. Compaction layers the A2A-inbound check on top separately,
// because for the PRIMARY's own context summary an inbound peer message is
// inter-agent traffic, not the user's conversation.
// ════════════════════════════════════════════════════════════════════════

// PHASE-3 T5: the SHAPES come from the taxonomy; the MEMBERSHIP below stays local policy
// (PHASE-1 T8's non-fold entry is the record of why those are two questions).
import { NEW_SESSION_DIVIDER, CONTEXT_NOTE_PREFIX, NEW_SESSION_BRACKET_RE,
  PLATFORM_SOURCE_ENVELOPE_PREFIXES } from '@dojo/shared';

/** `^\s*<literal>`, case-insensitive — the anchored form of a taxonomy prefix. */
function noiseOf(prefix: string): RegExp {
  return new RegExp(`^\\s*${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
}

export const PLATFORM_NOISE_PATTERNS: RegExp[] = [
  /^\s*\[CONTINUITY BRIEF/i,
  // PHASE-3 T5: required the CLOSING bracket, so the dated `[New Session: … ]` form was
  // invisible. One matcher, both live spellings.
  NEW_SESSION_BRACKET_RE,
  // PHASE-1 T8: the divider's SHAPE is @dojo/shared's; its MEMBERSHIP in this list is local
  // policy and stays local. Those are different questions, and this entry proves it — the
  // display taxonomy classifies a New Session divider as USER-VISIBLE while this list
  // (what may enter a summary) excludes it. Collapsing the two lists would make a
  // summariser change a display change.
  new RegExp(`^\\s*${NEW_SESSION_DIVIDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  /^\s*\[System: /i,
  // PHASE-3 T5: eight hand-written [SOURCE: …] anchors became ONE taxonomy list — the
  // PLATFORM half ONLY. `A2A_LEGACY_SOURCE_PREFIXES` stays OUT because the header above
  // says why: an A2A deliverable can be genuine memory and the vault keeps it. Importing
  // the FULL `SOURCE_ENVELOPE_PREFIXES` here would have deleted real memories.
  ...PLATFORM_SOURCE_ENVELOPE_PREFIXES.map(noiseOf),
  // Deliberately BROADER than the taxonomy's `… PM AGENT POKE FROM`: no ` FROM`, so a
  // legacy poke row with no sender is still excluded. Tidying it away would admit them.
  /^\s*\[SOURCE: PM AGENT POKE/i,
  // PHASE-3 T5: was the STOP marker's full sentence only; its identical-prefixed twin, the
  // A2A-preempt note, was not — research 06 §5's "'[Context note:' gap". MEASURED before
  // widening: 0 rows and 0 summaries carry `[Context note:` in any form (both markers are
  // assembly-time injections, never persisted), so this closes a latent asymmetry, not a
  // live leak. Said that way rather than claimed as a fix.
  noiseOf(CONTEXT_NOTE_PREFIX),
  /^\s*Tracker review --/i,
  /^I got stuck on that/i,
  /^I'm sorry — I'm having trouble/i,
  /^Understood, I have reviewed/i, // synthetic ack messages from the assembler
  /^Understood, I know what I was working on/i,
  /^Understood, I will continue working on my active tasks/i,
  // Dreamer cycle messages and embedded SOUL prompts — the single biggest source
  // of recursive bloat (the Dreamer's own past cycle messages and SOUL.md being
  // re-archived and re-fed).
  /^\s*═══ DREAM CYCLE ═══/,
  /^\s*═══ COMPRESSED HISTORY/,
  /^\s*Vault state: \d+ entries/,
  /^\s*Process the archives below/i,
  /^\s*Full archive list \(\d+ total\)/i,
  /^\s*This is batch \d+ of \d+/i,
  /^\s*# Identity\s*$/m, // start of any SOUL.md prompt embedded in a message
  /^\s*You are the (Dreamer|Trainer|Healer|PM|Imaginer)\b/i,
];

/** True if the content is platform/inter-agent plumbing (not conversation). */
export function isPlatformNoise(content: string | null | undefined): boolean {
  if (!content) return false;
  for (const pat of PLATFORM_NOISE_PATTERNS) {
    if (pat.test(content)) return true;
  }
  return false;
}
