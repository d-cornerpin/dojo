// A sender-chosen file name reduced to one that stays in its folder: the download tools join the uploads dir
// with it for their DEFAULT save path, and `path.join` resolves `..` and absolute parts. An explicit
// `save_path` does not come here. A leaf module on purpose: the mail tool modules import it, not each other.

import path from 'node:path';

/** Final path component of a sender-chosen name, control characters dropped; empty or `..` gives `fallback`. */
export function safeAttachmentName(name: string | undefined, fallback: string): string {
  if (name === undefined) return fallback;
  // Backslashes first: a Windows-style `a\b\c.txt` must not survive basename() whole.
  const base = path.basename(name.replace(/\\/g, '/'));
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}
