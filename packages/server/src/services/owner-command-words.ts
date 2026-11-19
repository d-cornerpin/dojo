// The owner's command words, one grammar shared by the iMessage lane and a confirmed owner email. Approve/deny
// is ambiguous with chat, so it only counts when it resolves a pending imessage-surface proposal.
export type StrictCommand =
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'kill-all' }
  | { kind: 'kill-named'; name: string };

export type ApproveDenyCommand = { kind: 'approve' | 'deny'; shortId: string };

export function parseStrictCommand(trimmed: string): StrictCommand | null {
  if (trimmed === 'status') return { kind: 'status' };
  if (trimmed === 'stop') return { kind: 'stop' };
  if (trimmed === 'kill all') return { kind: 'kill-all' };
  const killMatch = trimmed.match(/^kill\s+(.+)$/);
  if (killMatch && killMatch[1] !== 'all') return { kind: 'kill-named', name: killMatch[1] };
  return null;
}

// Approve/deny REQUIRES the hex short id ("yes 1a2b3c"), so a bare "ok" returns null and flows through as chat
// and can never resolve a pending destructive proposal.
export function parseApproveDeny(trimmed: string): ApproveDenyCommand | null {
  const yes = trimmed.match(/^(?:yes|approve|ok)\s+([0-9a-f]{4,})$/);
  if (yes) return { kind: 'approve', shortId: yes[1] };
  const no = trimmed.match(/^(?:no|deny|decline)\s+([0-9a-f]{4,})$/);
  if (no) return { kind: 'deny', shortId: no[1] };
  return null;
}


/** The first non-empty line, trimmed and lower-cased: a signature or sign-off below it must not hide the command. */
export function firstLineOf(words: string): string {
  return (words.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim().toLowerCase();
}

export function isOwnerCommandText(words: string): boolean {
  const t = firstLineOf(words);
  return parseStrictCommand(t) !== null || parseApproveDeny(t) !== null;
}
