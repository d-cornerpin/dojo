// ════════════════════════════════════════════════════════════════════════════
// ATTACHMENT ID → THE PATH THE PLATFORM RECORDED — a leaf (PHASE-5 T8 Step 3,
// RULING P5-R15 ADDENDUM mechanic 5).
//
// Extracted VERBATIM from `services/transcription.ts` for the same reason
// `agent/path-resolve.ts` was extracted from `agent/permissions.ts`: the gate
// loop has to resolve an attachment id BEFORE it mints the call's capability,
// and it cannot do that by importing the transcription module — that module
// pulls in the local STT engines and a subprocess spawn, none of which belong
// in the executor's graph. `transcription.ts` re-exports the name it used to
// own, so no consumer moved.
//
// ── WHY IT IS ONE FUNCTION AND MUST STAY ONE ──
// `transcribe_audio` names its resource INDIRECTLY: the agent passes an
// `attachment_id`, and the file it means is whatever path the platform recorded
// for that id. There is no tree to declare — measured on the real body, the
// recorded paths sit under at least three distinct roots. So the gate loop
// resolves the id with THIS function and mints the grant for the exact path it
// returns, and the handler resolves the id with THIS function too. **One
// resolution point** is what makes the two answers the same fact rather than
// two lookups that can disagree.
//
// ── THE FAILURE SURFACE STAYS THE HANDLER'S ──
// A missing, stale or malformed id returns `null` here, the gate loop mints NO
// grant for it, and the handler produces its own message ("no attachment found
// with id …"). It returns before it touches the disk, so no facade call
// happens and a previously-informative error never becomes a bare refusal.
//
// This module runs BEFORE the capability exists, which is why it holds
// `node:fs` directly and is named in the restricted-import record as part of
// the CARRYING MACHINERY — the same class, and for the same structural reason,
// as `agent/path-resolve.ts`.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import { getDb } from '../db/connection.js';

// Resolve an attachment id to the absolute file path on disk. Audio
// attachments land in ~/.dojo/uploads/<agentId>/<timestamp>_<filename>
// the same as every other chat upload, so we walk the message table
// looking for a matching attachment row.
export function resolveAttachmentPath(fileId: string): { path: string; filename: string; mimeType: string } | null {
  const db = getDb();
  const rows = db.prepare(`
    SELECT attachments FROM messages
    WHERE attachments IS NOT NULL AND attachments != '' AND attachments != '[]'
    ORDER BY created_at DESC
    LIMIT 500
  `).all() as Array<{ attachments: string }>;
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
