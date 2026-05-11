// ════════════════════════════════════════
// Input Rectification — engine-side fixers for known bad inputs
//
// v2.3.19 (error-handling-spec Phase 4) — generalizes the v2.3.18 image
// work into a registry pattern. Each rectifier inspects a single
// attachment (or other input) and, if it can fix the input before the
// model ever sees it, returns the corrected version + an agent-facing
// note explaining what changed. The agent gets the note as `[System: …]`
// so it can mention it to the user if relevant.
//
// Today the only registered rectifier is the image-downscale flow from
// v2.3.18 (sips → cache → re-encode). Phase 4 just lifts that into the
// framework so future rectifiers (PDF size, HEIC fallback, audio strip,
// etc.) can register without changing call sites.
// ════════════════════════════════════════

import type { PreparedImage } from './image-prep.js';
import { prepareImageForModel, formatBytes } from './image-prep.js';

export interface AttachmentInput {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  category: string;
}

/**
 * Result of rectifying a single attachment. If `kept === false`, the
 * engine should drop the attachment from the model's input entirely and
 * insert the agentNote into the chat-history system note so the agent
 * can apologize to the user. If `kept === true`, the rectified bytes
 * replace the original at injection time.
 *
 * `agentNote`, when set, is also persisted as a one-shot system message
 * (mirroring the v2.3.18 image-resized note).
 */
export interface RectificationResult {
  kept: boolean;
  /** The mediaType to use in the content block. May differ from the
   *  original (e.g. HEIC declared as image/jpeg). */
  mediaType?: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  /** Base64 bytes ready for the content block. Null when kept=false. */
  data?: Buffer;
  /** Plain-language note for the agent's chat history. Used by callers
   *  to surface what the engine did. */
  agentNote?: string;
  /** True iff this rectification ran fresh THIS turn (not a cache hit).
   *  Drives "one-shot" system messages so the user only sees the note
   *  the first time. */
  freshlyApplied: boolean;
}

export type Rectifier = (att: AttachmentInput) => RectificationResult | null;

// ── Built-in rectifiers ─────────────────────────────────────────────

/**
 * Image downscale via sips. Lifted from v2.3.18's prepareImageForModel.
 * Registered for any attachment whose category is 'image'. If the prep
 * step fails (sips missing, file unreadable, etc.) the rectifier
 * returns null and the engine falls back to sending the raw bytes —
 * recovery.ts's image_too_large_post_sips branch catches whatever
 * happens next.
 */
function imageDownscaleRectifier(att: AttachmentInput): RectificationResult | null {
  if (att.category !== 'image') return null;
  const prepared: PreparedImage | null = prepareImageForModel(att.path, att.mimeType);
  if (!prepared) return null;
  return {
    kept: true,
    mediaType: prepared.mediaType,
    data: prepared.data,
    freshlyApplied: prepared.freshlyResized,
    agentNote: prepared.freshlyResized
      ? `Image \`${att.filename}\` was downscaled from ${formatBytes(prepared.originalSize)} to ${formatBytes(prepared.finalSize)} to fit the model's 5 MB per-image limit.`
      : undefined,
  };
}

// Registry. Ordered: more-specific rectifiers should be earlier in the
// list. The engine tries each in order and uses the first non-null result.
const RECTIFIERS: Rectifier[] = [
  imageDownscaleRectifier,
  // Future: pdfTooLargeRectifier, audioStripRectifier, heicFallbackRectifier, ...
];

/**
 * Run an attachment through the rectification registry. Returns the
 * first non-null rectifier result, or null if no rectifier handled it.
 */
export function rectifyAttachment(att: AttachmentInput): RectificationResult | null {
  for (const fn of RECTIFIERS) {
    const result = fn(att);
    if (result) return result;
  }
  return null;
}

/**
 * Register a new rectifier at runtime. Returns an unregister function.
 * Mostly for tests; production code adds rectifiers to the static list.
 */
export function registerRectifier(fn: Rectifier): () => void {
  RECTIFIERS.unshift(fn); // new rectifiers take precedence (specific before generic)
  return () => {
    const idx = RECTIFIERS.indexOf(fn);
    if (idx >= 0) RECTIFIERS.splice(idx, 1);
  };
}
