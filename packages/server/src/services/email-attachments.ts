// ════════════════════════════════════════
// Email Attachments — shared helpers for Gmail + Outlook send/reply/forward
// ════════════════════════════════════════
//
// Provider-agnostic file-reading, MIME-type detection, and size-partitioning
// for outgoing email attachments. Provider-specific behavior (RFC 2822
// multipart for Gmail, Graph fileAttachment array for Outlook, overflow
// upload to Drive vs. OneDrive) lives in the respective tools-write.ts.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

export interface LocalAttachment {
  /** Absolute path on disk, or '<original-message-attachment>' when re-attached from a forwarded message. */
  path: string;
  /** Filename to present to the recipient. */
  name: string;
  /** Size in bytes. */
  size: number;
  /** Best-guess MIME type. Falls back to application/octet-stream. */
  mimeType: string;
  /** File contents as a Buffer. */
  content: Buffer;
}

// Common MIME types. Anything not listed falls back to application/octet-stream,
// which is safe — recipients' mail clients will sniff the extension.
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ics': 'text/calendar',
  '.eml': 'message/rfc822',
};

export function guessMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * Read the given absolute paths into LocalAttachment records. Fail-fast on
 * any missing/unreadable file — partial sends are worse than no send.
 */
export function readLocalAttachments(
  paths: readonly string[],
): { ok: true; attachments: LocalAttachment[] } | { ok: false; error: string } {
  const attachments: LocalAttachment[] = [];
  for (const p of paths) {
    if (!p || typeof p !== 'string') {
      return { ok: false, error: `Error: attachment path must be a non-empty string (got ${JSON.stringify(p)}).` };
    }
    if (!p.startsWith('/')) {
      return { ok: false, error: `Error: attachment path must be absolute (got "${p}"). Use the full path, e.g. ~/.dojo/uploads/<your-agent-id>/file.pdf resolved to an absolute /Users/... path.` };
    }
    if (!existsSync(p)) {
      return { ok: false, error: `Error: attachment file not found at "${p}". Verify the path or re-download/re-create the file.` };
    }
    let stat;
    try {
      stat = statSync(p);
    } catch (err) {
      return { ok: false, error: `Error: cannot stat attachment "${p}": ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!stat.isFile()) {
      return { ok: false, error: `Error: attachment "${p}" is not a regular file (is it a directory?).` };
    }
    let content: Buffer;
    try {
      content = readFileSync(p);
    } catch (err) {
      return { ok: false, error: `Error: cannot read attachment "${p}": ${err instanceof Error ? err.message : String(err)}` };
    }
    const name = basename(p);
    attachments.push({
      path: p,
      name,
      size: stat.size,
      mimeType: guessMimeType(name),
      content,
    });
  }
  return { ok: true, attachments };
}

/**
 * Gmail: 25MB total combined inline cap. Pack as many files as possible
 * inline (smallest-first to maximize count). Anything that doesn't fit
 * spills to overflow for Drive upload.
 */
export function partitionForGmail(
  attachments: readonly LocalAttachment[],
): { inline: LocalAttachment[]; overflow: LocalAttachment[] } {
  const MAX_TOTAL = 25 * 1024 * 1024;
  const inline: LocalAttachment[] = [];
  const overflow: LocalAttachment[] = [];

  // Files larger than the cap can never go inline — spill immediately.
  const eligible: LocalAttachment[] = [];
  for (const att of attachments) {
    if (att.size > MAX_TOTAL) overflow.push(att);
    else eligible.push(att);
  }

  // Pack smallest-first to maximize the number of files inline.
  const sorted = [...eligible].sort((a, b) => a.size - b.size);
  let used = 0;
  for (const att of sorted) {
    if (used + att.size <= MAX_TOTAL) {
      inline.push(att);
      used += att.size;
    } else {
      overflow.push(att);
    }
  }
  return { inline, overflow };
}

/**
 * Microsoft: per-file 3MB threshold (Graph's `attachments` array is fine up
 * to ~4MB per file but the project policy is 3MB; above that we upload to
 * OneDrive and send a link).
 */
export function partitionForOutlook(
  attachments: readonly LocalAttachment[],
): { inline: LocalAttachment[]; overflow: LocalAttachment[] } {
  const MAX_PER_FILE = 3 * 1024 * 1024;
  const inline: LocalAttachment[] = [];
  const overflow: LocalAttachment[] = [];
  for (const att of attachments) {
    if (att.size > MAX_PER_FILE) overflow.push(att);
    else inline.push(att);
  }
  return { inline, overflow };
}

/** Human-readable size, e.g. "4.2MB" or "812KB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / 1024 / 1024 * 10) / 10}MB`;
}

/** "YYYY-MM" for the current month, used as the attachments-folder name. */
export function currentMonthFolderName(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export const ATTACHMENTS_ROOT_FOLDER = 'DOJO Email Attachments';
