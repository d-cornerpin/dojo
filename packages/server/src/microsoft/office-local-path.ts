// Is this office edit target a local file? Shared by handlers and gate loop so answers cannot drift; a leaf.

import path from 'node:path';
import { homeDir } from '../home.js';

function expandLocalHome(p: string): string {
  return p.startsWith('~') ? path.join(homeDir(), p.slice(1)) : p;
}

/** The file_id half the effect declaration uses: a path-like id names a local file; a real OneDrive id
 *  must return null, or the declaration would mint an fs grant for a file the tool never touches. */
export function localPathFromFileId(fileId: unknown): { path: string } | null {
  if (typeof fileId !== 'string') return null;
  const trimmed = fileId.trim();
  if (!trimmed || !(trimmed.startsWith('/') || trimmed.startsWith('~'))) return null;
  return { path: expandLocalHome(trimmed) };
}

export function officeLocalPath(args: Record<string, unknown>): string | null {
  const explicit = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
  if (explicit) return expandLocalHome(explicit);
  return localPathFromFileId(args.file_id)?.path ?? null;
}
