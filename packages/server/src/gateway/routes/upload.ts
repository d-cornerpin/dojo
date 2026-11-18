import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../logger.js';
import { inlineHtmlAssets, canvasMayRead, DISPLAY_CSP } from '../../services/canvas-html.js';
import { renderOfficeToHtml, isOfficeRenderable } from '../../services/office-render.js';
import { routeFailure } from './route-failure.js';
import { homeDir } from '../../home.js';
import { insideFolder } from '../../techniques/technique-folder.js';

const logger = createLogger('upload');

const UPLOAD_DIR = path.join(homeDir(), '.dojo', 'uploads');
// 1 GB per file / 2 GB per message. Single-user local install: the caps catch obviously-wrong inputs, not
// abuse. Hono's formData() buffers the whole body in memory before our handler runs (a 1 GB upload stages 1
// GB of RAM); tunnel uploads use the chunked endpoints below to stay under Cloudflare's 100 MB per-request
// body limit.
const MAX_FILE_SIZE = 1024 * 1024 * 1024;       // 1 GB
const MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024;  // 2 GB
const CHUNK_SESSION_IDLE_MS = 60 * 60 * 1000;   // sessions auto-expire after 1h idle

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

/** The agent's upload folder, or null when `agentId` (a URL param) would name a place outside the upload root. */
function agentUploadDir(agentId: string): string | null {
  return insideFolder(UPLOAD_DIR, agentId);
}

function ensureUploadDir(agentId: string): string | null {
  const dir = agentUploadDir(agentId);
  if (dir) fs.mkdirSync(dir, { recursive: true });
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
  if (mimeType.startsWith('text/')) return 'text';
  return 'unknown';
}

const uploadRouter = new Hono();

// POST /upload/:agentId: upload files for a chat message
uploadRouter.post('/:agentId', async (c) => {
  const agentId = c.req.param('agentId');

  try {
    const formData = await c.req.formData();
    const files = formData.getAll('files') as File[];

    if (!files || files.length === 0) {
      return c.json({ ok: false, error: 'No files provided' }, 400);
    }

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
    if (!dir) return c.json({ ok: false, error: 'invalid path' }, 400);
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

// Chunked upload, for files the dashboard splits up (so tunnel requests stay under Cloudflare's 100 MB
// cap). Flow: POST /upload/start/:agentId {filename, mimeType, size} allocates a session and returns
// {uploadId}; POST /upload/chunk/:agentId/:uploadId/:chunkIndex appends the bytes to the session's `.part`
// file (chunks must arrive in order, one at a time); POST /upload/finish/:agentId/:uploadId checks the
// assembled size against the declared one, renames `.part` to the final stored name, registers the
// attachment and returns the same UploadedFile shape as the one-shot endpoint. Idle sessions drop after 1h,
// and a `.part` file left by a disconnect is removed a week later by `removeAbandonedPartFiles`.
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

// POST /upload/start/:agentId: register a chunked upload session.
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
  if (!dir) return c.json({ ok: false, error: 'invalid path' }, 400);
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

// POST /upload/chunk/:agentId/:uploadId/:chunkIndex: append a chunk.
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

// POST /upload/finish/:agentId/:uploadId: close the session, register attachment.
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

/** Removes the `.part` file of a chunked upload left unfinished for over a week; every finished upload is kept. */
export function removeAbandonedPartFiles(): void {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const agentDir of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
      if (!agentDir.isDirectory()) continue;
      const dirPath = path.join(UPLOAD_DIR, agentDir.name);
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.part')) continue;
        const filePath = path.join(dirPath, file);
        try {
          if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
        } catch { /* skip */ }
      }
    }
  } catch (err) {
    logger.error('Removing unfinished uploads failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// GET /file/:agentId/:filename: serve uploaded files (for image preview)
uploadRouter.get('/file/:agentId/:filename', async (c) => {
  const agentId = c.req.param('agentId');
  const filename = c.req.param('filename');
  const agentDir = agentUploadDir(agentId);
  const filePath = agentDir && insideFolder(agentDir, filename);
  if (!filePath) return c.json({ ok: false, error: 'invalid path' }, 400);
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

// SECURITY: the download route is PUBLIC. `/api/upload/download/` sits in ALWAYS_PUBLIC_PREFIXES
// (gateway/middleware/auth.ts): the unguessable UUID is the whole credential, so anyone holding a link
// reaches it with no token, over the tunnel. It serves MODEL-AUTHORED bytes (every file_write/file_append
// registers itself here) from the same origin as the production dashboard, where the session cookie and
// localStorage token live. Rule: a response may render as a document ONLY if its type cannot carry script.
// Everything else is `attachment`, and script-capable document types are also relabelled
// `application/octet-stream` so a sniffing browser has nothing to latch onto; `X-Content-Type-Options:
// nosniff` closes the third door. Still rendered: raster images, PDF, audio, video and plain text (no script
// runs in the server's origin). SVG keeps `image/svg+xml` but is FORCED to `attachment`: its scripts run
// only as a top-level document, never through <img>, and Content-Disposition does not affect subresource
// loads, so the canvas <img src=inlineUrl> shows it and a tab cannot run it. HTML is fetched, not navigated
// to: CanvasView hands the body to a sandboxed srcDoc iframe.

/** Types that can be rendered inline because they cannot execute script in our origin. */
const INLINE_SAFE_MIME = /^(?:image\/(?:png|jpeg|jpg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon|avif)|application\/pdf|audio\/|video\/|text\/plain)(?:$|;)/i;
const INLINE_SAFE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif',
  '.pdf', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac',
  '.mp4', '.mov', '.webm', '.mkv', '.txt', '.log',
]);
/** Types a browser will happily run as a document. Never handed out under their own label. */
const SCRIPTABLE_DOC_MIME = /^(?:text\/html|application\/xhtml\+xml|text\/xml|application\/xml|text\/javascript|application\/(?:x-)?javascript|application\/ecmascript)(?:$|;)/i;
const SCRIPTABLE_DOC_EXT = new Set([
  '.html', '.htm', '.xhtml', '.shtml', '.xml', '.xsl', '.xslt',
  '.js', '.mjs', '.cjs', '.jsx', '.htc',
]);

/**
 * Decide the Content-Type + Content-Disposition for a public download.
 * Exported for the regression suite (__tests__/upload-download-headers.test.ts).
 */
export function safeDownloadHeaders(
  mimeType: string | null | undefined,
  ext: string,
  inlineRequested: boolean,
): { contentType: string; disposition: 'inline' | 'attachment' } {
  const mime = (mimeType ?? '').trim();
  const e = ext.toLowerCase();

  // Script-capable documents lose their label as well as their disposition. SVG is the deliberate exception:
  // it keeps its mime so <img> still renders it, and `attachment` stops a top-level navigation.
  const scriptable = SCRIPTABLE_DOC_MIME.test(mime) || SCRIPTABLE_DOC_EXT.has(e);
  if (scriptable) return { contentType: 'application/octet-stream', disposition: 'attachment' };

  const safeToRender = INLINE_SAFE_MIME.test(mime) || INLINE_SAFE_EXT.has(e);
  return {
    contentType: mime || 'application/octet-stream',
    disposition: inlineRequested && safeToRender ? 'inline' : 'attachment',
  };
}

/** Strip CR/LF/quotes so a filename can never inject a second response header. */
export function sanitizeFilenameForHeader(filename: string): string {
  return filename.replace(/[\r\n"\\]/g, '_');
}

// GET /download/:fileId: serve any shared file by ID (works through tunnel)
uploadRouter.get('/download/:fileId', async (c) => {
  const fileId = c.req.param('fileId');
  let db;
  try {
    db = (await import('../../db/connection.js')).getDb();
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500, message: 'Database not available' });
  }

  const row = db.prepare('SELECT file_path, filename, mime_type FROM shared_files WHERE id = ?').get(fileId) as {
    file_path: string; filename: string; mime_type: string;
  } | undefined;

  if (!row) {
    const count = (db.prepare('SELECT COUNT(*) as c FROM shared_files').get() as { c: number }).c;
    return c.json({ ok: false, error: `File ID not found in registry (${count} files registered). The link may have expired or the server was restarted before the migration ran.` }, 404);
  }

  if (!fs.existsSync(row.file_path)) {
    return c.json({ ok: false, error: `File was registered but no longer exists on disk.` /* never leak the absolute file_path to the client */ }, 404);
  }

  // `?inline=1` asks for in-page rendering (Content-Disposition: inline); the right-dock canvas and the
  // attachment chips use it. The disposition rules below decide which types still get it.
  const inline = c.req.query('inline') === '1';
  const ext = path.extname(row.filename).toLowerCase();
  const isHtml = ext === '.html' || ext === '.htm' || row.mime_type === 'text/html';

  let content: Buffer;
  if (inline && isHtml) {
    // Inline the HTML's local sibling assets (relative <img>/<link>/url() refs) as data URIs: the canvas
    // cannot resolve filesystem-relative paths. The canvas FETCHES this body into a sandboxed srcDoc iframe
    // (CanvasView.tsx) and never navigates to it, so the disposition can stay `attachment`. The plain
    // download URL serves the file as is.
    content = Buffer.from(inlineHtmlAssets(row.file_path), 'utf-8');
  } else {
    content = await fs.promises.readFile(row.file_path);
  }

  const { contentType, disposition } = safeDownloadHeaders(row.mime_type, ext, inline);
  return new Response(content, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `${disposition}; filename="${sanitizeFilenameForHeader(row.filename)}"`,
      // Without this, a browser is free to sniff HTML out of a body we
      // deliberately labelled octet-stream and undo the whole guard.
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': inline && isHtml ? 'no-store' : 'public, max-age=86400',
      ...(isHtml || ext === '.svg' ? { 'Content-Security-Policy': DISPLAY_CSP } : {}),
    },
  });
});

// GET /render/:fileId: render a Word/Excel file to HTML for the canvas iframe.
// Office docs are binary OOXML the browser can't display, so we convert them
// server-side (mammoth for .docx, SheetJS for spreadsheets) and serve the HTML.
uploadRouter.get('/render/:fileId', async (c) => {
  const fileId = c.req.param('fileId');
  let db;
  try {
    db = (await import('../../db/connection.js')).getDb();
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500, message: 'Database not available' });
  }

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
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': DISPLAY_CSP,
    },
  });
});

// GET /describe/:fileId: metadata for a shared file, for the right-dock canvas. Authed (returns the on-disk
// path and text content), unlike /download, which is public by unguessable id. Returns the inline and
// download URLs, the file's type and, for text-like files under a size cap, the current text read fresh from
// disk.
const CANVAS_TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.text', '.json', '.csv', '.tsv', '.log',
  '.xml', '.yaml', '.yml', '.html', '.htm', '.css', '.js', '.ts', '.jsx',
  '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.sh',
  '.sql', '.toml', '.ini', '.env', '.svg',
]);
const CANVAS_TEXT_MAX_BYTES = 512 * 1024; // 512 KB, larger files render via iframe

uploadRouter.get('/describe/:fileId', async (c) => {
  const fileId = c.req.param('fileId');
  let db;
  try {
    db = (await import('../../db/connection.js')).getDb();
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500, message: 'Database not available' });
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
  if (isText && stat.size <= CANVAS_TEXT_MAX_BYTES && canvasMayRead(row.file_path)) {
    try {
      text = await fs.promises.readFile(row.file_path, 'utf-8');
    } catch { /* leave undefined, frontend falls back to the inline URL */ }
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
      // Relative URLs: the dashboard resolves them against its own origin.
      inlineUrl: `/api/upload/download/${fileId}?inline=1`,
      downloadUrl: `/api/upload/download/${fileId}`,
      // Word/Excel render to HTML via /render; null for everything else.
      renderUrl: isOfficeRenderable(ext) ? `/api/upload/render/${fileId}` : null,
    },
  });
});

export { uploadRouter };
