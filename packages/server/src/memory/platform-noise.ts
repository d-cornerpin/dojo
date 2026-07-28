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

import { NEW_SESSION_DIVIDER } from '@dojo/shared';

export const PLATFORM_NOISE_PATTERNS: RegExp[] = [
  /^\s*\[CONTINUITY BRIEF/i,
  /^\s*\[New Session\]/i,
  // PHASE-1 T8: the divider's SHAPE is @dojo/shared's; its MEMBERSHIP in this list is local
  // policy and stays local. Those are different questions, and this entry proves it — the
  // display taxonomy classifies a New Session divider as USER-VISIBLE while this list
  // (what may enter a summary) excludes it. Collapsing the two lists would make a
  // summariser change a display change.
  new RegExp(`^\\s*${NEW_SESSION_DIVIDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  /^\s*\[System: /i,
  /^\s*\[SOURCE: SYSTEM/i,
  /^\s*\[SOURCE: HEALER/i,
  /^\s*\[SOURCE: SCHEDULER/i,
  /^\s*\[SOURCE: SUB-AGENT COMPLETION/i,
  /^\s*\[SOURCE: TRACKER TASK/i,
  /^\s*\[SOURCE: PM AGENT POKE/i,
  /^\s*\[SOURCE: AGENT HEALTH ALERT/i,
  /^\s*\[SOURCE: AGENT NOTICE/i, // brief self-attributed service-agent notices (spawner)
  /^\s*\[Context note: the user just hit the Stop button/i,
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
