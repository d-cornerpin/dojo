import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../../logger.js';
import { inlineHtmlAssets } from '../../services/canvas-html.js';
import { renderOfficeToHtml, isOfficeRenderable } from '../../services/office-render.js';

const logger = createLogger('upload');

const UPLOAD_DIR = path.join(os.homedir(), '.dojo', 'uploads');
// 1 GB per file / 2 GB per message. Single-user local install — caps are
// to catch obviously-wrong inputs, not to defend against abuse. Memory
// note: Hono's formData() parser buffers the whole body in memory before
// our handler runs, so a 1 GB upload over the localhost path stages 1 GB
// of RAM. For tunnel uploads, use the chunked endpoints below to stay
// under Cloudflare's per-request 100 MB body limit.
const MAX_FILE_SIZE = 1024 * 1024 * 1024;       // 1 GB
const MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024;  // 2 GB
// Chunked upload knobs. Cloudflare's free / Pro plans reject HTTP request
// bodies over 100 MB, so the dashboard splits anything bigger than this
// threshold into chunks and assembles them server-side. Picked 25 MB to
// give ~75 MB of headroom under Cloudflare's cap (multipart envelope +
// other request overhead) and to keep the per-chunk memory footprint low.
const CHUNK_THRESHOLD_BYTES = 25 * 1024 * 1024;
const CHUNK_SESSION_IDLE_MS = 60 * 60 * 1000;   // sessions auto-expire after 1h idle

// File type categories
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PDF_TYPES = new Set(['application/pdf']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.webm']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.js', '.ts', '.py', '.html', '.css', '.sh', '.yaml', '.yml', '.toml', '.env', '.tsx', '.jsx', '.sql', '.rs', '.go', '.java', '.rb', '.php', '.swift', '.kt', '.c', '.cpp', '.h']);

export interface UploadedFile {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  category: 'image' | 'pdf' | 'text' | 'office' | 'audio' | 'video' | 'unknown';
}

function ensureUploadDir(agentId: string): string {
  const dir = path.join(UPLOAD_DIR, agentId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getFileCategory(mimeType: string, filename: string): UploadedFile['category'] {
  if (IMAGE_TYPES.has(mimeType)) return 'image';
  if (PDF_TYPES.has(mimeType)) return 'pdf';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  const ext = path.extname(filename).toLowerCase();
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (['.doc', '.docx', '.xls', '.xlsx', '.pptx'].includes(ext)) return 'office';
  // Fallback: check if mime suggests text
  if (mimeType.startsWith('text/')) return 'text';
  return 'unknown';
}

const uploadRouter = new Hono();

// POST /upload/:agentId — upload files for a chat message
uploadRouter.post('/:agentId', async (c) => {
  const agentId = c.req.param('agentId');

  try {
    const formData = await c.req.formData();
    const files = formData.getAll('files') as File[];

    if (!files || files.length === 0) {
      return c.json({ ok: false, error: 'No files provided' }, 400);
    }

    // Check total size
    let totalSize = 0;
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        return c.json({ ok: false, error: `File "${file.name}" exceeds the ${MAX_FILE_SIZE / (1024 * 1024 * 1024)}GB single-file limit. For uploads through the tunnel, use the chunked upload path instead.` }, 400);
      }
      totalSize += file.size;
    }
    if (totalSize > MAX_TOTAL_SIZE) {
      return c.json({ ok: false, error: `Total upload size exceeds ${MAX_TOTAL_SIZE / (1024 * 1024 * 1024)}GB per message.` }, 400);
    }

    const dir = ensureUploadDir(agentId);
    const uploaded: UploadedFile[] = [];

    for (const file of files) {
      const fileId = uuidv4();
      const timestamp = Date.now();
      const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storedName = `${timestamp}_${safeFilename}`;
      const filePath = path.join(dir, storedName);

      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.promises.writeFile(filePath, buffer);

      const mimeType = file.type || 'application/octet-stream';
      const category = getFileCategory(mimeType, file.name);

      uploaded.push({
        fileId,
        filename: file.name,
        mimeType,
        size: file.size,
        path: filePath,
        category,
      });

      logger.info('File uploaded', { agentId, fileId, filename: file.name, size: file.size, category });
    }

    return c.json({ ok: true, data: uploaded });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Upload failed', { agentId, error: msg });
    return c.json({ ok: false, error: `Upload failed: ${msg}` }, 500);
  }
});

// ── Chunked upload (for files larger than ~100MB, mainly through the
// Cloudflare tunnel which rejects single requests larger than that) ──
//
// Flow:
//   1. POST /upload/start/:agentId  →  body { filename, mimeType, size }
//      Server allocates a session, returns { uploadId }.
//   2. POST /upload/chunk/:agentId/:uploadId/:chunkIndex
//      Server appends the chunk bytes to the session's `.part` file.
//      Chunks must arrive in order — client sends them sequentially.
//   3. POST /upload/finish/:agentId/:uploadId
//      Server validates the assembled file matches the declared size,
//      renames `.part` → final stored name, registers the attachment,
//      and returns the same UploadedFile shape as the one-shot endpoint.
//
// Memory footprint: one chunk at a time per session, capped by the
// CHUNK_THRESHOLD_BYTES the dashboard sends. The .part file lives on
// disk; only the active chunk is buffered.
//
// Session expiry: idle sessions are dropped after 1h. If the dashboard
// disconnects mid-upload, the `.part` file is cleaned up by the same
// older-than-7-days sweep that cleans up regular uploads — no
// dedicated GC pass for chunked sessions.
interface ChunkSession {
  agentId: string;
  filename: string;
  mimeType: string;
  declaredSize: number;
  partPath: string;
  bytesWritten: number;
  expectedNextChunk: number; // sequential index, 0-based
  createdAt: number;
  lastActivityAt: number;
}

const chunkSessions = new Map<string, ChunkSession>();

function reapStaleChunkSessions(): void {
  const now = Date.now();
  for (const [id, session] of chunkSessions) {
    if (now - session.lastActivityAt > CHUNK_SESSION_IDLE_MS) {
      try { if (fs.existsSync(session.partPath)) fs.unlinkSync(session.partPath); } catch { /* ignore */ }
      chunkSessions.delete(id);
      logger.info('Chunk session expired', { uploadId: id, agentId: session.agentId });
    }
  }
}

// POST /upload/start/:agentId — register a chunked upload session.
uploadRouter.post('/start/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const body = await c.req.json().catch(() => null) as
    | { filename?: string; mimeType?: string; size?: number }
    | null;
  if (!body?.filename || typeof body.size !== 'number') {
    return c.json({ ok: false, error: 'filename and size are required' }, 400);
  }
  if (body.size > MAX_FILE_SIZE) {
    return c.json({ ok: false, error: `File exceeds ${MAX_FILE_SIZE / (1024 * 1024 * 1024)}GB limit.` }, 400);
  }

  reapStaleChunkSessions();

  const uploadId = uuidv4();
  const dir = ensureUploadDir(agentId);
  const safeFilename = body.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const partPath = path.join(dir, `${Date.now()}_${safeFilename}.part`);

  // Open and immediately close so the file exists on disk for appends.
  fs.writeFileSync(partPath, '');

  chunkSessions.set(uploadId, {
    agentId,
    filename: body.filename,
    mimeType: body.mimeType || 'application/octet-stream',
    declaredSize: body.size,
    partPath,
    bytesWritten: 0,
    expectedNextChunk: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  });

  logger.info('Chunk session started', { uploadId, agentId, filename: body.filename, size: body.size });
  return c.json({ ok: true, data: { uploadId } });
});

// POST /upload/chunk/:agentId/:uploadId/:chunkIndex — append a chunk.
uploadRouter.post('/chunk/:agentId/:uploadId/:chunkIndex', async (c) => {
  const agentId = c.req.param('agentId');
  const uploadId = c.req.param('uploadId');
  const chunkIndex = Number(c.req.param('chunkIndex'));

  const session = chunkSessions.get(uploadId);
  if (!session || session.agentId !== agentId) {
    return c.json({ ok: false, error: 'Unknown or mismatched uploadId' }, 404);
  }
  if (chunkIndex !== session.expectedNextChunk) {
    return c.json({
      ok: false,
      error: `Out-of-order chunk: got index ${chunkIndex}, expected ${session.expectedNextChunk}`,
    }, 409);
  }

  try {
    const formData = await c.req.formData();
    const chunk = formData.get('chunk') as File | null;
    if (!chunk) {
      return c.json({ ok: false, error: 'chunk field required (multipart File)' }, 400);
    }
    const bytes = Buffer.from(await chunk.arrayBuffer());
    if (session.bytesWritten + bytes.length > session.declaredSize) {
      return c.json({
        ok: false,
        error: `Chunk would overshoot declared size (declared ${session.declaredSize}, would write ${session.bytesWritten + bytes.length}).`,
      }, 400);
    }

    await fs.promises.appendFile(session.partPath, bytes);
    session.bytesWritten += bytes.length;
    session.expectedNextChunk++;
    session.lastActivityAt = Date.now();

    return c.json({
      ok: true,
      data: {
        bytesWritten: session.bytesWritten,
        nextChunk: session.expectedNextChunk,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Chunk write failed', { uploadId, chunkIndex, error: msg });
    return c.json({ ok: false, error: `Chunk write failed: ${msg}` }, 500);
  }
});

// POST /upload/finish/:agentId/:uploadId — close the session, register attachment.
uploadRouter.post('/finish/:agentId/:uploadId', async (c) => {
  const agentId = c.req.param('agentId');
  const uploadId = c.req.param('uploadId');

  const session = chunkSessions.get(uploadId);
  if (!session || session.agentId !== agentId) {
    return c.json({ ok: false, error: 'Unknown or mismatched uploadId' }, 404);
  }
  if (session.bytesWritten !== session.declaredSize) {
    return c.json({
      ok: false,
      error: `Assembled size ${session.bytesWritten} does not match declared ${session.declaredSize}`,
    }, 400);
  }

  // Rename .part → final stored name. Drops the .part suffix.
  const finalPath = session.partPath.replace(/\.part$/, '');
  try {
    fs.renameSync(session.partPath, finalPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Chunk session rename failed', { uploadId, error: msg });
    return c.json({ ok: false, error: `Failed to finalize upload: ${msg}` }, 500);
  }

  chunkSessions.delete(uploadId);

  const category = getFileCategory(session.mimeType, session.filename);
  const uploaded: UploadedFile = {
    fileId: uuidv4(),
    filename: session.filename,
    mimeType: session.mimeType,
    size: session.declaredSize,
    path: finalPath,
    category,
  };

  logger.info('Chunked upload finished', {
    uploadId, agentId, filename: session.filename, size: session.declaredSize, category,
  });
  return c.json({ ok: true, data: uploaded });
});

// Cleanup job: delete uploads older than 7 days
export function cleanupOldUploads(): void {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const agentDirs = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });

    for (const agentDir of agentDirs) {
      if (!agentDir.isDirectory()) continue;
      const dirPath = path.join(UPLOAD_DIR, agentDir.name);
      const files = fs.readdirSync(dirPath);

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
          }
        } catch { /* skip */ }
      }

      // Remove empty directories
      try {
        const remaining = fs.readdirSync(dirPath);
        if (remaining.length === 0) {
          fs.rmdirSync(dirPath);
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    logger.error('Upload cleanup failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// GET /file/:agentId/:filename — serve uploaded files (for image preview)
uploadRouter.get('/file/:agentId/:filename', async (c) => {
  const agentId = c.req.param('agentId');
  const filename = c.req.param('filename');
  const filePath = path.join(UPLOAD_DIR, agentId, filename);

  if (!fs.existsSync(filePath)) {
    return c.json({ ok: false, error: 'File not found' }, 404);
  }

  const content = await fs.promises.readFile(filePath);
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
    '.txt': 'text/plain', '.json': 'application/json',
  };

  return new Response(content, {
    headers: {
      'Content-Type': mimeMap[ext] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
    },
  });
});

// GET /download/:fileId — serve any shared file by ID (works through tunnel)
uploadRouter.get('/download/:fileId', async (c) => {
  const fileId = c.req.param('fileId');
  let db;
  try {
    db = (await import('../../db/connection.js')).getDb();
  } catch {
    return c.json({ ok: false, error: 'Database not available' }, 500);
  }

  // Check if the shared_files table exists
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shared_files'").get();
  if (!tableExists) {
    return c.json({ ok: false, error: 'File sharing not available — server needs to be restarted to run migrations' }, 500);
  }

  const row = db.prepare('SELECT file_path, filename, mime_type FROM shared_files WHERE id = ?').get(fileId) as {
    file_path: string; filename: string; mime_type: string;
  } | undefined;

  if (!row) {
    // Check how many entries exist for debugging
    const count = (db.prepare('SELECT COUNT(*) as c FROM shared_files').get() as { c: number }).c;
    return c.json({ ok: false, error: `File ID not found in registry (${count} files registered). The link may have expired or the server was restarted before the migration ran.` }, 404);
  }

  if (!fs.existsSync(row.file_path)) {
    return c.json({ ok: false, error: `File was registered but no longer exists on disk.` /* audit 26: do not leak the absolute file_path to the client */ }, 404);
  }

  // `?inline=1` serves the file for in-page rendering (Content-Disposition:
  // inline) instead of forcing a download. The right-dock canvas uses this so
  // an HTML file written by file_write renders in the iframe rather than
  // dropping into the browser's download queue. Default stays attachment so
  // existing "download this file" links are unchanged.
  const inline = c.req.query('inline') === '1' || c.req.query('disposition') === 'inline';
  const ext = path.extname(row.filename).toLowerCase();
  const isHtml = ext === '.html' || ext === '.htm' || row.mime_type === 'text/html';

  let content: Buffer;
  let contentType = row.mime_type;
  if (inline && isHtml) {
    // Inline the HTML's local sibling assets (relative <img>/<link>/url() refs)
    // as data URIs so they render in the canvas iframe, which otherwise can't
    // resolve filesystem-relative paths and 404s every local asset.
    content = Buffer.from(inlineHtmlAssets(row.file_path), 'utf-8');
    contentType = 'text/html; charset=utf-8';
  } else {
    content = await fs.promises.readFile(row.file_path);
  }

  return new Response(content, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${row.filename}"`,
      'Cache-Control': inline && isHtml ? 'no-store' : 'public, max-age=86400',
    },
  });
});

// GET /render/:fileId — render a Word/Excel file to HTML for the canvas iframe.
// Office docs are binary OOXML the browser can't display, so we convert them
// server-side (mammoth for .docx, SheetJS for spreadsheets) and serve the HTML.
uploadRouter.get('/render/:fileId', async (c) => {
  const fileId = c.req.param('fileId');
  let db;
  try {
    db = (await import('../../db/connection.js')).getDb();
  } catch {
    return c.json({ ok: false, error: 'Database not available' }, 500);
  }
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shared_files'").get();
  if (!tableExists) return c.json({ ok: false, error: 'File sharing not available' }, 500);

  const row = db.prepare('SELECT file_path, filename FROM shared_files WHERE id = ?').get(fileId) as {
    file_path: string; filename: string;
  } | undefined;
  if (!row) return c.json({ ok: false, error: 'File not found' }, 404);
  if (!fs.existsSync(row.file_path)) return c.json({ ok: false, error: 'File no longer exists on disk' }, 404);

  const html = await renderOfficeToHtml(row.file_path);
  if (html == null) {
    return c.json({ ok: false, error: 'This file type cannot be previewed in the canvas.' }, 415);
  }
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
});

// GET /describe/:fileId — metadata for a shared file, for the right-dock canvas.
// Authed (returns the on-disk path + text content), unlike /download which is
// public-by-unguessable-id. Returns the inline + download URLs, the file's
// type, and — for text-like files under a size cap — the current text content
// (read fresh from disk) so the canvas can render Markdown/text/code itself.
const CANVAS_TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.text', '.json', '.csv', '.tsv', '.log',
  '.xml', '.yaml', '.yml', '.html', '.htm', '.css', '.js', '.ts', '.jsx',
  '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.sh',
  '.sql', '.toml', '.ini', '.env', '.svg',
]);
const CANVAS_TEXT_MAX_BYTES = 512 * 1024; // 512 KB — larger files render via iframe

uploadRouter.get('/describe/:fileId', async (c) => {
  const fileId = c.req.param('fileId');
  let db;
  try {
    db = (await import('../../db/connection.js')).getDb();
  } catch {
    return c.json({ ok: false, error: 'Database not available' }, 500);
  }

  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shared_files'").get();
  if (!tableExists) {
    return c.json({ ok: false, error: 'File sharing not available' }, 500);
  }

  const row = db.prepare('SELECT file_path, filename, mime_type FROM shared_files WHERE id = ?').get(fileId) as {
    file_path: string; filename: string; mime_type: string;
  } | undefined;
  if (!row) return c.json({ ok: false, error: 'File not found' }, 404);
  if (!fs.existsSync(row.file_path)) {
    return c.json({ ok: false, error: 'File no longer exists on disk' }, 404);
  }

  const ext = path.extname(row.filename).toLowerCase();
  const stat = await fs.promises.stat(row.file_path);
  const isText = CANVAS_TEXT_EXTS.has(ext) || row.mime_type.startsWith('text/');
  let text: string | undefined;
  if (isText && stat.size <= CANVAS_TEXT_MAX_BYTES) {
    try {
      text = await fs.promises.readFile(row.file_path, 'utf-8');
    } catch { /* leave undefined — frontend falls back to the inline URL */ }
  }

  return c.json({
    ok: true,
    data: {
      fileId,
      filename: row.filename,
      mime: row.mime_type,
      ext,
      size: stat.size,
      path: row.file_path,
      text,
      // Relative URLs — the dashboard resolves them against its own origin.
      inlineUrl: `/api/upload/download/${fileId}?inline=1`,
      downloadUrl: `/api/upload/download/${fileId}`,
      // Word/Excel render to HTML via /render; null for everything else.
      renderUrl: isOfficeRenderable(ext) ? `/api/upload/render/${fileId}` : null,
    },
  });
});

export { uploadRouter };
