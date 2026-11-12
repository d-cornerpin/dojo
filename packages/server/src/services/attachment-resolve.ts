// Attachment id to the recorded path, shared by the gate and the handler; a leaf so the gate need not import
// transcription.ts (STT engines, subprocess spawn). A missing id returns null: no grant is minted.
// Runs before the capability exists, so it holds node:fs directly (carrying machinery, like path-resolve.ts).

import fs from 'node:fs';
import { getDb } from '../db/connection.js';

export function resolveAttachmentPath(fileId: string): { path: string; filename: string; mimeType: string } | null {
  const db = getDb();
  // `instr` (bound, so `%`/`_` stay literal) pre-filters rows; the loop still matches `fileId` exactly.
  const rows = db.prepare(`
    SELECT attachments FROM messages
    WHERE attachments IS NOT NULL AND attachments != '' AND attachments != '[]'
      AND instr(attachments, ?) > 0
    ORDER BY created_at DESC
  `).all(fileId) as Array<{ attachments: string }>;
  for (const row of rows) {
    try {
      const arr = JSON.parse(row.attachments) as Array<{ fileId: string; filename: string; mimeType: string; path: string }>;
      for (const a of arr) {
        if (a.fileId === fileId) {
          if (fs.existsSync(a.path)) {
            return { path: a.path, filename: a.filename, mimeType: a.mimeType };
          }
        }
      }
    } catch { /* skip malformed row */ }
  }
  return null;
}
