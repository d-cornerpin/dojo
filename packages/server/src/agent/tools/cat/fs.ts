// Files, the scratchpad and the two exec doors (`exec`: argv, no shell;
// `shell`: an audited /bin/zsh script behind its own grant), plus file and
// scratchpad keys. Five things here are load bearing:
// 1. `executeFilePatch` stays EXPORTED, `agent/__tests__/file-patch.test.ts`
//    imports it from HERE.
// 2. The destructive-question authority is ONE function in
//    `brokers/exec-seam.ts`, NOT here.
// 3. `file_write(content:"")` writes an empty file; nothing here re-validates.
// 4. `coerceNumberArg` is arg REPAIR, not validation, and runs INSIDE the
//    handler, after the boundary. Keep that ordering.
// 5. `syncCanvasAfterWrite` lives in `agent/tools/util.ts` so the office block
//    and the pdf interceptor call the SAME copy as this module.

import * as effectFs from '../../effects/fs.js';
import path from 'node:path';
import { getDb } from '../../../db/connection.js';
import { coerceNumberArg } from '../pagination.js';
import { TOOL_RESULT_VIEW_CHARS } from '../../../memory/tool-result-view.js';
import { queueLinkArtifact } from '../../pending-attachments.js';
import { resolvePath } from '../../path-guards.js';
import { resolveArgvArg } from '../../brokers/resolve.js';
import { runProcess, resolveProcessCwd, processTimeout, type ProcessAudit } from '../process-run.js';
import { personFirstFor } from '../person-first.js';
import { auditLog, registerSharedFile, syncCanvasAfterWrite, toolsLogger as logger } from '../util.js';
import { TECHNIQUE_FRESH_SENTINEL } from '@dojo/shared';
import type { ToolHandlerMap } from '../handler.js';
import { outsideSpan } from '../../../tools/external-content.js';

function processAuditFor(agentId: string): ProcessAudit {
  return (target, result, detail) => auditLog(agentId, 'exec', target, result, detail);
}

/**
 * `exec({argv})`: ONE program, literal args, NO shell; authority was already
 * answered at the door (gates.ts, authorizeArgv), this just runs it.
 */
async function executeArgv(agentId: string, args: Record<string, unknown>): Promise<string> {
  const resolved = resolveArgvArg(args.argv);
  if (!resolved.ok) {
    return `Error: ${resolved.reason}. exec takes an argv ARRAY: exec({argv:["ls","-la","/tmp"]}). For pipes, redirection, globbing or loops use the shell tool instead: shell({script:"..."}).`;
  }
  const { cwd, note } = resolveProcessCwd(args.cwd);
  const timeout = processTimeout(args.timeout, agentId);
  logger.info('Executing program', { argv: resolved.value.argv, timeout, cwd }, agentId);
  return runProcess({
    auditTarget: resolved.value.display,
    file: resolved.value.program,
    argv: [...resolved.value.argv.slice(1)],
    timeout, cwd, note,
    audit: processAuditFor(agentId),
    personFirst: personFirstFor(agentId, resolved.value.display),   // "your messages come first" (tools/person-first.ts)
  });
}

/**
 * `shell({script})`: `/bin/zsh -c <script>`, the pipe/loop/redirect door.
 * Semantics match `execFile('/bin/zsh', ['-c', script])` byte for byte; the
 * script arrives as one named argument and the audit row carries it all.
 */
async function executeShellScript(agentId: string, args: Record<string, unknown>): Promise<string> {
  const script = typeof args.script === 'string' ? args.script : '';
  if (script.trim().length === 0) {
    return 'Error: shell requires a non-empty `script` string, e.g. shell({script:"ls -la | wc -l"}).';
  }
  const { cwd, note } = resolveProcessCwd(args.cwd);
  const timeout = processTimeout(args.timeout, agentId);
  // Audit the FULL script text, not a base command; the own door is for this.
  logger.info('Executing shell script', { script, timeout, cwd }, agentId);
  return runProcess({
    auditTarget: script,
    file: '/bin/zsh',
    argv: ['-c', script],
    timeout, cwd, note,
    audit: processAuditFor(agentId),
    personFirst: personFirstFor(agentId, `shell script "${script.length > 200 ? `${script.slice(0, 200)}...` : script}"`),
  });
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const PDF_EXTENSIONS = new Set(['.pdf']);
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};
// Max file size for vision injection (20MB)
const MAX_VISION_FILE_SIZE = 20 * 1024 * 1024;

// A persisted attachment row (messages.attachments JSON array), see
// db/migrations/011_attachments.sql. All fields optional: model/route-fed.
interface StoredAttachment {
  fileId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  path?: string;
}

// Assist for a model-floor miss: with an image attached the model sometimes
// calls file_read on a FABRICATED path, the original name WITHOUT the stored
// timestamp prefix (uploads are <timestamp>_<sanitized>, upload.ts). On a
// name match return the exact stored path already disclosed to the model,
// never content; a corrected retry still runs every permission check.
function findAttachmentByName(agentId: string, requested: string): StoredAttachment | null {
  const wantBase = path.basename(requested).toLowerCase();
  // Mirror the upload sanitizer (gateway/routes/upload.ts:100).
  const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, '_');
  const wantSanitized = sanitize(path.basename(requested)).toLowerCase();

  let rows: Array<{ attachments: string | null }>;
  try {
    rows = getDb().prepare(
      `SELECT attachments FROM messages
       WHERE agent_id = ? AND attachments IS NOT NULL AND attachments != '[]'
       ORDER BY rowid DESC LIMIT 30`,
    ).all(agentId) as Array<{ attachments: string | null }>;
  } catch {
    return null;
  }

  for (const row of rows) {
    if (!row.attachments) continue;
    let list: unknown;
    try {
      list = JSON.parse(row.attachments);
    } catch {
      continue; // skip unparseable rows
    }
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const att = item as StoredAttachment;
      if (typeof att.path !== 'string' || att.path === '') continue;
      const attName = typeof att.filename === 'string' ? att.filename : '';
      const attPathBase = path.basename(att.path);
      const attNameLower = attName.toLowerCase();
      const attPathBaseLower = attPathBase.toLowerCase();
      const matches =
        (attNameLower !== '' && attNameLower === wantBase) ||
        (attPathBaseLower === wantBase) ||
        (attNameLower !== '' && sanitize(attName).toLowerCase() === wantSanitized) ||
        (attPathBaseLower === wantSanitized);
      if (matches) return att;
    }
  }
  return null;
}

// Tail for a file_read miss: the already-disclosed stored path plus the
// timestamp-prefix reminder; images already arrive via vision or caption.
function attachmentPathHint(att: StoredAttachment): string {
  return ` A recent attachment matches this name. Its stored path is: ${att.path}. Attachments are stored with a timestamp prefix; use the exact Path from the attachment pointer. Note: image attachments are already provided to you via vision or caption; re-reading the image file is usually unnecessary.`;
}

async function executeFileRead(
  agentId: string,
  args: Record<string, unknown>,
): Promise<string | { text: string; contentBlocks: Array<{ type: string; [key: string]: unknown }> }> {
  const filePath = resolvePath(args.path as string);

  if (!path.isAbsolute(filePath)) {
    // A non-absolute path is the shape of the fabricated-filename miss, so
    // try the attachment assist before the plain refusal.
    const att = findAttachmentByName(agentId, filePath);
    if (att) {
      auditLog(agentId, 'file_read', filePath, 'error', 'Path must be absolute; attachment-name hint returned');
      return `Error: Path must be absolute. Use ~ for home directory or provide a full path.${attachmentPathHint(att)}`;
    }
    auditLog(agentId, 'file_read', filePath, 'error', 'Path must be absolute (use ~ for home directory)');
    return 'Error: Path must be absolute. Use ~ for home directory or provide a full path.';
  }

  try {
    const stat = await effectFs.promises.stat(filePath).catch(() => null);
    if (!stat) {
      // Assist: the model may have dropped the timestamp prefix off an
      // attachment name; the sensitive-path block ran and a retry re-checks.
      const att = findAttachmentByName(agentId, filePath);
      if (att) {
        auditLog(agentId, 'file_read', filePath, 'error', 'File not found; attachment-name hint returned');
        return `Error: File not found: ${filePath}.${attachmentPathHint(att)}`;
      }
      auditLog(agentId, 'file_read', filePath, 'error', 'File not found');
      return `Error: File not found: ${filePath}`;
    }

    if (stat.isDirectory()) {
      auditLog(agentId, 'file_read', filePath, 'error', 'Path is a directory');
      return 'Error: Path is a directory, use file_list instead';
    }

    const ext = path.extname(filePath).toLowerCase();

    // Image files: return as a vision content block, as with chat attachments.
    if (IMAGE_EXTENSIONS.has(ext)) {
      if (stat.size > MAX_VISION_FILE_SIZE) {
        auditLog(agentId, 'file_read', filePath, 'error', `Image too large: ${stat.size} bytes`);
        return `Error: Image is too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max is 20MB.`;
      }
      const data = await effectFs.promises.readFile(filePath);
      const base64 = data.toString('base64');
      const mediaType = IMAGE_MEDIA_TYPES[ext] ?? 'image/png';

      auditLog(agentId, 'file_read', filePath, 'success', `image ${stat.size} bytes`);

      return {
        text: `Image loaded: ${filePath} (${(stat.size / 1024).toFixed(0)}KB, ${mediaType})`,
        contentBlocks: [
          { type: 'text', text: `Image: ${path.basename(filePath)} (${(stat.size / 1024).toFixed(0)}KB)` },
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        ],
      };
    }

    // ── PDF files: return as document content block ──
    if (PDF_EXTENSIONS.has(ext)) {
      if (stat.size > MAX_VISION_FILE_SIZE) {
        auditLog(agentId, 'file_read', filePath, 'error', `PDF too large: ${stat.size} bytes`);
        return `Error: PDF is too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max is 20MB.`;
      }
      const data = await effectFs.promises.readFile(filePath);
      const base64 = data.toString('base64');

      auditLog(agentId, 'file_read', filePath, 'success', `pdf ${stat.size} bytes`);

      return {
        text: `PDF loaded: ${filePath} (${(stat.size / 1024).toFixed(0)}KB)`,
        contentBlocks: [
          { type: 'text', text: `PDF: ${path.basename(filePath)} (${(stat.size / 1024).toFixed(0)}KB)` },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 }, title: path.basename(filePath) },
        ],
      };
    }

    // ── Text files: return as text ──
    const content = await effectFs.promises.readFile(filePath, 'utf-8');
    const allLines = content.split('\n');
    const totalLines = allLines.length;

    // Pagination returns exactly the requested range with line numbers. coerce is needed
    // because some models emit offset/limit as strings despite the number schema.
    const offsetNum = coerceNumberArg(args.offset);
    const limitNum = coerceNumberArg(args.limit);
    const offset = offsetNum !== null ? Math.max(0, Math.floor(offsetNum)) : null;
    const limit = limitNum !== null ? Math.max(1, Math.floor(limitNum)) : null;

    // Paginated read is the only path, the old raw-string fallback is gone.
    {
      const startLine = offset ?? 0;
      const requestedCount = limit ?? 5000;
      const endLine = Math.min(startLine + requestedCount, totalLines);

      // The page is sized to what the model's VIEW shows of one tool result
      // (`memory/tool-result-view.ts`), gutters and footer included, so the
      // "continue at offset N" footer at its end is always seen.
      // Per-line cap: one huge line (e.g. embedded base64) must not blow the
      // model context through `slice.length > 0`, which always admits row one.
      const MAX_LINE_CHARS = 4_000;
      const truncateLine = (line: string): string =>
        line.length > MAX_LINE_CHARS
          ? `${line.slice(0, MAX_LINE_CHARS)} … [line truncated; original ${line.length} chars, likely contains base64/binary data. Use grep/exec to inspect specific patterns.]`
          : line;
      const lineWidth = String(endLine).length;   // gutter width: the widest line number this page can hold
      // Footer worst-cased up front (page may end at the last line) and reserved from budget.
      // Footer line numbers are the gutter's (1-based inclusive); offset stays lines-to-skip.
      const footerFor = (end: number): string => {
        const remaining = totalLines - end;
        return `\n\n[Read lines ${startLine + 1}-${end} of ${totalLines} total. ${remaining} more lines remain.\n` +
          ` To continue: file_read(path="${filePath}", offset=${end}, limit=${Math.min(remaining, 5000)}).\n` +
          ` To search for specific content: use grep instead.]`;
      };
      const budget = TOOL_RESULT_VIEW_CHARS - footerFor(totalLines).length;
      const slice: string[] = [];
      let chars = 0;
      let actualEnd = startLine;
      for (let i = startLine; i < endLine; i++) {
        const row = `${String(i + 1).padStart(lineWidth)}\t${truncateLine(allLines[i] ?? '')}`;
        if (chars + row.length + 1 > budget && slice.length > 0) break;
        slice.push(row);
        chars += row.length + 1;
        actualEnd = i + 1;
      }

      let result = outsideSpan(slice.join('\n'));   // the file's lines; the footers are the platform's
      if (actualEnd < totalLines) {
        result += footerFor(actualEnd);
      } else if (startLine > 0) {
        result += `\n\n[End of file. Read lines ${startLine + 1}-${actualEnd} of ${totalLines} total.]`;
      }

      auditLog(agentId, 'file_read', filePath, 'success', `${stat.size} bytes (lines ${startLine}-${actualEnd}/${totalLines})`);
      return result;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_read', filePath, 'error', msg);
    return `Error reading file: ${msg}`;
  }
}

// Corrective, NON-crashing guidance for file_write/file_append aimed at a
// DIRECTORY; used by both the up-front check and the catch, no raw EISDIR.
function directoryTargetGuidance(dirPath: string): string {
  const base = dirPath.replace(/[/\\]+$/, '');
  const example = path.join(base, 'brief.md');
  return (
    `That path is a directory, not a file, so nothing was written. ` +
    `Pass a full file path that includes a filename and extension, for example: ${example} ` +
    `(pick a name and extension that fit what you are saving), then call file_write again with that path.`
  );
}

async function executeFileWrite(agentId: string, args: Record<string, unknown>): Promise<string> {
  const filePath = resolvePath(args.path as string);
  const content = args.content as string;

  if (!path.isAbsolute(filePath)) {
    auditLog(agentId, 'file_write', filePath, 'error', 'Path must be absolute (use ~ for home directory)');
    return 'Error: Path must be absolute. Use ~ for home directory or provide a full path.';
  }

  // Directory target: an existing directory, or trailing-separator intent
  // before the folder exists. Guidance, not is_error; never let EISDIR throw.
  const trailingSep = /[/\\]\s*$/.test(String(args.path ?? '')) || /[/\\]$/.test(filePath);
  let existingDir = false;
  try { existingDir = (await effectFs.promises.stat(filePath)).isDirectory(); } catch { /* not present yet */ }
  if (existingDir || trailingSep) {
    auditLog(agentId, 'file_write', filePath, 'error', 'target is a directory, not a file (no filename supplied)');
    return directoryTargetGuidance(filePath);
  }

  try {
    const dir = path.dirname(filePath);
    await effectFs.promises.mkdir(dir, { recursive: true });
    await effectFs.promises.writeFile(filePath, content, 'utf-8');
    auditLog(agentId, 'file_write', filePath, 'success', `${content.length} bytes written`);

    const downloadUrl = registerSharedFile(agentId, filePath);
    // The never-drop-the-link backstop reads artifact rows, not result prose.
    if (downloadUrl) queueLinkArtifact(agentId, downloadUrl, filePath);
    // Auto-open documents (html/markdown/text) in the canvas; refresh if already shown.
    const canvas = syncCanvasAfterWrite(agentId, filePath, downloadUrl);
    const canvasNote = canvas.opened
      ? '\nThis document is now open in the canvas, the user can see it. No need to call canvas_render; just tell them what you did.'
      : '';
    return `File written successfully: ${filePath} (${content.length} bytes)${canvasNote}${downloadUrl ? `\nDownload: ${downloadUrl}\nWhen you give this file to the user (or hand it to another agent), share the Download link above by default; mention the local path only if asked where it is on disk.` : ''}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_write', filePath, 'error', msg);
    // A slipped EISDIR becomes the same guidance, not an is_error crash.
    if ((err as NodeJS.ErrnoException)?.code === 'EISDIR') {
      return directoryTargetGuidance(filePath);
    }
    return `Error writing file: ${msg}`;
  }
}

async function executeFileAppend(agentId: string, args: Record<string, unknown>): Promise<string> {
  const filePath = resolvePath(args.path as string);
  const content = (args.content as string) ?? '';
  const ensureNewline = args.ensure_newline !== false; // default true

  if (!path.isAbsolute(filePath)) {
    auditLog(agentId, 'file_write', filePath, 'error', 'Path must be absolute (use ~ for home directory)');
    return 'Error: Path must be absolute. Use ~ for home directory or provide a full path.';
  }

  // Same directory-target guard as file_write: guidance, not an EISDIR crash.
  const trailingSep = /[/\\]\s*$/.test(String(args.path ?? '')) || /[/\\]$/.test(filePath);
  let existingDir = false;
  try { existingDir = (await effectFs.promises.stat(filePath)).isDirectory(); } catch { /* not present yet */ }
  if (existingDir || trailingSep) {
    auditLog(agentId, 'file_write', filePath, 'error', 'target is a directory, not a file (no filename supplied)');
    return directoryTargetGuidance(filePath);
  }

  try {
    const dir = path.dirname(filePath);
    await effectFs.promises.mkdir(dir, { recursive: true });

    let leading = '';
    if (ensureNewline) {
      // Peek the trailing byte (stat + 1-byte read, cheaper than a full read)
      // to decide whether a separator newline is needed.
      let existingSize = 0;
      try {
        const stat = await effectFs.promises.stat(filePath);
        existingSize = stat.size;
      } catch { /* file doesn't exist, append creates it, no leading newline needed */ }
      if (existingSize > 0) {
        const fh = await effectFs.promises.open(filePath, 'r');
        try {
          const buf = Buffer.alloc(1);
          await fh.read(buf, 0, 1, existingSize - 1);
          if (buf[0] !== 0x0a) leading = '\n'; // not LF, add one
        } finally {
          await fh.close();
        }
      }
    }

    const payload = leading + content;
    await effectFs.promises.appendFile(filePath, payload, 'utf-8');
    const stat = await effectFs.promises.stat(filePath);
    auditLog(agentId, 'file_write', filePath, 'success', `${payload.length} bytes appended (total ${stat.size})`);

    const downloadUrl = registerSharedFile(agentId, filePath);
    if (downloadUrl) queueLinkArtifact(agentId, downloadUrl, filePath);
    // The canvas refreshes or auto-opens after this write too, exactly as after `file_write`:
    // the outcome must not hinge on which write tool the model picked.
    const canvas = syncCanvasAfterWrite(agentId, filePath, downloadUrl);
    const canvasNote = canvas.opened
      ? '\nThis document is now open in the canvas, the user can see it. No need to call canvas_render; just tell them what you did.'
      : '';
    return `Appended ${payload.length} bytes to ${filePath}. Total size: ${stat.size} bytes.${canvasNote}${downloadUrl ? `\nDownload: ${downloadUrl}\nWhen you give this file to the user (or hand it to another agent), share the Download link above by default; mention the local path only if asked where it is on disk.` : ''}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_write', filePath, 'error', msg);
    if ((err as NodeJS.ErrnoException)?.code === 'EISDIR') {
      return directoryTargetGuidance(filePath);
    }
    return `Error appending to file: ${msg}`;
  }
}

// file_patch: the in-place edit is atomic and all or nothing: no write when any search
// string is missing; temp+rename, text only, sensitive paths blocked as in file_read.

interface FilePatch {
  search: string;
  replace: string;
  replace_all?: boolean;
}

export async function executeFilePatch(
  agentId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const filePath = resolvePath(args.path as string);
  const patches = args.patches as FilePatch[];
  const dryRun = args.dry_run === true;

  if (!path.isAbsolute(filePath)) {
    auditLog(agentId, 'file_patch', filePath, 'error', 'Path must be absolute');
    return 'Error: Path must be absolute. Use ~ for home directory or provide a full path.';
  }

  // Validate every patch up front so we fail fast before reading the file.
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    if (!p || typeof p !== 'object') {
      return `Error: patches[${i}] must be an object with { search, replace }.`;
    }
    if (typeof p.search !== 'string' || p.search.length === 0) {
      return `Error: patches[${i}].search must be a non-empty string. An empty search would match everywhere.`;
    }
    if (typeof p.replace !== 'string') {
      return `Error: patches[${i}].replace must be a string (use "" to delete the matched span).`;
    }
  }

  let stat: import('node:fs').Stats;
  try {
    stat = await effectFs.promises.stat(filePath);
  } catch {
    auditLog(agentId, 'file_patch', filePath, 'error', 'File not found');
    return `Error: File not found: ${filePath}. file_patch only edits files that already exist, use file_write to create new ones.`;
  }
  if (stat.isDirectory()) {
    return `Error: ${filePath} is a directory, not a file.`;
  }

  let original: string;
  try {
    const buf = await effectFs.promises.readFile(filePath);
    // Binary detection: NUL bytes mark it; only the first 8KB is sampled so
    // a 20MB file isn't scanned per patch call.
    const sample = buf.subarray(0, Math.min(8192, buf.length));
    if (sample.includes(0)) {
      auditLog(agentId, 'file_patch', filePath, 'error', 'binary file');
      return `Error: ${filePath} appears to be binary (contains null bytes). file_patch only operates on text files.`;
    }
    original = buf.toString('utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_patch', filePath, 'error', `read failed: ${msg}`);
    return `Error reading file: ${msg}`;
  }

  // Apply patches in sequence, tracking counts; if ANY search is missing,
  // abort, never a silent zero-replacement success.
  let working = original;
  const counts: number[] = [];
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    if (!working.includes(p.search)) {
      const preview = p.search.length > 120 ? p.search.slice(0, 120) + '…' : p.search;
      auditLog(agentId, 'file_patch', filePath, 'error', `patch ${i + 1} not found`);
      return (
        `Error: patch ${i + 1} of ${patches.length} did not match. Search string was not found in the file:\n` +
        `  search: ${JSON.stringify(preview)}\n` +
        `No changes have been written. Read the file again to confirm the exact text, whitespace, line endings, and case all matter.`
      );
    }
    if (p.replace_all) {
      // split/join: replaces every occurrence and gives a stable count with
      // no regex-escaping pitfalls.
      const parts = working.split(p.search);
      counts.push(parts.length - 1);
      working = parts.join(p.replace);
    } else {
      const idx = working.indexOf(p.search);
      working = working.slice(0, idx) + p.replace + working.slice(idx + p.search.length);
      counts.push(1);
    }
  }

  const summary = patches
    .map((p, i) => {
      const tag = p.replace_all ? 'replace_all' : 'replace';
      const sPreview = p.search.length > 60 ? p.search.slice(0, 60) + '…' : p.search;
      return `  patch ${i + 1}: ${counts[i]} replacement${counts[i] === 1 ? '' : 's'} (${tag}, search=${JSON.stringify(sPreview)})`;
    })
    .join('\n');

  if (dryRun) {
    const beforeBytes = Buffer.byteLength(original, 'utf-8');
    const afterBytes = Buffer.byteLength(working, 'utf-8');
    auditLog(agentId, 'file_patch', filePath, 'success', `dry_run: ${counts.reduce((a, b) => a + b, 0)} total replacements`);
    return (
      `[Dry run, no changes written.]\n` +
      `${filePath} (${beforeBytes} → ${afterBytes} bytes)\n${summary}`
    );
  }

  // Atomic write (temp sibling, then rename) lives WHOLE in `effects/fs.ts`,
  // same rename and best-effort cleanup, the error rethrown unchanged. The
  // tmp sibling is not a resource this tool NAMES: declaring it would
  // describe the mechanism, not the effect.
  try {
    await effectFs.atomicWriteFile(filePath, working, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_patch', filePath, 'error', `write failed: ${msg}`);
    return `Error writing patched file: ${msg}`;
  }

  const beforeBytes = Buffer.byteLength(original, 'utf-8');
  const afterBytes = Buffer.byteLength(working, 'utf-8');
  const totalReplacements = counts.reduce((a, b) => a + b, 0);
  auditLog(agentId, 'file_patch', filePath, 'success', `${totalReplacements} replacements across ${patches.length} patches`);
  const patchDownloadUrl = registerSharedFile(agentId, filePath);
  // The canvas refreshes or auto-opens after this write too, as after `file_append`.
  const patchCanvas = syncCanvasAfterWrite(agentId, filePath, patchDownloadUrl);
  const patchCanvasNote = patchCanvas.opened
    ? '\nThis document is now open in the canvas, the user can see it. No need to call canvas_render; just tell them what you did.'
    : '';
  return (
    `Patched ${filePath} (${beforeBytes} → ${afterBytes} bytes, ${totalReplacements} total replacements)${patchCanvasNote}\n${summary}`
  );
}

async function executeFileList(agentId: string, args: Record<string, unknown>): Promise<string> {
  const dirPath = resolvePath(args.path as string);

  if (!path.isAbsolute(dirPath)) {
    auditLog(agentId, 'file_read', dirPath, 'error', 'Path must be absolute (use ~ for home directory)');
    return 'Error: Path must be absolute. Use ~ for home directory or provide a full path.';
  }

  try {
    const stat = await effectFs.promises.stat(dirPath).catch(() => null);
    if (!stat) {
      auditLog(agentId, 'file_read', dirPath, 'error', 'Directory not found');
      return `Error: Directory not found: ${dirPath}`;
    }

    if (!stat.isDirectory()) {
      auditLog(agentId, 'file_read', dirPath, 'error', 'Path is not a directory');
      return 'Error: Path is not a directory, use file_read instead';
    }

    const entries = await effectFs.promises.readdir(dirPath, { withFileTypes: true });
    const lines = await Promise.all(entries.map(async entry => {
      const type = entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file';
      try {
        const entryPath = path.join(dirPath, entry.name);
        const entryStat = await effectFs.promises.stat(entryPath);
        const size = entry.isDirectory() ? '-' : formatBytes(entryStat.size);
        return `${type}\t${size}\t${entry.name}`;
      } catch {
        return `${type}\t-\t${entry.name}`;
      }
    }));

    auditLog(agentId, 'file_read', dirPath, 'success', `${entries.length} entries`);
    return `Directory: ${dirPath}\n\n` + lines.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_read', dirPath, 'error', msg);
    return `Error listing directory: ${msg}`;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}



export const fsHandlers: ToolHandlerMap = {
  async "exec"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = await executeArgv(agentId, args);
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "shell"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = await executeShellScript(agentId, args);
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "file_read"({ agentId, args, toolCall }) {
    let content = '';
    let isError = false;
    const fileResult = await executeFileRead(agentId, args);
    if (typeof fileResult === 'string') {
      content = fileResult;
      isError = content.startsWith('Error');
    } else {
      content = fileResult.text;
      // The runtime reads __contentBlocks to build the model's tool_result.
      (toolCall as unknown as Record<string, unknown>).__contentBlocks = fileResult.contentBlocks;
    }
    return { content, isError };
  },

  async "file_write"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = await executeFileWrite(agentId, args);
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "file_append"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = await executeFileAppend(agentId, args);
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "scratchpad_set"({ agentId, args }) {
    let content = '';
    let isError = false;
    const SCRATCHPAD_MAX_CHARS = 8000;
    const newContent = args.content as string;
    if (newContent.length > SCRATCHPAD_MAX_CHARS) {
      content = `Error: scratchpad content is ${newContent.length} chars; cap is ${SCRATCHPAD_MAX_CHARS}. Move detail into a real file and keep the scratchpad as a high-level index.`;
      isError = true;
      return { content, isError };
    }
    // Refuse to stash technique bodies: the scratchpad is re-injected every
    // turn, reintroducing the staleness the freshness enforcement prevents.
    // Storing WHAT THEY DECIDED (parameters, paths, errors hit) is fine.
    if (newContent.includes(TECHNIQUE_FRESH_SENTINEL)) {   // the fresh-read banner string, from @dojo/shared
      content =
        'Refused: scratchpad content contains a technique fresh-read banner, looks like a copy-paste of technique_read / use_technique output. Scratchpad is re-injected on every turn, which would re-introduce the staleness the engine prevents on the tool-result side. Vault decisions ("chose path X for reason Y") or step-state ("step 3: writing yaml") in the scratchpad, re-call technique_read whenever you need the actual technique body.';
      isError = true;
      return { content, isError };
    }
    try {
      const scratchDb = getDb();
      const row = scratchDb.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
      const cfg = row?.config ? JSON.parse(row.config) as Record<string, unknown> : {};
      cfg.scratchpad = newContent;
      scratchDb.prepare("UPDATE agents SET config = ? WHERE id = ?").run(JSON.stringify(cfg), agentId);
      content = `Scratchpad updated (${newContent.length} chars). It will be re-injected at the top of your context on every turn until you clear it or your session resets.`;
    } catch (err) {
      content = `Error setting scratchpad: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    }
    return { content, isError };
  },

  async "scratchpad_clear"({ agentId }) {
    let content = '';
    let isError = false;
    try {
      const scratchDb = getDb();
      const row = scratchDb.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
      const cfg = row?.config ? JSON.parse(row.config) as Record<string, unknown> : {};
      delete cfg.scratchpad;
      scratchDb.prepare("UPDATE agents SET config = ? WHERE id = ?").run(JSON.stringify(cfg), agentId);
      content = 'Scratchpad cleared.';
    } catch (err) {
      content = `Error clearing scratchpad: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    }
    return { content, isError };
  },

  async "file_patch"({ agentId, args }) {
    let content = '';
    let isError = false;
    if (!Array.isArray(args.patches) || args.patches.length === 0) {
      content = 'Error: patches must be a non-empty array of { search, replace } objects.';
      isError = true;
      return { content, isError };
    }
    content = await executeFilePatch(agentId, args);
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "file_list"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = await executeFileList(agentId, args);
    isError = content.startsWith('Error');
    return { content, isError };
  },
};
