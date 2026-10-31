// One file name from an inbound email or chat → a name that stays in its folder.
//
// The download tools (gmail_read_attachment, outlook_download_attachment,
// teams_download_attachment) build their DEFAULT save path by joining the
// agent's uploads dir with the attachment name the SENDER chose, and
// `path.join` resolves `..` and absolute-looking parts — so a name like
// `../../notes.txt` wrote outside `~/.dojo/uploads/<agent>/`. Nothing in the
// product intends a sender's file name to choose a folder. Leaf module on
// purpose: the three tool modules import it without pulling each other in.
// An explicit `save_path` is the caller's own choice and does not come here.

import path from 'node:path';

/** Reduce a sender-chosen name to its final path component. Control characters
 *  (including NUL) are dropped; an empty, `.` or `..` result returns `fallback`. */
export function safeAttachmentName(name: string | undefined, fallback: string): string {
  if (name === undefined) return fallback;
  // Backslashes first: a Windows-style `a\b\c.txt` must not survive basename() whole.
  const base = path.basename(name.replace(/\\/g, '/'));
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}
