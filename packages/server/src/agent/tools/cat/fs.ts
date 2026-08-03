// ════════════════════════════════════════════════════════════════════════════
// FILES, THE SCRATCHPAD AND THE TWO EXEC DOORS (PHASE-5 T4 — relocated from
// `agent/tools.ts`)
//
// Nine dispatch keys — `file_read`, `file_write`, `file_append`, `file_patch`,
// `file_list`, `scratchpad_set`, `scratchpad_clear`, and PHASE-5 T3's two exec
// doors `exec` (argv, no shell) and `shell` (an audited script under /bin/zsh
// behind its own grant class) — together with the implementations they call.
// Research 05 §1 calls "File & System" the worst-mixed category in the tree;
// HID, the clock tools and the web verbs already left, and this is what the
// label actually meant.
//
// RELOCATION, NOT REWRITE, and five things here are load bearing:
//
// 1. **`executeFilePatch` stays EXPORTED** — `agent/__tests__/file-patch.test.ts`
//    imported it via a re-export in `agent/tools.ts`; that file is DELETED and
//    the test imports HERE, which exposed the cycle `tools/handlers.ts` records.
// 2. **T3's exec seam is untouched.** `executeArgv` and `executeShellScript`
//    call `runProcess` with an argv and with `/bin/zsh -c <script>`
//    respectively; the approval gate and the dispatcher answer the destructive
//    question from ONE function (`brokers/exec-seam.ts`) which is NOT here, so
//    "the EXACT call executeTool makes" stays a fact rather than a coincidence.
// 3. **`file_write(content:"")` writes an empty file.** T3C's `allowEmpty`
//    declaration exists because a schema-only validator would have refused a
//    call that works today; nothing in these bodies re-validates.
// 4. **`coerceNumberArg` is arg REPAIR, not validation** — `"5"` -> `5` on
//    OPTIONAL fields, message-less, and it runs INSIDE the handler, after the
//    boundary. That ordering is T3C's and it is unchanged.
// 5. **The canvas sync after every write** (`syncCanvasAfterWrite`) is what
//    refreshes a document the user is watching; it lives in
//    `agent/tools/util.ts` so this module, the office block and the pdf
//    interceptor all call the SAME copy.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../../db/connection.js';
import { coerceNumberArg } from '../pagination.js';
import { queueLinkArtifact } from '../../pending-attachments.js';
import { resolvePath, isSensitivePath } from '../../path-guards.js';
import { resolveArgvArg } from '../../brokers/resolve.js';
import { runProcess, resolveProcessCwd, processTimeout, type ProcessAudit } from '../process-run.js';
import { auditLog, registerSharedFile, syncCanvasAfterWrite, toolsLogger as logger } from '../util.js';
import { TECHNIQUE_FRESH_SENTINEL } from '@dojo/shared';
import type { ToolHandlerMap } from '../handler.js';

function processAuditFor(agentId: string): ProcessAudit {
  return (target, result, detail) => auditLog(agentId, 'exec', target, result, detail);
}

/**
 * `exec({argv})` — ONE program, literal arguments, NO shell.
 *
 * The authority question was already answered at the door (`gates.ts` row 3 →
 * `authorizeExecShapedCall` → `authorizeArgv`), including the global denies, the
 * shell-interpreter refusal and the tokenized sensitive-read scan. What is left
 * here is running it, which is the shape a handler should have.
 */
async function executeArgv(agentId: string, args: Record<string, unknown>): Promise<string> {
  const resolved = resolveArgvArg(args.argv);
  if (!resolved.ok) {
    return `Error: ${resolved.reason}. exec takes an argv ARRAY: exec({argv:["ls","-la","/tmp"]}). For pipes, redirection, globbing or loops use the shell tool instead: shell({script:"..."}).`;
  }
  const { cwd, note } = resolveProcessCwd(args.cwd);
  const timeout = processTimeout(args.timeout);
  logger.info('Executing program', { argv: resolved.value.argv, timeout, cwd }, agentId);
  return runProcess({
    auditTarget: resolved.value.display,
    file: resolved.value.program,
    argv: [...resolved.value.argv.slice(1)],
    timeout, cwd, note,
    audit: processAuditFor(agentId),
  });
}

/**
 * `shell({script})` — `/bin/zsh -c <script>`, the pipe/loop/redirect door.
 *
 * `execFile('/bin/zsh', ['-c', script])` is what `execAsync(cmd,{shell:'/bin/zsh'})`
 * did internally, so the SEMANTICS an agent depends on are unchanged to the byte.
 * The difference is that the script arrives as one named argument at a door whose
 * grant is named `shell`, and the audit row carries the whole of it.
 */
async function executeShellScript(agentId: string, args: Record<string, unknown>): Promise<string> {
  const script = typeof args.script === 'string' ? args.script : '';
  if (script.trim().length === 0) {
    return 'Error: shell requires a non-empty `script` string, e.g. shell({script:"ls -la | wc -l"}).';
  }
  const { cwd, note } = resolveProcessCwd(args.cwd);
  const timeout = processTimeout(args.timeout);
  // The FULL script text, not a base command — auditing what the shell was
  // actually handed is the point of giving it its own door.
  logger.info('Executing shell script', { script, timeout, cwd }, agentId);
  return runProcess({
    auditTarget: script,
    file: '/bin/zsh',
    argv: ['-c', script],
    timeout, cwd, note,
    audit: processAuditFor(agentId),
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

// Shape of a persisted attachment row (messages.attachments JSON array).
// See db/migrations/011_attachments.sql. All fields optional here because the
// column is model/route-fed and we parse it defensively.
interface StoredAttachment {
  fileId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  path?: string;
}

// FN-5 assist for a known model-floor miss. With an image attached, the
// correctness-floor model sometimes calls file_read on a FABRICATED path, the
// original filename WITHOUT the stored timestamp prefix, and hits a dead-end
// "File not found". This looks back over the agent's recent attachments and,
// on a name match, hands back the exact stored Path so the retry can correct
// itself. It returns ONLY a path string that was already disclosed to the
// model in the attachment pointer (chat.ts), never file content; a retry with
// the corrected path still runs every permission check (absolute-path,
// sensitive-path block, etc.). Uploads are stored as
// <timestamp>_<sanitizedOriginalName> (gateway/routes/upload.ts).
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

// Tail appended to a file_read miss when findAttachmentByName hits. Carries the
// already-disclosed stored Path plus the timestamp-prefix reminder; the vision
// note discourages redundant re-reads of image attachments already provided
// via vision or caption.
function attachmentPathHint(att: StoredAttachment): string {
  return ` A recent attachment matches this name. Its stored path is: ${att.path}. Attachments are stored with a timestamp prefix; use the exact Path from the attachment pointer. Note: image attachments are already provided to you via vision or caption; re-reading the image file is usually unnecessary.`;
}

async function executeFileRead(
  agentId: string,
  args: Record<string, unknown>,
): Promise<string | { text: string; contentBlocks: Array<{ type: string; [key: string]: unknown }> }> {
  const filePath = resolvePath(args.path as string);

  if (!path.isAbsolute(filePath)) {
    // The absolute-path requirement stays. But a non-absolute path is exactly
    // the shape of the fabricated-filename miss (bare original name, no stored
    // prefix), so try the attachment assist before the plain refusal.
    const att = findAttachmentByName(agentId, filePath);
    if (att) {
      auditLog(agentId, 'file_read', filePath, 'error', 'Path must be absolute; attachment-name hint returned');
      return `Error: Path must be absolute. Use ~ for home directory or provide a full path.${attachmentPathHint(att)}`;
    }
    auditLog(agentId, 'file_read', filePath, 'error', 'Path must be absolute (use ~ for home directory)');
    return 'Error: Path must be absolute. Use ~ for home directory or provide a full path.';
  }

  // Block reads of secrets / SSH keys / cloud credentials. See isSensitivePath
  // up top for the full list. The result must never enter messages, the
  // CLAUDE.md secrets-out-of-memory rule applies at every entry point.
  if (isSensitivePath(filePath)) {
    auditLog(agentId, 'file_read', filePath, 'denied', 'sensitive path block list');
    return `[BLOCKED] file_read refused: ${filePath} is on the sensitive-files block list (secrets.yaml, .env files, SSH keys, cloud credentials). The DOJO never echoes secret files into the conversation. If you need a value from this file, ask the user, those values live in process memory only.`;
  }

  try {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat) {
      // Self-correcting assist: the model may have dropped the stored timestamp
      // prefix off an attachment name. Hand back the exact stored Path if a
      // recent attachment matches (the sensitive-path block above already ran;
      // a retry with the corrected path re-runs every check).
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

    // ── Image files: return as vision content block ──
    // The model sees the actual image via its vision capabilities,
    // same as when a user attaches an image to a chat message.
    if (IMAGE_EXTENSIONS.has(ext)) {
      if (stat.size > MAX_VISION_FILE_SIZE) {
        auditLog(agentId, 'file_read', filePath, 'error', `Image too large: ${stat.size} bytes`);
        return `Error: Image is too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max is 20MB.`;
      }
      const data = await fs.promises.readFile(filePath);
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
      const data = await fs.promises.readFile(filePath);
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
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const allLines = content.split('\n');
    const totalLines = allLines.length;

    // Phase 3.5 offset/limit support, when an agent explicitly paginates,
    // we return exactly the requested range with line numbers and a stub
    // telling them how to read more. This is also the path that bypasses
    // the v1 large-files interception (so an agent can ALWAYS get raw
    // content of a large file by paginating, even on v1).
    // Phase 3.5 fix, defensive coerce. DeepSeek emits these as strings even
    // when schema says number; without coerce pagination silently no-ops.
    const offsetNum = coerceNumberArg(args.offset);
    const limitNum = coerceNumberArg(args.limit);
    const offset = offsetNum !== null ? Math.max(0, Math.floor(offsetNum)) : null;
    const limit = limitNum !== null ? Math.max(1, Math.floor(limitNum)) : null;

    // Pagination path with line numbers + clear stub on truncation. The v1
    // raw-string fallback (with large-files.ts interception) was removed in
    // Phase 9 Stage 2, paginated read is now the only path.
    {
      const startLine = offset ?? 0;
      // v2.7.2, default line count bumped 2000 → 5000 to match the
      // expanded cap below. Most documents the agent reads (briefs,
      // transcripts, code files) fit in a single call now.
      const requestedCount = limit ?? 5000;
      const endLine = Math.min(startLine + requestedCount, totalLines);

      // v2.7.2, cap raised from 30_000 chars (~7.5K tokens) to 240_000
      // (~60K tokens). The old cap was 5-7% of a typical model's context
      // window, so agents kept truncating mid-document, restarting the
      // task, and giving up. Modern model contexts are 128K-200K+; a
      // ~60K cap lets a 120-page document land in one call. The friendly
      // pagination trailer still fires when the file is bigger than the
      // cap, and the per-tool maxResultTokens (also 60000) keeps any
      // edge cases from blowing the runtime cap. Leaves headroom for
      // the trailer text itself.
      const MAX_CHARS = 240_000;
      // Per-line cap: protects against files where a single line is huge, 
      // e.g. an HTML file with embedded `<img src="data:image/png;base64,...">`.
      // Without this, the whole-file cap below was bypassed via the
      // `slice.length > 0` clause (we always included the first line, no
      // matter how big), and a 5.9MB single-line file blew the entire model
      // context window.
      const MAX_LINE_CHARS = 4_000;
      const truncateLine = (line: string): string =>
        line.length > MAX_LINE_CHARS
          ? `${line.slice(0, MAX_LINE_CHARS)} … [line truncated; original ${line.length} chars, likely contains base64/binary data. Use grep/exec to inspect specific patterns.]`
          : line;
      const slice: string[] = [];
      let chars = 0;
      let actualEnd = startLine;
      for (let i = startLine; i < endLine; i++) {
        const line = truncateLine(allLines[i] ?? '');
        if (chars + line.length + 1 > MAX_CHARS && slice.length > 0) break;
        slice.push(`${i + 1}\t${line}`);
        chars += line.length + 1;
        actualEnd = i + 1;
      }

      const linesShown = actualEnd - startLine;
      const lineWidth = String(actualEnd).length;
      // Re-format with right-aligned line numbers like Read tool does
      const formatted = slice
        .map((s) => {
          const [num, ...rest] = s.split('\t');
          return `${num.padStart(lineWidth)}\t${rest.join('\t')}`;
        })
        .join('\n');

      let result = formatted;
      if (actualEnd < totalLines) {
        const remaining = totalLines - actualEnd;
        result += `\n\n[Read lines ${startLine}-${actualEnd - 1} of ${totalLines} total. ${remaining} more lines remain.\n` +
          ` To continue: file_read(path="${filePath}", offset=${actualEnd}, limit=${Math.min(remaining, 5000)}).\n` +
          ` To search for specific content: use grep instead.]`;
      } else if (startLine > 0) {
        result += `\n\n[End of file. Read lines ${startLine}-${actualEnd - 1} of ${totalLines} total.]`;
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

// Correctness-floor: the weak model sometimes hands file_write a DIRECTORY path
// where a file path is expected (the workspace folder, no filename). Writing to
// a directory throws EISDIR. Build the corrective, NON-crashing guidance that
// tells the model to include a filename, used both by the up-front check and
// the EISDIR catch fallback so a raw EISDIR is never surfaced as an is_error.
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

  // Directory target detection: an existing directory, or a trailing-separator
  // path that signals directory intent before the folder even exists. Return
  // corrective guidance (not an is_error) rather than letting writeFile throw
  // EISDIR at the weak model.
  const trailingSep = /[/\\]\s*$/.test(String(args.path ?? '')) || /[/\\]$/.test(filePath);
  let existingDir = false;
  try { existingDir = (await fs.promises.stat(filePath)).isDirectory(); } catch { /* not present yet */ }
  if (existingDir || trailingSep) {
    auditLog(agentId, 'file_write', filePath, 'error', 'target is a directory, not a file (no filename supplied)');
    return directoryTargetGuidance(filePath);
  }

  try {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf-8');
    auditLog(agentId, 'file_write', filePath, 'success', `${content.length} bytes written`);

    const downloadUrl = registerSharedFile(agentId, filePath);
    // P6b-2: record the minted link as a keyed artifact row so the
    // never-drop-the-link backstop reads rows, not result prose.
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
    // Belt-and-suspenders: if a directory (or dir-valued path component) slipped
    // past the pre-check, translate the raw EISDIR into the same corrective
    // guidance instead of a bare is_error crash the weak model can't recover from.
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

  // Same directory-target guard as file_write: a directory path has no filename
  // to append to and would throw EISDIR. Return corrective guidance, not a crash.
  const trailingSep = /[/\\]\s*$/.test(String(args.path ?? '')) || /[/\\]$/.test(filePath);
  let existingDir = false;
  try { existingDir = (await fs.promises.stat(filePath)).isDirectory(); } catch { /* not present yet */ }
  if (existingDir || trailingSep) {
    auditLog(agentId, 'file_write', filePath, 'error', 'target is a directory, not a file (no filename supplied)');
    return directoryTargetGuidance(filePath);
  }

  try {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });

    let leading = '';
    if (ensureNewline) {
      // Peek at the existing trailing byte (if any) to decide whether we
      // need a separator. fs.stat is cheaper than reading the file.
      let existingSize = 0;
      try {
        const stat = await fs.promises.stat(filePath);
        existingSize = stat.size;
      } catch { /* file doesn't exist, append creates it, no leading newline needed */ }
      if (existingSize > 0) {
        const fh = await fs.promises.open(filePath, 'r');
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
    await fs.promises.appendFile(filePath, payload, 'utf-8');
    const stat = await fs.promises.stat(filePath);
    auditLog(agentId, 'file_write', filePath, 'success', `${payload.length} bytes appended (total ${stat.size})`);

    const downloadUrl = registerSharedFile(agentId, filePath);
    if (downloadUrl) queueLinkArtifact(agentId, downloadUrl, filePath);
    // W3 fix loop (run bmr5bymntm5): same refresh-or-AUTO-OPEN treatment as
    // file_write. Pre-fix this only pinged an already-open canvas, so "edit
    // this doc and show me" surfaced or not depending on whether the model
    // happened to pick file_write (auto-open) or file_append (nothing), the
    // canvas outcome must not hinge on the model's tool choice.
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

// ── file_patch ──
//
// Surgical in-place edit. Reads the file, applies every patch in sequence
// against the in-memory copy, refuses to write if any search string isn't
// found, writes via temp-file + rename for atomicity. Binary files are
// rejected (we only deal with text). Sensitive paths (secrets.yaml, .env,
// SSH keys, cloud credentials) are blocked the same way file_read is.

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

  if (isSensitivePath(filePath)) {
    auditLog(agentId, 'file_patch', filePath, 'denied', 'sensitive path block list');
    return `[BLOCKED] file_patch refused: ${filePath} is on the sensitive-files block list (secrets.yaml, .env files, SSH keys, cloud credentials). The DOJO never lets agents rewrite secret files.`;
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
    stat = await fs.promises.stat(filePath);
  } catch {
    auditLog(agentId, 'file_patch', filePath, 'error', 'File not found');
    return `Error: File not found: ${filePath}. file_patch only edits files that already exist, use file_write to create new ones.`;
  }
  if (stat.isDirectory()) {
    return `Error: ${filePath} is a directory, not a file.`;
  }

  let original: string;
  try {
    const buf = await fs.promises.readFile(filePath);
    // Binary detection: text files don't contain NUL bytes. Sample first
    // 8KB so we don't scan a 20MB HTML for every patch call.
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

  // Apply each patch in sequence. Track replacement counts. If ANY patch
  // fails to find its search string, abort with a clear error, never a
  // silent zero-replacement success.
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
      // Use split/join to count and replace every occurrence safely (no regex
      // escaping pitfalls with `.replaceAll`'s string overload? It uses
      // string-mode but we'd need a stable count anyway).
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

  // Atomic write: temp file in the same dir, then rename. fs.rename is
  // atomic on the same filesystem, so a crash mid-write either leaves the
  // original intact or commits the new content, never a half file.
  const tmpName = `.${path.basename(filePath)}.patch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  const tmpPath = path.join(path.dirname(filePath), tmpName);
  try {
    await fs.promises.writeFile(tmpPath, working, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort tmp cleanup, then return the error.
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_patch', filePath, 'error', `write failed: ${msg}`);
    return `Error writing patched file: ${msg}`;
  }

  const beforeBytes = Buffer.byteLength(original, 'utf-8');
  const afterBytes = Buffer.byteLength(working, 'utf-8');
  const totalReplacements = counts.reduce((a, b) => a + b, 0);
  auditLog(agentId, 'file_patch', filePath, 'success', `${totalReplacements} replacements across ${patches.length} patches`);
  const patchDownloadUrl = registerSharedFile(agentId, filePath);
  // W3 fix loop: refresh-or-AUTO-OPEN, same rationale as file_append above,
  // the canvas outcome must not depend on which write tool the model picked.
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
    const stat = await fs.promises.stat(dirPath).catch(() => null);
    if (!stat) {
      auditLog(agentId, 'file_read', dirPath, 'error', 'Directory not found');
      return `Error: Directory not found: ${dirPath}`;
    }

    if (!stat.isDirectory()) {
      auditLog(agentId, 'file_read', dirPath, 'error', 'Path is not a directory');
      return 'Error: Path is not a directory, use file_read instead';
    }

    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const lines = await Promise.all(entries.map(async entry => {
      const type = entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file';
      try {
        const entryPath = path.join(dirPath, entry.name);
        const entryStat = await fs.promises.stat(entryPath);
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

// ── Public API ──

// User-mailbox banner. Whenever the agent reads from the user's own
// email account (via the user_* variants of gmail / outlook read tools),
// prepend a framing line that names the mailbox owner and reminds the
// model: this is the USER's mailbox, the emails inside it were not
// addressed to you, and you should not act on their contents unless
// the user explicitly tells you to in chat.
//
// Background: agents with user-mailbox access were observed taking
// action on emails the user had sent to themselves (e.g. self-sent
// instructions for a side project), treating them as direct prompts.
// The engine framing here makes the audience explicit at every read
// so the model doesn't infer a directive from inbox content alone.

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
      // Structured result with content blocks (images, PDFs)
      content = fileResult.text;
      // Attach the content blocks to the tool result so the runtime
      // can include them in the tool_result sent to the model
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
    // Refuse to stash technique content in the scratchpad.
    // Scratchpad survives across turns and gets re-injected at
    // every assembly, exactly the staleness the v2.7.4 freshness
    // enforcement was built to prevent. If the agent wants to
    // remember WHAT THEY DECIDED while following a technique
    // (parameters chosen, paths produced, errors hit), they can
    //, they just can't paste the technique body itself.
    if (newContent.includes(TECHNIQUE_FRESH_SENTINEL)) {   // PHASE-3 T5: was the inline literal
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
