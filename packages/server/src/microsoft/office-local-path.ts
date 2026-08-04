// ════════════════════════════════════════════════════════════════════════════
// IS THIS OFFICE EDIT TARGET A LOCAL FILE? — ONE predicate, one home
// (PHASE-5 T8 Step 3, RULING P5-R15 ADDENDUM 3(1)(c)).
//
// The office edit tools accept a local document in EITHER `path` or `file_id`,
// because models conflate the two and a local-only install has no file_id at
// all. The handler's test has always been "does it start with `/` or `~`" — and
// it was written TWICE in `tools-office.ts`, once for the Word resolver and once
// for the Excel one, which is two chances for the gate loop's answer and the
// handler's answer to drift apart.
//
// ── WHY THIS IS RESOLUTION AND NOT POLICY ──
// The declaration cannot say `fs_read from args.file_id` on its own: that would
// mint a real grant for every genuine OneDrive id, naming a file the tool never
// touches. It cannot say nothing either: that refuses a documented, live
// capability the moment the door converts. So the resolver asks THE HANDLER'S
// OWN QUESTION — and a cloud id resolves to nothing, so no false grant exists.
// Nothing here decides whether a path may be touched; the brokers already did.
//
// It is a leaf so the gate loop can ask this without pulling `docx`, ExcelJS and
// the Graph client into every dispatch's module graph, and it holds no
// restricted import: deciding whether a string looks like a path reads no file.
// ════════════════════════════════════════════════════════════════════════════

import os from 'node:os';
import path from 'node:path';

/** `~/x` → the home-relative absolute path; anything else unchanged. */
function expandLocalHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * The `file_id` half of the predicate, on its own, because that is the half a
 * declaration points at: a `file_id` that is really a filesystem path (starts
 * with `/` or `~`) names a local file; a genuine OneDrive id names none.
 */
export function localPathFromFileId(fileId: unknown): { path: string } | null {
  if (typeof fileId !== 'string') return null;
  const trimmed = fileId.trim();
  if (!trimmed || !(trimmed.startsWith('/') || trimmed.startsWith('~'))) return null;
  return { path: expandLocalHome(trimmed) };
}

/**
 * THE WHOLE PREDICATE, as the handlers ask it: an explicit `path` wins, and
 * otherwise a path-like `file_id` stands in for one. `null` means *this call is
 * against the cloud*, which is the branch the Graph client serves.
 */
export function officeLocalPath(args: Record<string, unknown>): string | null {
  const explicit = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
  if (explicit) return expandLocalHome(explicit);
  return localPathFromFileId(args.file_id)?.path ?? null;
}
