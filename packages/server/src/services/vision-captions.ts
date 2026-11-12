// The vision gate's memory (migration 160): the gate walks the whole history every model call, so each image's
// decision is stored against its own bytes and an image is attempted once, ever. First sighting has no row and
// the toast fires once; later sightings read the store silently.

import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';

export interface VisionCaptionRecord {
  caption: string | null;
  modelId: string | null;
  outcome: 'captioned' | 'failed';
}

// Image identity from the provider-bound block (base64 or url source, else null); url is hashed under its own prefix.
export function imageFingerprint(block: Record<string, unknown>): string | null {
  const src = block.source as Record<string, unknown> | undefined;
  if (!src) return null;
  if (src.type === 'base64' && typeof src.data === 'string') {
    return createHash('sha256').update(`b64:${src.data}`).digest('hex');
  }
  if (src.type === 'url' && typeof src.url === 'string') {
    return createHash('sha256').update(`url:${src.url}`).digest('hex');
  }
  return null;
}

// The gate's stored decision, or null. Best-effort: an unreadable table degrades to attempt-then-strip.
export function lookupVisionCaption(fingerprint: string): VisionCaptionRecord | null {
  try {
    const row = getDb().prepare(
      'SELECT caption, model_id AS modelId, outcome FROM vision_captions WHERE fingerprint = ?',
    ).get(fingerprint) as VisionCaptionRecord | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** `INSERT OR IGNORE`: the first verdict on an image is durable, so racing turns cannot flip it. */
export function recordVisionCaption(
  fingerprint: string,
  outcome: 'captioned' | 'failed',
  caption: string | null,
  modelId: string | null,
): void {
  try {
    getDb().prepare(
      `INSERT OR IGNORE INTO vision_captions (fingerprint, caption, model_id, outcome, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(fingerprint, caption, modelId, outcome, Date.now());
  } catch { /* best effort, see lookupVisionCaption */ }
}

// Model-visible residue for an image nobody could describe: says what happened and what not to claim.
export const UNCAPTIONED_IMAGE_STUB =
  '[An image attachment arrived here. Your current model cannot view images and no vision '
  + 'description was available, so you have NOT seen it. Say so honestly if it matters to the '
  + 'request; do not claim attachments cannot reach you.]';
