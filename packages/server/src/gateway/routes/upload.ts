import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../../logger.js';

const logger = createLogger('upload');

const UPLOAD_DIR = path.join(os.homedir(), '.dojo', 'uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_TOTAL_SIZE = 20 * 1024 * 1024; // 20MB total per message

// File type categories
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PDF_TYPES = new Set(['application/pdf']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.js', '.ts', '.py', '.html', '.css', '.sh', '.yaml', '.yml', '.toml', '.env', '.tsx', '.jsx', '.sql', '.rs', '.go', '.java', '.rb', '.php', '.swift', '.kt', '.c', '.cpp', '.h']);

export interface UploadedFile {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  category: 'image' | 'pdf' | 'text' | 'office' | 'unknown';
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
  const ext = path.extname(filename).toLowerCase();
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
        return c.json({ ok: false, error: `File "${file.name}" exceeds 10MB limit` }, 400);
      }
      totalSize += file.size;
    }
    if (totalSize > MAX_TOTAL_SIZE) {
      return c.json({ ok: false, error: 'Total file size exceeds 20MB limit' }, 400);
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
  const db = (await import('../../db/connection.js')).getDb();

  const row = db.prepare('SELECT file_path, filename, mime_type FROM shared_files WHERE id = ?').get(fileId) as {
    file_path: string; filename: string; mime_type: string;
  } | undefined;

  if (!row) {
    return c.json({ ok: false, error: 'File not found' }, 404);
  }

  if (!fs.existsSync(row.file_path)) {
    return c.json({ ok: false, error: 'File no longer exists on disk' }, 404);
  }

  const content = await fs.promises.readFile(row.file_path);
  return new Response(content, {
    headers: {
      'Content-Type': row.mime_type,
      'Content-Disposition': `attachment; filename="${row.filename}"`,
      'Cache-Control': 'public, max-age=86400',
    },
  });
});

export { uploadRouter };
