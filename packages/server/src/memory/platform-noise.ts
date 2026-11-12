// Rows that are platform or inter-agent plumbing, never conversation; live compaction and the vault archiver
// share it. Inbound A2A (and A2A_LEGACY_SOURCE_PREFIXES) is deliberately absent: a deliverable can be memory.

import { NEW_SESSION_DIVIDER, CONTEXT_NOTE_PREFIX, NEW_SESSION_BRACKET_RE,
  PLATFORM_SOURCE_ENVELOPE_PREFIXES } from '@dojo/shared';

function noiseOf(prefix: string): RegExp {
  return new RegExp(`^\\s*${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
}

export const PLATFORM_NOISE_PATTERNS: RegExp[] = [
  /^\s*\[CONTINUITY BRIEF/i,
  NEW_SESSION_BRACKET_RE,
  // Excluded here though the display taxonomy shows it: this list is what may enter a summary.
  new RegExp(`^\\s*${NEW_SESSION_DIVIDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  /^\s*\[System: /i,
  ...PLATFORM_SOURCE_ENVELOPE_PREFIXES.map(noiseOf),
  // Broader than the taxonomy's `PM AGENT POKE FROM`, so a poke row with no sender is still excluded.
  /^\s*\[SOURCE: PM AGENT POKE/i,
  noiseOf(CONTEXT_NOTE_PREFIX),
  /^\s*Tracker review --/i,
  /^I got stuck on that/i,
  /^I'm sorry — I'm having trouble/i,
  /^Understood, I have reviewed/i,
  /^Understood, I know what I was working on/i,
  /^Understood, I will continue working on my active tasks/i,
  /^\s*═══ DREAM CYCLE ═══/,
  /^\s*═══ COMPRESSED HISTORY/,
  /^\s*Vault state: \d+ entries/,
  /^\s*Process the archives below/i,
  /^\s*Full archive list \(\d+ total\)/i,
  /^\s*This is batch \d+ of \d+/i,
  /^\s*# Identity\s*$/m,
  /^\s*You are the (Dreamer|Trainer|Healer|PM|Imaginer)\b/i,

  // Transient status lines from `agent/v2/recovery.ts`, never a bare `Heads up:` (other owner alerts are memory).
  // Every spelling stays because stored rows carry them.
  /^(?:Heads up: I hit my model's size limit — trimming my context|Dojo: the agent hit its model's size limit — trimming its context|Dojo: the agent hit its model's size limit, so it is trimming its context) and retrying now\.$/,
  /^(?:Heads up: I couldn't finish answering[\s\S]*my model couldn't process this much context in time, (?:even after I trimmed it once and tried again|and I couldn't trim it down enough to try again)|Dojo: the agent couldn't finish answering[\s\S]*its model couldn't process this much context in time, (?:even after it was trimmed once and tried again|and it couldn't be trimmed down enough to try again))\. The Healer is looking into it\.$/,
];

export function isPlatformNoise(content: string | null | undefined): boolean {
  if (!content) return false;
  for (const pat of PLATFORM_NOISE_PATTERNS) {
    if (pat.test(content)) return true;
  }
  return false;
}
