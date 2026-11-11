// Input rectification: engine-side fixers for known bad inputs. Each rectifier inspects one
// input before the model sees it, and its agentNote arrives as `[System: ...]`.

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

/** kept=false: drop the attachment from the model's input and surface the agentNote so
 *  the agent can tell the user; kept=true: the rectified bytes replace the original. */
export interface RectificationResult {
  kept: boolean;
  mediaType?: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  /** Base64 bytes ready for the content block. Null when kept=false. */
  data?: Buffer;
  agentNote?: string;
  /** True iff this rectification ran fresh THIS turn; it drives the one-shot user note. */
  freshlyApplied: boolean;
}

export type Rectifier = (att: AttachmentInput) => RectificationResult | null;


// Prep failure returns null so raw bytes go through; recovery.ts handles the rejection.
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

// Registry: tried in order, first non-null wins; more-specific rectifiers go earlier.
const RECTIFIERS: Rectifier[] = [
  imageDownscaleRectifier,
];

export function rectifyAttachment(att: AttachmentInput): RectificationResult | null {
  for (const fn of RECTIFIERS) {
    const result = fn(att);
    if (result) return result;
  }
  return null;
}

export function registerRectifier(fn: Rectifier): () => void {
  RECTIFIERS.unshift(fn); // new rectifiers take precedence (specific before generic)
  return () => {
    const idx = RECTIFIERS.indexOf(fn);
    if (idx >= 0) RECTIFIERS.splice(idx, 1);
  };
}
