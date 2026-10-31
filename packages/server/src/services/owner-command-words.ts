// ════════════════════════════════════════
// The owner's command words (status / kill / pause / resume, and "yes <id>" / "no <id>"): ONE grammar, light enough to
// import anywhere, shared by the iMessage lane and a confirmed owner email (R24).
// ════════════════════════════════════════

// ── Parsed command grammar ──────────────────────────────────────────────────
// Strict commands are unambiguous keywords. Approve/deny are ambiguous with
// ordinary chat ("ok", "no"), so they are parsed separately and only treated as
// a command when they actually resolve a pending imessage-surface proposal.
export type StrictCommand =
  | { kind: 'status' }
  | { kind: 'kill-all' }
  | { kind: 'kill-named'; name: string }
  | { kind: 'pause' }
  | { kind: 'resume' };

export type ApproveDenyCommand = { kind: 'approve' | 'deny'; shortId: string };

export function parseStrictCommand(trimmed: string): StrictCommand | null {
  if (trimmed === 'status') return { kind: 'status' };
  if (trimmed === 'kill all') return { kind: 'kill-all' };
  const killMatch = trimmed.match(/^kill\s+(.+)$/);
  if (killMatch && killMatch[1] !== 'all') return { kind: 'kill-named', name: killMatch[1] };
  if (trimmed === 'pause') return { kind: 'pause' };
  if (trimmed === 'resume') return { kind: 'resume' };
  return null;
}

// B2: approve/deny of a proposal REQUIRES the hex short id (the outbound text
// instructs exactly that: Reply "yes 1a2b3c"). The id is the first 8 chars of a
// uuid, so it is hex-only, which means ordinary chatter can never parse as a
// command. A bare "yes"/"ok"/"no" (no id) is NEVER an approval: it returns null
// here and flows through as ordinary chat, so an unrelated "ok" cannot resolve a
// live destructive proposal that happens to be pending.
export function parseApproveDeny(trimmed: string): ApproveDenyCommand | null {
  const yes = trimmed.match(/^(?:yes|approve|ok)\s+([0-9a-f]{4,})$/);
  if (yes) return { kind: 'approve', shortId: yes[1] };
  const no = trimmed.match(/^(?:no|deny|decline)\s+([0-9a-f]{4,})$/);
  if (no) return { kind: 'deny', shortId: no[1] };
  return null;
}


/** Are these words a command or an approval at all? */
export function isOwnerCommandText(words: string): boolean {
  const t = words.trim().toLowerCase();
  return parseStrictCommand(t) !== null || parseApproveDeny(t) !== null;
}
