// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 6 T27 — THE VISION GATE'S MEMORY.
//
// THE INCIDENT. `agent/runtime.ts`'s vision gate walks the ASSEMBLED MESSAGE HISTORY on every
// model call and held no memory whatsoever, so ONE image row re-tripped it for ever: re-sent
// to the fallback vision model, re-failed, re-broadcast as an amber `chat:error` toast (11 in
// 15 minutes on the dev body, 2026-08-10, visible in all six round-6 catalogs), and re-followed
// by a spliced "[System: The user just sent N images … Do NOT continue any prior topic, respond
// ONLY about the images they just sent]" — a sentence that is false from the second turn onward
// and that hijacks the topic from the middle of the history.
//
// THE GATE'S DECISION IS ABOUT THE IMAGE, so it is stored against the image. Migration 160's
// header carries the two design answers in full: why the key is the image's own bytes (the gate
// is handed provider-shape content blocks and no message id reaches it) and why a failure is
// stored as a record rather than retried (the thing being bounded is an unbounded REPEAT, not a
// flaky call — so one attempt per image, ever, and a user who wants another re-uploads, which
// the gate's own nudge already tells them).
//
// AND IT IS WHAT MAKES "HISTORICAL" ANSWERABLE WITHOUT TURN IDENTITY. First sighting = the
// image has no row = this is the turn it arrived on the gate's watch, so the toast and the
// nudge are TRUE and fire exactly as they always did. Every later sighting reads the store,
// costs nothing, and says nothing to the user.
// ════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';

/** What the gate stored about one image, or null when it has never seen it. */
export interface VisionCaptionRecord {
  caption: string | null;
  modelId: string | null;
  outcome: 'captioned' | 'failed';
}

/**
 * The image's identity, from the block the provider translator will send.
 *
 * Both shapes this platform emits are covered — `{source:{type:'base64', data}}` and
 * `{source:{type:'url', url}}` — and nothing else is guessed at: a block whose source is
 * neither returns null, and the gate then treats it exactly as it did before this file
 * existed. The URL form is hashed under its own prefix so a URL string can never collide
 * with base64 bytes that happen to spell it.
 */
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

/**
 * What the gate already decided about this image, or null if it has never seen it.
 *
 * BEST-EFFORT BY CONSTRUCTION, both here and in the writer: this store is a memory, not an
 * authority. If it cannot be read the gate degrades to exactly what it did before this file
 * existed — attempt, then strip — which is worse but not broken. A turn must never fail
 * because a bookkeeping table did.
 */
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

/**
 * Record the gate's decision. `INSERT OR IGNORE`, never a replace: the FIRST verdict on an
 * image is the durable one, so two turns racing the same picture cannot flip a stored caption
 * into a failure, and a re-run of the same assembly cannot re-open a decision this file exists
 * to close.
 */
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
  } catch { /* best effort — see lookupVisionCaption */ }
}

/** The durable residue for an image nobody could describe. Model-VISIBLE, and it keeps the
 *  2026-07-18 incident's requirement: a silently removed image left the model inventing false
 *  platform limits ("iMessage attachments don't come through to me"), so the note says what
 *  happened and what not to claim. What it no longer does is shout about it every turn. */
export const UNCAPTIONED_IMAGE_STUB =
  '[An image attachment arrived here. Your current model cannot view images and no vision '
  + 'description was available, so you have NOT seen it. Say so honestly if it matters to the '
  + 'request; do not claim attachments cannot reach you.]';
