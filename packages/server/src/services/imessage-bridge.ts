// ════════════════════════════════════════
// iMessage Bridge: Polling + Sending
// ════════════════════════════════════════

import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { handleIMCommand } from './imessage-commands.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { activeRuns, agentStartTimes } from '../agent/shared-state.js';
import { currentTurnImRecipient } from '../agent/turn-state.js';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { scrubTechnicalDetail } from '../agent/v2/error-format.js';
import { recordInboundMeta } from '../agent/v2/inbound-channel.js';
import { isContentFreeCourtesy } from '../agent/v2/classifiers/inbound-courtesy.js';
import { appleMessageDateToUnixMs } from './imessage-date.js';

// ── iMessage attachment pipeline ────────────────────────────────────────────
//
// macOS's Messages chat.db stores a row in `message_attachment_join` for each
// file attached to a message, and the `attachment` table has the actual path
// (in `~/Library/Messages/Attachments/...`), MIME type, and original name.
// When a user sends an image or PDF to the primary agent via iMessage, we:
//
//   1. Fetch the attachment rows linked to the message.
//   2. Copy each supported file into `~/.dojo/uploads/<agentId>/` using the
//      same directory layout as dashboard uploads.
//   3. Convert HEIC → JPEG via macOS's built-in `sips` (vision models don't
//      accept HEIC).
//   4. Register them as an `UploadedFile[]` which gets JSON-serialized into
//      the `messages.attachments` column, identical shape to what the
//      /upload route writes, so the runtime's `injectAttachmentBlocks`
//      picks them up automatically.
//
// Unsupported attachment types (video, audio, arbitrary docs) are logged and
// skipped. The forwarded text is sanitized to remove the `￼` object-
// replacement character macOS inserts as a placeholder for attachments.

interface IMessageAttachmentRow {
  ROWID: number;
  filename: string | null;
  mime_type: string | null;
  transfer_name: string | null;
}

// Mirror of upload.ts UploadedFile, same shape so the runtime's attachment
// injection logic can read both without any branching.
interface UploadedFile {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  category: 'image' | 'pdf' | 'text' | 'office' | 'audio' | 'video' | 'unknown';
}

const DOJO_UPLOAD_DIR = path.join(os.homedir(), '.dojo', 'uploads');
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const HEIC_MIMES = new Set(['image/heic', 'image/heif']);
const PDF_MIMES = new Set(['application/pdf']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.webm', '.caf', '.amr']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.3gp']);

// ── Attachment-readiness race ────────────────────────────────────────────
//
// When macOS receives an iMessage with an attachment, chat.db gets the
// message row and attachment row written immediately, but the actual
// attachment file under ~/Library/Messages/Attachments/... may take
// several seconds to appear, especially for large photos, HEIC from an
// iPhone, or anything being synced from iCloud. If we poll during that
// window and advance `lastSeenRowId` past the message, we'll process it
// as text-only and never retry. The model then says "I don't see an
// image attached" because, from its perspective, there never was one.
//
// Fix: before advancing past any message that claims attachments, verify
// every attachment file is actually on disk. If not, break out of the
// processing loop without advancing, and try again on the next poll.
// A per-rowid retry counter bounds the deferral so a permanently broken
// download doesn't block the bridge forever, after ~60 seconds of
// retries (12 polls × 5s interval) we give up and process the message
// without the attachments, logging a warning so the reason is visible.

const MAX_ATTACHMENT_RETRIES = 12;
const deferredAttachmentRetries = new Map<number, number>();

// Text-ish file extensions we'll read + inline directly into the forwarded
// message body (same list as packages/server/src/gateway/routes/upload.ts).
// Any file under `INLINE_TEXT_MAX_BYTES` whose MIME starts with `text/` or
// whose extension is in this set gets slurped and framed with a header/
// footer so the model reads it as context. Duplicated here rather than
// imported to keep the iMessage bridge self-contained.
const INLINE_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.js', '.ts', '.py', '.html', '.css',
  '.sh', '.yaml', '.yml', '.toml', '.env', '.tsx', '.jsx', '.sql', '.rs',
  '.go', '.java', '.rb', '.php', '.swift', '.kt', '.c', '.cpp', '.h', '.log',
]);
const INLINE_TEXT_MAX_BYTES = 64 * 1024; // 64 KB per text file

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// A note about an attachment we chose not to decode/deliver, still surfaced
// to the model in the message text so it can respond "I got your video but
// I can't play videos" etc, rather than silently dropping the context.
interface MentionedAttachment {
  name: string;
  mimeType: string;
  size: number;
  reason: string; // short human-readable reason for the mention-only path
}

interface ImessageAttachmentResult {
  uploadedFiles: UploadedFile[];   // image/PDF copied to disk, runtime injects as content blocks
  inlinedTextBlocks: string[];     // small text files read + framed for the message body
  mentionedAttachments: MentionedAttachment[]; // everything else, metadata only
}

function ensureImessageUploadDir(agentId: string): string {
  const dir = path.join(DOJO_UPLOAD_DIR, agentId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function expandHomedir(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

function safeFilenamePart(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Remove the U+FFFC object-replacement character macOS inserts in the text
// column for each inline attachment, plus any leftover whitespace. If the
// user sent an image with no caption, this collapses to an empty string.
function stripAttachmentPlaceholder(text: string | null): string {
  return (text ?? '').replace(/\uFFFC/g, '').trim();
}

// Quickly checks whether every attachment linked to a given message has
// its file on disk. Read-only, no side effects, just a sanity probe the
// poll loop uses to decide whether to defer processing.
//
// Returns `{ready: true}` when the message has zero attached files OR
// every attachment's `filename` path exists on disk. Returns
// `{ready: false, reason}` as soon as one is missing.
function isMessageAttachmentReady(
  chatDb: Database.Database,
  messageRowid: number,
): { ready: true } | { ready: false; reason: string } {
  const rows = chatDb.prepare(`
    SELECT a.ROWID, a.filename
    FROM message_attachment_join maj
    JOIN attachment a ON a.ROWID = maj.attachment_id
    WHERE maj.message_id = ?
  `).all(messageRowid) as Array<{ ROWID: number; filename: string | null }>;

  // No joins yet → either the message has no attachments, or the join
  // row hasn't been written yet. In the first case we're fine; in the
  // second, the message's text was already processed one poll earlier
  // before the join existed, so there's nothing we can do now. Treat
  // "no joins" as ready and move on.
  if (rows.length === 0) return { ready: true };

  for (const row of rows) {
    if (!row.filename) continue; // attachment row exists but no path, skip it silently
    const srcPath = expandHomedir(row.filename);
    if (!fs.existsSync(srcPath)) {
      return {
        ready: false,
        reason: `attachment ${row.ROWID} not yet on disk: ${srcPath}`,
      };
    }
  }
  return { ready: true };
}

function fetchImessageAttachments(
  chatDb: Database.Database,
  messageRowid: number,
  agentId: string,
): ImessageAttachmentResult {
  const rows = chatDb.prepare(`
    SELECT a.ROWID, a.filename, a.mime_type, a.transfer_name
    FROM message_attachment_join maj
    JOIN attachment a ON a.ROWID = maj.attachment_id
    WHERE maj.message_id = ?
    ORDER BY a.ROWID ASC
  `).all(messageRowid) as IMessageAttachmentRow[];

  const result: ImessageAttachmentResult = {
    uploadedFiles: [],
    inlinedTextBlocks: [],
    mentionedAttachments: [],
  };

  if (rows.length === 0) return result;

  const dir = ensureImessageUploadDir(agentId);

  for (const row of rows) {
    if (!row.filename) continue;
    const srcPath = expandHomedir(row.filename);

    if (!fs.existsSync(srcPath)) {
      logger.warn('iMessage attachment file missing on disk, skipping', {
        attachmentId: row.ROWID,
        srcPath,
      });
      continue;
    }

    const mimeType = (row.mime_type ?? '').toLowerCase();
    const displayName = row.transfer_name || path.basename(srcPath);
    const ext = path.extname(displayName).toLowerCase();
    const fileId = uuidv4();
    const timestamp = Date.now();

    // Stat once up front so every branch has size info without re-stating.
    let srcSize = 0;
    try { srcSize = fs.statSync(srcPath).size; } catch { /* leave 0 */ }

    try {
      // ── Tier 1: deliverable bytes (image + PDF) ──────────────────────
      if (IMAGE_MIMES.has(mimeType)) {
        const storedName = `imessage_${timestamp}_${safeFilenamePart(displayName)}`;
        const destPath = path.join(dir, storedName);
        fs.copyFileSync(srcPath, destPath);
        const size = fs.statSync(destPath).size;
        result.uploadedFiles.push({
          fileId, filename: displayName, mimeType, size, path: destPath, category: 'image',
        });
        logger.info('iMessage image attached', { fileId, displayName, size });
        continue;
      }

      if (HEIC_MIMES.has(mimeType)) {
        // Vision models don't accept HEIC, convert to JPEG via macOS's
        // built-in `sips` tool. 30s timeout is generous for any iPhone photo.
        const jpegBase = safeFilenamePart(displayName).replace(/\.(heic|heif)$/i, '.jpg');
        const jpegName = `imessage_${timestamp}_${jpegBase}`;
        const destPath = path.join(dir, jpegName);
        execSync(
          `sips -s format jpeg ${JSON.stringify(srcPath)} --out ${JSON.stringify(destPath)}`,
          { stdio: 'pipe', timeout: 30_000 },
        );
        if (!fs.existsSync(destPath)) {
          logger.warn('HEIC conversion produced no output, mentioning instead', {
            srcPath, destPath,
          });
          result.mentionedAttachments.push({
            name: displayName,
            mimeType,
            size: srcSize,
            reason: 'HEIC conversion failed',
          });
          continue;
        }
        const size = fs.statSync(destPath).size;
        result.uploadedFiles.push({
          fileId,
          filename: displayName.replace(/\.(heic|heif)$/i, '.jpg'),
          mimeType: 'image/jpeg',
          size,
          path: destPath,
          category: 'image',
        });
        logger.info('iMessage HEIC converted and attached', { fileId, displayName, size });
        continue;
      }

      if (PDF_MIMES.has(mimeType)) {
        const storedName = `imessage_${timestamp}_${safeFilenamePart(displayName)}`;
        const destPath = path.join(dir, storedName);
        fs.copyFileSync(srcPath, destPath);
        const size = fs.statSync(destPath).size;
        result.uploadedFiles.push({
          fileId, filename: displayName, mimeType, size, path: destPath, category: 'pdf',
        });
        logger.info('iMessage PDF attached', { fileId, displayName, size });
        continue;
      }

      // ── Tier 1b: audio / video, copy bytes so the receiving agent can
      // route them through transcribe_audio. iPhone voice memos arrive as
      // .caf or .m4a; standard mp3/wav also flow through here.
      const isAudioByMime = mimeType.startsWith('audio/');
      const isVideoByMime = mimeType.startsWith('video/');
      const isAudioByExt = AUDIO_EXTENSIONS.has(ext);
      const isVideoByExt = VIDEO_EXTENSIONS.has(ext);
      if (isAudioByMime || isAudioByExt || isVideoByMime || isVideoByExt) {
        const category: UploadedFile['category'] = (isAudioByMime || isAudioByExt) ? 'audio' : 'video';
        const storedName = `imessage_${timestamp}_${safeFilenamePart(displayName)}`;
        const destPath = path.join(dir, storedName);
        fs.copyFileSync(srcPath, destPath);
        const size = fs.statSync(destPath).size;
        // Best-effort MIME backfill when iMessage didn't give us one.
        const inferredMime =
          mimeType
          || (category === 'audio'
            ? (ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : ext === '.m4a' ? 'audio/mp4' : 'audio/mpeg')
            : (ext === '.mp4' ? 'video/mp4' : ext === '.mov' ? 'video/quicktime' : 'video/mp4'));
        result.uploadedFiles.push({
          fileId, filename: displayName, mimeType: inferredMime, size, path: destPath, category,
        });
        logger.info(`iMessage ${category} attached`, { fileId, displayName, size, mimeType: inferredMime });
        continue;
      }

      // ── Tier 2: inline text (small text-ish files read + framed) ─────
      const looksLikeText = mimeType.startsWith('text/') || INLINE_TEXT_EXTENSIONS.has(ext);
      if (looksLikeText) {
        if (srcSize > INLINE_TEXT_MAX_BYTES) {
          result.mentionedAttachments.push({
            name: displayName,
            mimeType: mimeType || `text/${ext.slice(1) || 'plain'}`,
            size: srcSize,
            reason: `text file too large to inline (${formatBytes(srcSize)}, cap ${formatBytes(INLINE_TEXT_MAX_BYTES)})`,
          });
          logger.info('iMessage text file too large, mentioning', { displayName, size: srcSize });
          continue;
        }
        try {
          const content = fs.readFileSync(srcPath, 'utf8');
          const header = `[Text file: ${displayName} — ${formatBytes(srcSize)}]`;
          const footer = `[end of ${displayName}]`;
          result.inlinedTextBlocks.push(`${header}\n${content}\n${footer}`);
          logger.info('iMessage text file inlined', { displayName, size: srcSize });
          continue;
        } catch (err) {
          result.mentionedAttachments.push({
            name: displayName,
            mimeType: mimeType || 'text/plain',
            size: srcSize,
            reason: `couldn't read as text (${err instanceof Error ? err.message : String(err)})`,
          });
          continue;
        }
      }

      // ── Tier 3: mention only (video, audio, office, unknown) ─────────
      // We don't copy the bytes. The model gets the filename, MIME type,
      // and size in the message body and can decide how to respond.
      result.mentionedAttachments.push({
        name: displayName,
        mimeType: mimeType || 'application/octet-stream',
        size: srcSize,
        reason: 'format not yet deliverable to models — metadata only',
      });
      logger.info('iMessage attachment mentioned (not delivered)', {
        displayName, mimeType, size: srcSize,
      });
    } catch (err) {
      logger.warn('Failed to process iMessage attachment, mentioning instead', {
        displayName,
        mimeType,
        error: err instanceof Error ? err.message : String(err),
      });
      result.mentionedAttachments.push({
        name: displayName,
        mimeType: mimeType || 'application/octet-stream',
        size: srcSize,
        reason: `processing error (${err instanceof Error ? err.message : String(err)})`,
      });
    }
  }

  return result;
}

const logger = createLogger('imessage');

// ── Safe-sender records ──────────────────────────────────────────────────
//
// The `imessage_approved_senders` config value used to be a bare JSON array
// of phone/Apple-ID strings, with the "primary user" tracked separately in
// `imessage_default_sender`. That made the agent unable to tell who actually
// sent an inbound message (the framing always said "FROM <owner>") and made
// the outbound tool's allowlist trivially bypassable.
//
// New shape, stored under the same config key for continuity:
//   [
//     { address: "+15551234567", name: "Alex", description: "Owner",
//       is_primary: true, sharing_level: "open_book" },
//     { address: "jordan@example.com", name: "Jordan", description:
//       "project collaborator", is_primary: false,
//       sharing_level: "project_only" },
//     ...
//   ]
//
// `parseSafeSenders` accepts BOTH the legacy (string[]) and new shapes,
// so existing installs keep working until the next Settings save migrates
// the value to the new shape on disk. Reads always go through this parser
// so callers never see the legacy form.

export type SharingLevel = 'open_book' | 'dont_overshare' | 'cautious' | 'project_only';

export const SHARING_LEVELS: readonly SharingLevel[] = ['open_book', 'dont_overshare', 'cautious', 'project_only'] as const;

export interface SafeSender {
  address: string;
  name: string;
  description?: string;
  is_primary: boolean;
  sharing_level: SharingLevel;
  /**
   * RC-4/RC-8: true when this safe-sender is another Dojo agent (not a human).
   * Lets the engine gate machine-to-machine behavior (skip start-acks, damp
   * content-free courtesy volleys) on structured data instead of free-text in
   * `description`. Optional + defaults false in parseSafeSenders so legacy
   * records and the config JSON need no migration.
   */
  is_agent?: boolean;
}

function defaultSharingLevelFor(isPrimary: boolean): SharingLevel {
  return isPrimary ? 'open_book' : 'dont_overshare';
}

function normalizeSharingLevel(raw: unknown, isPrimary: boolean): SharingLevel {
  if (typeof raw === 'string' && (SHARING_LEVELS as readonly string[]).includes(raw)) {
    return raw as SharingLevel;
  }
  return defaultSharingLevelFor(isPrimary);
}

/**
 * Scrub characters that would break the [SOURCE: IMESSAGE FROM ...] framing
 * envelope: square brackets (close the envelope early), CR/LF (split lines),
 * and other control chars. Result is collapsed-whitespace-trimmed. Returns
 * an empty string if everything was stripped (caller can fall back).
 */
function sanitizeFramingField(value: string): string {
  return value
    .replace(/[\[\]\r\n\t\v\f -]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// RC-4/RC-8 one-time backfill: safe-sender records saved before the structured
// `is_agent` flag existed only say "AI agent" in their free-text description.
// When the flag is ABSENT (not merely false) and the description matches this,
// treat the sender as an agent so the machine-to-machine gates apply without a
// manual re-save. Explicit `is_agent: false` always wins (never re-promoted).
const IS_AGENT_DESCRIPTION_RE = /\bAI agent\b/i;
// Log the heuristic firing once per address (parseSafeSenders runs on every
// poll) so the info line is a one-time signal, not per-tick noise.
const backfillHeuristicLogged = new Set<string>();

export function parseSafeSenders(raw: string | null | undefined): SafeSender[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const normalized: SafeSender[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (typeof item === 'string') {
      // Legacy entry: auto-promote, mark first as primary, copy address into name.
      const addr = item.trim();
      if (!addr) continue;
      const isPrimary = i === 0;
      normalized.push({
        address: addr,
        name: addr,
        description: undefined,
        is_primary: isPrimary,
        sharing_level: defaultSharingLevelFor(isPrimary),
        is_agent: false,
      });
      continue;
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const address = typeof obj.address === 'string' ? obj.address.trim() : '';
      if (!address) continue;
      // Strip brackets and control chars from name/description so a
      // crafted entry can't break the [SOURCE: IMESSAGE FROM ...] envelope
      // the agent parses out of inbound message text.
      const rawName = typeof obj.name === 'string' ? obj.name.trim() : '';
      const name = rawName ? (sanitizeFramingField(rawName) || address) : address;
      const rawDescription = typeof obj.description === 'string' ? obj.description.trim() : '';
      const cleanedDescription = rawDescription ? sanitizeFramingField(rawDescription) : '';
      const description = cleanedDescription || undefined;
      const is_primary = obj.is_primary === true;
      const sharing_level = normalizeSharingLevel(obj.sharing_level, is_primary);
      // is_agent: honor an explicit boolean; when the field is absent, apply
      // the one-time description heuristic (defaults false otherwise).
      let is_agent: boolean;
      if (typeof obj.is_agent === 'boolean') {
        is_agent = obj.is_agent;
      } else if (rawDescription && IS_AGENT_DESCRIPTION_RE.test(rawDescription)) {
        is_agent = true;
        if (!backfillHeuristicLogged.has(address)) {
          backfillHeuristicLogged.add(address);
          logger.info('Safe-sender is_agent backfilled from description heuristic', {
            address, matched: 'AI agent',
          });
        }
      } else {
        is_agent = false;
      }
      normalized.push({ address, name, description, is_primary, sharing_level, is_agent });
    }
  }

  // Guarantee exactly one primary. If none, promote the legacy default key's
  // match or the first record. If multiple, keep only the first marked.
  const primaries = normalized.filter(s => s.is_primary);
  if (primaries.length === 0 && normalized.length > 0) {
    const legacyDefault = readLegacyDefaultSender();
    const promoteIdx = legacyDefault
      ? normalized.findIndex(s => addressesMatch(s.address, legacyDefault))
      : -1;
    if (promoteIdx >= 0) normalized[promoteIdx].is_primary = true;
    else normalized[0].is_primary = true;
  } else if (primaries.length > 1) {
    let seen = false;
    for (const s of normalized) {
      if (s.is_primary) {
        if (seen) s.is_primary = false;
        else seen = true;
      }
    }
  }
  return normalized;
}

function readLegacyDefaultSender(): string | null {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM config WHERE key = 'imessage_default_sender'`).get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Tolerant address comparison. Phone numbers may come in as `+15551234567`,
 * `15551234567`, `(555) 123-4567`, etc; Apple IDs come in lowercase. Match
 * if the normalized forms are equal OR one contains the other (substring),
 * which handles country-code prefixes and formatting variations without
 * false-matching completely different addresses.
 */
export function addressesMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9@.]/g, '');
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Substring fallback only for "phone-ish" addresses (no @ on either side).
  // Email matching is exact to avoid alice@x.com matching alice.smith@x.com.
  if (na.includes('@') || nb.includes('@')) return false;
  return na.includes(nb) || nb.includes(na);
}

export function findSafeSenderByAddress(records: readonly SafeSender[], query: string): SafeSender | null {
  for (const r of records) {
    if (addressesMatch(r.address, query)) return r;
  }
  return null;
}

/**
 * Build the sharing-policy paragraph for an inbound iMessage's framing. The
 * agent reads this every turn and uses it to decide what's appropriate to
 * share with the sender. Soft enforcement only - the model still chooses
 * what to say. For non-open-book levels we append an explicit escape hatch
 * pointing the agent to the primary user (by name from the records) so it
 * can ask permission when uncertain instead of guessing.
 */
function buildSharingPolicyLine(sender: SafeSender, records: readonly SafeSender[]): string {
  const primary = records.find(s => s.is_primary);
  const primaryName = primary?.name?.trim() || 'the primary user';
  // RC-11: never point the agent at "ask the primary user" when the SENDER is
  // the primary user, that hatch would tell the agent to ask the owner about
  // the owner. (Owners normally sit at open_book anyway, but a non-open_book
  // owner record must still skip it.)
  const askPrimary =
    sender.is_primary || sender.sharing_level === 'open_book'
      ? ''
      : ` If in doubt about whether something is OK to share, ask ${primaryName} first - reach them via BOTH the dashboard chat AND iMessage so they see your question on whichever channel they're checking. Wait for their answer before responding to the sender.`;

  switch (sender.sharing_level) {
    case 'open_book':
      return 'SHARING POLICY: Open Book. No restrictions - share schedule, contacts, files, ongoing projects, and personal details freely. Treat this sender as the owner.';
    case 'dont_overshare':
      return `SHARING POLICY: Don't Over-Share. Share what's asked and what's directly relevant to the conversation. Do NOT proactively dump information they didn't ask for (schedule details, contact info, project status, etc.). Hold back credentials, financials, and anything explicitly marked confidential.${askPrimary}`;
    case 'cautious':
      return `SHARING POLICY: Be Cautious. Answer only what is directly asked, briefly. Never volunteer schedule, contacts, or project details unprompted. If asked something personal, stay high-level (e.g., "${primaryName} is busy this afternoon" - NOT specific meeting names or times). When in doubt, share less rather than more.${askPrimary}`;
    case 'project_only':
      return `SHARING POLICY: Project Only. Discuss ONLY the specific project or topic this contact is collaborating on (see the sender description for the scope). If asked anything off-topic - personal life, schedule, contacts, other projects - politely refuse and redirect back to the project at hand.${askPrimary}`;
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let approvedSenders: SafeSender[] = [];
let lastSeenRowId = 0;
const POLL_INTERVAL_MS = 5000;

// ── Offline-replay age floor ──
// A box that was offline for days reconnects with a stale cursor; without a floor
// the first poll would replay EVERY safe-sender text between the cursor and now as
// a fresh inbound and auto-reply to conversations the sender long since moved on
// from. Ignore anything older than this: the cursor still advances past it (so it
// is skipped permanently, never re-read), but the agent is never woken and no
// reply is sent. Online boxes are unaffected, their inbound rows are seconds old.
const IMESSAGE_MAX_REPLAY_AGE_MS = 48 * 60 * 60 * 1000;

// True while pollMessages is mid-flight. setInterval keeps firing every 5s,
// but if a poll is still reading/persisting inbound rows we skip the next
// tick so two polls never read chat.db (or advance lastSeenRowId)
// concurrently. D10: the poll loop no longer awaits the agent's TURN, so
// this guard now only spans the fast ingest work (read chat.db, persist,
// broadcast, dispatch); turn serialization is the runtime's job
// (activeRuns + pendingWakeups in handleMessage).
let pollInFlight = false;

// D19 pt3: bounded retry counter for rows whose persist INSERT failed. We
// deliberately do NOT advance lastSeenRowId past an unpersisted row (a crash
// or transient DB error would otherwise silently drop the text forever), but
// an always-failing row must not wedge the bridge either: after
// MAX_PERSIST_RETRIES polls we advance past it with a loud error log, which
// is the OLD behavior (advance-then-drop) made deliberate and bounded.
const MAX_PERSIST_RETRIES = 12;
const persistRetries = new Map<number, number>();

// ── D10 busy-ack ──
// When an authorized sender's iMessage lands while a LONG turn (>60s old) is
// already running, the message is persisted + queued behind that turn (the
// runtime serializes per agent), which used to mean pure silence for up to a
// whole turn. Send ONE deterministic engine ack per sender per running turn
// so the person knows they were heard. Engine send, never a model turn.
const BUSY_ACK_TURN_AGE_MS = 60_000;
const BUSY_ACK_TEXT = 'On it. I am mid-task right now, I will get back to you shortly.';
// agentId -> the running turn (identified by its start timestamp) + senders acked for it
const busyAckState = new Map<string, { turnStartedAt: number; ackedSenders: Set<string> }>();

function maybeSendBusyAck(agentId: string, sender: string): void {
  // Only when a turn is ALREADY running (checked before we dispatch this
  // message, so our own dispatch can't trip it) and it's older than 60s.
  if (!activeRuns.has(agentId)) return;
  const turnStartedAt = agentStartTimes.get(agentId);
  if (!turnStartedAt) return;
  if (Date.now() - turnStartedAt < BUSY_ACK_TURN_AGE_MS) return;
  let st = busyAckState.get(agentId);
  if (!st || st.turnStartedAt !== turnStartedAt) {
    st = { turnStartedAt, ackedSenders: new Set<string>() };
    busyAckState.set(agentId, st);
  }
  const key = canonicalContactAddress(sender);
  if (st.ackedSenders.has(key)) return; // at most once per sender per running turn
  st.ackedSenders.add(key);
  sendIMessage(sender, BUSY_ACK_TEXT);
  // Surface the queued state on the dashboard too (transient; the 30s
  // working-status heartbeat re-asserts 'working' while the turn runs).
  broadcast({ type: 'agent:status', agentId, status: 'queued' });
  logger.info('Busy-ack sent: inbound iMessage queued behind a running turn', {
    agentId,
    sender,
    turnAgeMs: Date.now() - turnStartedAt,
  });
}

// Track which sender triggered each agent's current turn so we reply to the right person.
// No timeout, the flag stays until the agent's response is sent. Slow turns (tool calls,
// slow models) should still get their iMessage reply.
//
// D10: the poll loop no longer serializes behind the running turn, so this
// single-slot map CAN be overwritten by a newer inbound mid-turn. That is
// safe because every routing consumer prefers turn-anchored state
// (currentTurnImRecipient, set from the turn's counterparty which derives
// from the persisted inbound_meta); the map survives only as (a) the
// "an iMessage inbound is pending" boolean and (b) a legacy fallback for
// rows without inbound_meta. To keep it per-message correct, consumption is
// now sender-scoped: clears pass the sender they are consuming FOR, so a
// turn finishing for sender A can never eat the entry a newer inbound from
// sender B just wrote.
const pendingIMResponseMap = new Map<string, { sender: string }>(); // agentId -> sender

export function isAwaitingIMResponse(agentId: string): boolean {
  return pendingIMResponseMap.has(agentId);
}

/**
 * Clear the pending-inbound flag. When `onlyIfSender` is provided, the entry
 * is removed ONLY if it still belongs to that sender (canonical compare), so
 * a consume-once clear scoped to turn A cannot drop the entry a newer
 * inbound B wrote mid-turn. Omit `onlyIfSender` for an unconditional clear.
 */
export function clearIMResponseFlag(agentId: string, onlyIfSender?: string): void {
  if (onlyIfSender !== undefined) {
    const entry = pendingIMResponseMap.get(agentId);
    if (!entry) return;
    if (canonicalContactAddress(entry.sender) !== canonicalContactAddress(onlyIfSender)) return;
  }
  pendingIMResponseMap.delete(agentId);
}

/**
 * Raw pending-map read (no currentTurnImRecipient preference, unlike
 * getInboundSenderFor). The v2 loop captures this at run start so its
 * end-of-turn consume-once clear can be scoped to THIS turn's inbound,
 * not a newer one that arrived while the turn ran.
 */
export function getPendingIMSenderRaw(agentId: string): string | null {
  return pendingIMResponseMap.get(agentId)?.sender ?? null;
}

/**
 * The raw address of the sender whose iMessage triggered this agent's
 * current turn, or null if the turn wasn't iMessage-initiated. The
 * outbound `imessage_send` tool uses this to default the recipient, so
 * a reply goes to the person who actually sent the inbound, not the
 * starred default. Critical for setups where multiple safe senders
 * share one Dojo (e.g. sender A messages the agent, agent must not
 * accidentally reply to sender B).
 */
export function getInboundSenderFor(agentId: string): string | null {
  // T-4: the LIVE turn's iMessage counterparty wins over the racy last-inbound map.
  // pendingIMResponseMap holds a single value per agent (the most recent inbound),
  // so during a multi-conversation drain an explicit no-recipient imessage_send /
  // image_create could go to the wrong person. The turn publishes its counterparty
  // to currentTurnImRecipient; prefer it, fall back to the legacy map outside a turn.
  const turnRecipient = currentTurnImRecipient.get(agentId);
  if (turnRecipient) return turnRecipient;
  return pendingIMResponseMap.get(agentId)?.sender ?? null;
}

/**
 * FA-C1: the TURN-scoped iMessage counterparty ONLY (currentTurnImRecipient),
 * with NO fallback to the legacy pendingIMResponseMap. Used by the explicit
 * imessage_send default-recipient path and the image_create delivery path, so an
 * omitted recipient can only ever resolve to the person THIS turn is actually
 * conversing with. Outside a genuine iMessage turn it returns null and the caller
 * MUST refuse to guess: pendingIMResponseMap holds whoever texted this agent most
 * recently at INGEST time, fully decoupled from turn execution, so consulting it
 * on a proactive/dashboard turn could deliver owner-directed content to whatever
 * contact happened to text moments earlier. The broader getInboundSenderFor keeps
 * the map fallback for the resolve-time context read (inbound-channel.ts), a
 * different consumer that must stay unchanged.
 */
export function getTurnScopedImRecipient(agentId: string): string | null {
  return currentTurnImRecipient.get(agentId) ?? null;
}

// ── Agent-initiated (relay) contact tracking ──
//
// When the agent proactively texts someone who ISN'T the person who
// triggered the current turn (a relay: "the owner asked me to ask a contact"), we
// record that contact here. When that contact later REPLIES, the agent's
// end-of-turn text is a report back to the original requester (the
// dashboard user), NOT an auto-reply to the contact, so the v2.7.23
// auto-router suppresses iMessage routing for that inbound turn and leaves
// the text in the dashboard. Consume-once: cleared the first time the
// relay reply is handled, so a genuine later exchange isn't suppressed.
const agentInitiatedContacts = new Map<string, Set<string>>(); // agentId -> Set<canonical address>

// Resolve to the stored safe-sender address so a marked recipient and a
// later inbound sender compare equal despite formatting differences (phone
// punctuation, email case). Falls back to a lowercased raw address.
function canonicalContactAddress(address: string): string {
  const match = findSafeSenderByAddress(getSafeSenders(), address);
  return (match?.address ?? address).trim().toLowerCase();
}

export function markAgentInitiatedContact(agentId: string, address: string): void {
  let set = agentInitiatedContacts.get(agentId);
  if (!set) {
    set = new Set<string>();
    agentInitiatedContacts.set(agentId, set);
  }
  set.add(canonicalContactAddress(address));
}

export function isAgentInitiatedContact(agentId: string, address: string): boolean {
  return agentInitiatedContacts.get(agentId)?.has(canonicalContactAddress(address)) ?? false;
}

export function clearAgentInitiatedContact(agentId: string, address: string): void {
  agentInitiatedContacts.get(agentId)?.delete(canonicalContactAddress(address));
}

/**
 * v2.5.7, strip system routing tags the LLM may have copied from prior
 * conversation history into its own reply (most commonly the
 * "[SENT VIA IMESSAGE to <owner>]" marker the engine writes after delivery).
 * These tags are dashboard-only metadata; if they leak into the outgoing
 * iMessage body the user sees the literal annotation on their phone, and
 * if they appear in the persisted assistant message they break the
 * dashboard's tag-detection regex (which expects the tag to be the entire
 * message content) so the tag renders as raw text.
 *
 * Aggressive strip: removes the bracket PLUS any same-line content after
 * it, the primary agent sometimes emits the tag followed by a duplicated URL on the
 * same line ("[SENT VIA IMESSAGE to the owner]https://..."). The whole
 * trailing block is hallucinated noise, not legitimate content.
 *
 * Exported so the v2 loop can sanitize persistedContent at the source and
 * presence.ts's distillForText can use the same regex.
 */
export function stripSystemTags(text: string): string {
  return text
    .replace(/\s*\[SENT VIA IMESSAGE to [^\]]+\][^\n]*\n?/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Auto-deliver the agent's terminal text back over iMessage. Returns the
 * recipient that actually received it ({ address, name }) so the caller can
 * label the dashboard routing badge with the TRUE recipient, or null when
 * the send was suppressed (no valid recipient / empty after sanitization).
 * The badge must never be derived from a hardcoded default, it has to
 * reflect who the message really went to.
 */
export function sendResponseViaIMessage(
  text: string,
  agentId?: string,
  recipientOverride?: string | null,
  ownerBound?: boolean,
): { address: string; name: string } | null {
  if (!agentId) agentId = getPrimaryAgentId();
  // C8: an OWNER-BOUND send (the away-override promoted a dashboard/proactive reply to
  // iMessage precisely to reach the owner who stepped away) must go to the owner/primary,
  // never to whatever contact the racy pendingIMResponseMap last captured mid-turn, that
  // was the "owner's private dashboard reply texted to a contact" bug (inv 1 + 4). This is
  // authoritative, so it's checked before the recipientOverride and map branches.
  if (ownerBound) {
    const owner = getDefaultSender();
    // Consume only the OWNER's own pending entry (sender-scoped). A newer
    // contact inbound that landed mid-turn keeps its entry so its pending
    // signal survives until its own turn serves it.
    if (owner) clearIMResponseFlag(agentId, owner);
    if (!owner) return null;
    const cleanedOwner = stripSystemTags(text);
    if (!cleanedOwner) return null;
    sendIMessage(owner, cleanedOwner);
    return { address: owner, name: findSafeSenderByAddress(getSafeSenders(), owner)?.name ?? owner };
  }
  // Two safety rails on the fallback path:
  //  (a) when there's no inbound trigger, default to the starred primary
  //      (getDefaultSender), NOT approvedSenders[0]. They're often the
  //      same but not always - the array's first entry is just whatever
  //      the user typed first in Settings.
  //  (b) re-validate the inbound sender against the current safe-sender
  //      list. If the user removed that sender mid-conversation, silently
  //      drop the auto-reply instead of texting someone no longer
  //      authorized.
  let sender: string | null = null;
  let recipientName: string | null = null;
  // The TURN's counterparty wins over pendingIMResponseMap. That in-memory map is
  // set per inbound and gets overwritten when another iMessage arrives during a
  // turn, the bug where a reply to a contact routed to the owner under concurrency.
  // When the loop passes the turn's counterparty address, use it (validated). If
  // it is no longer a safe sender, SUPPRESS, never fall back to texting the
  // owner an answer meant for someone else.
  if (recipientOverride !== undefined && recipientOverride !== null) {
    const allowed = findSafeSenderByAddress(getSafeSenders(), recipientOverride);
    if (allowed) { sender = recipientOverride; recipientName = allowed.name; }
    else {
      logger.warn('Auto-reply suppressed: turn counterparty not on safe-sender list', { agentId, recipient: recipientOverride });
      clearIMResponseFlag(agentId, recipientOverride);
      return null;
    }
    // Sender-scoped consume: only this recipient's own pending entry.
    clearIMResponseFlag(agentId, recipientOverride);
    const cleanedOverride = stripSystemTags(text);
    if (!cleanedOverride) return null;
    sendIMessage(sender, cleanedOverride);
    return { address: sender, name: recipientName ?? sender };
  }
  const entry = pendingIMResponseMap.get(agentId);
  if (entry?.sender) {
    const stillAllowed = findSafeSenderByAddress(getSafeSenders(), entry.sender);
    if (stillAllowed) {
      sender = entry.sender;
      recipientName = stillAllowed.name;
    } else {
      logger.warn('Auto-reply suppressed: inbound sender no longer on safe-sender list', {
        agentId,
        sender: entry.sender,
      });
    }
  } else {
    sender = getDefaultSender();
    if (sender) recipientName = findSafeSenderByAddress(getSafeSenders(), sender)?.name ?? null;
  }
  // Consume the entry we actually read (sender-scoped); nothing to clear on
  // the default-sender path where no entry existed.
  if (entry) clearIMResponseFlag(agentId, entry.sender);
  if (!sender) return null;
  const cleaned = stripSystemTags(text);
  if (!cleaned) return null;
  sendIMessage(sender, cleaned); // sanitization happens inside sendIMessage
  return { address: sender, name: recipientName ?? sender };
}
const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

function loadLastSeenRowId(): number {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM config WHERE key = 'imessage_last_rowid'`).get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

function saveLastSeenRowId(rowId: number): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES ('imessage_last_rowid', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(String(rowId), String(rowId));
  } catch (err) {
    logger.error('Failed to save last seen rowid', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The single per-message inbound processor shared by the live poll loop AND
 * the dev-harness probe (gateway/routes/dev.ts). Both callers traverse this
 * exact path, so there is no bypass seam: what the probe verifies is the code
 * a real inbound text runs.
 *
 * Order: command intercept -> (on no command) persist for the primary agent +
 * dispatch -> reply delivery.
 *   COMMAND: handleIMCommand owns its own is_primary owner gate for EVERY
 *     command (status / kill / pause / resume AND the approve/deny lane); a
 *     non-owner's command-shaped text returns null there and falls through as
 *     ordinary chat, so the command surface never leaks. On a real command the
 *     reply is texted back to the sender and the agent is NOT woken.
 *   FALLTHROUGH: the message is persisted for the primary agent (with the
 *     structured inbound_meta) exactly as before, then the runtime is woken.
 *
 * The chat.db cursor is the poll loop alone: advanceRowId (the row ROWID) is
 * folded into the SAME persist transaction so INSERT + inbound_meta + cursor
 * advance commit atomically; the probe passes null (no cursor to move).
 * wakeAgent gates ONLY the final runtime dispatch: the poll loop wakes the turn
 * (true); the probe persists the row for the agent and asserts it landed
 * without burning a model turn (false). Command handling and reply delivery are
 * identical for both callers.
 */
export interface InboundIMessageInput {
  sender: string;
  cleanedText: string;
  attachmentResult?: ImessageAttachmentResult;
  advanceRowId: number | null;
  wakeAgent: boolean;
}

export type InboundIMessageOutcome =
  | { outcome: 'command'; reply: string; messageId: null }
  | { outcome: 'dispatched'; reply: null; messageId: string };

export async function processInboundIMessage(
  input: InboundIMessageInput,
): Promise<InboundIMessageOutcome> {
  const { sender, cleanedText, advanceRowId, wakeAgent } = input;
  const attachmentResult: ImessageAttachmentResult =
    input.attachmentResult ?? { uploadedFiles: [], inlinedTextBlocks: [], mentionedAttachments: [] };
  const primaryId = getPrimaryAgentId();
  const safeSenders = getSafeSenders();

  const totalAttachmentCount =
    attachmentResult.uploadedFiles.length +
    attachmentResult.inlinedTextBlocks.length +
    attachmentResult.mentionedAttachments.length;

  // Command intercept against the text portion only (an image-only message can
  // never be a command). On a hit the reply goes to the SENDER and the agent
  // is left asleep; handleIMCommand enforces the owner gate for every command.
  if (cleanedText) {
    const commandResponse = await handleIMCommand(cleanedText, sender);
    if (commandResponse) {
      sendIMessage(sender, commandResponse);
      return { outcome: 'command', reply: commandResponse, messageId: null };
    }
  }

  const db = getDb();
  const msgId = uuidv4();

  // ── Compose the forwarded message body ─────────────────────
  // Three pieces, any of which may be empty:
  //   1. The user's typed caption (if any)
  //   2. Inlined text files (framed blocks ready for the model)
  //   3. A "[Other attachments ...]" footer listing everything we
  //      didn't deliver as bytes or inline text, gives the model
  //      enough info to say "I can't play that video" or similar.
  const bodyParts: string[] = [];
  if (cleanedText) {
    bodyParts.push(cleanedText);
  } else if (totalAttachmentCount > 0) {
    bodyParts.push(totalAttachmentCount === 1
      ? '(attached without a caption)'
      : `(${totalAttachmentCount} files attached without a caption)`);
  }

  if (attachmentResult.inlinedTextBlocks.length > 0) {
    bodyParts.push(attachmentResult.inlinedTextBlocks.join('\n\n'));
  }

  // Audio / video uploads need an inline pointer to the fileId
  // so the agent knows how to call transcribe_audio. The
  // attachment chips render in the dashboard regardless; this
  // is purely the agent-facing hint.
  const audioOrVideoUploads = attachmentResult.uploadedFiles.filter(
    (f) => f.category === 'audio' || f.category === 'video',
  );
  if (audioOrVideoUploads.length > 0) {
    const lines = audioOrVideoUploads.map((f) => {
      const label = f.category === 'audio' ? 'Audio' : 'Video';
      return (
        `[${label} attached: ${f.filename} (${f.size} bytes), fileId: ${f.fileId}]\n` +
        `To transcribe what was said, call transcribe_audio with attachment_id="${f.fileId}".`
      );
    });
    bodyParts.push(lines.join('\n\n'));
  }

  if (attachmentResult.mentionedAttachments.length > 0) {
    const lines = attachmentResult.mentionedAttachments.map(m =>
      `  • ${m.name} (${m.mimeType}, ${formatBytes(m.size)}) — ${m.reason}`,
    );
    bodyParts.push(
      `[Other attachments this model can't directly process — let the sender know if the format isn't supported]:\n${lines.join('\n')}`,
    );
  }

  const textForModel = bodyParts.join('\n\n');

  // ── Sender identity + sharing policy in the framing ──────────
  // Pre-fix the template hardcoded "FROM ${ownerName}" regardless
  // of who actually sent the message, so the agent literally could
  // not tell the wife's message from the user's. Now we look up
  // the matching safe-sender record and tell the agent exactly
  // who it is, who they are to the household (description), the
  // exact recipient string to pass back when replying, AND the
  // sharing policy that governs what's appropriate to disclose.
  const senderRecord = findSafeSenderByAddress(safeSenders, sender);
  // Avoid the "user@example.com (user@example.com)" duplication
  // when the user hasn't set a display name (legacy migration just
  // copied the address into the name slot).
  const senderLabel = senderRecord
    ? (senderRecord.name && senderRecord.name !== senderRecord.address
        ? `${senderRecord.name} (${senderRecord.address})`
        : senderRecord.address) +
      (senderRecord.description ? ` - ${senderRecord.description}` : '')
    : sender;
  const replyHint = senderRecord
    ? `To reply, call imessage_send with recipient="${senderRecord.address}" (or omit recipient and it defaults to this same person). Do NOT pass any other safe-sender's address - that would send to the wrong person.`
    : `To reply, call imessage_send with recipient="${sender}" (or omit recipient to reply to this same person automatically).`;
  const policyLine = senderRecord
    ? buildSharingPolicyLine(senderRecord, safeSenders)
    : `SHARING POLICY: Unknown sender - this address matched the bridge filter but isn't on the saved safe-sender list. Be cautious; share only what's directly asked. If in doubt, ask the primary user before responding.`;
  // Two discipline rules in the framing the agent reads every inbound:
  //
  //  - SHARING POLICY (above): governs what to share WITH the iMessage
  //    sender. Built from their sharing_level.
  //
  //  - UPDATING THE PRIMARY USER (below): governs whether/how to send
  //    a separate update to the primary user about this exchange
  //    AFTER you finish replying to the sender. Applies to BOTH
  //    channels - dashboard chat AND a separate imessage_send to
  //    the primary user's address. Default is silent (no update);
  //    only update if there's something specific the user must know
  //    or be asked, and lead with full context when you do. Without
  //    this, agents tend to drop cryptic one-liners like "Sent."
  //    or "Just the schedule, nothing else." that confuse the user
  //    because they don't see the iMessage thread on their end.
  const primary = safeSenders.find(s => s.is_primary);
  const primaryName = primary?.name?.trim() || 'the primary user';
  const exampleName = senderRecord?.name ?? 'Alex';
  const exampleRelationship = senderRecord?.description ? ` (${senderRecord.description})` : '';
  // RC-11: when the sender IS the primary user, the third-party
  // "updating the primary user" paragraph renders self-referential nonsense
  // ("<owner> does NOT see the iMessage thread between you and <owner>") and
  // its GOOD/BAD examples use third-party her/she pronouns. Branch on
  // is_primary: the owner texting directly needs neither the update-discipline
  // rule nor the ask-permission hatch, just one plain framing line. Every other
  // sender keeps the paragraph, with the hardcoded her/she fixed to they/them.
  const ownerSenderName = senderRecord?.name?.trim() || primaryName;
  const updateDiscipline = senderRecord?.is_primary
    ? `This is ${ownerSenderName}, your primary user, texting you directly via iMessage. Reply here; no separate update or permission is needed.`
    : `UPDATING THE PRIMARY USER: After you finish texting ${senderRecord?.name ?? 'this person'} back, do NOT send a separate update to ${primaryName} - NOT in the dashboard, and NOT as a separate iMessage to ${primaryName}'s address - UNLESS one of these is true: (a) you need to ASK ${primaryName} something to handle this conversation, or (b) there's specific information ${primaryName} genuinely needs to know. ${primaryName} does NOT see the iMessage thread between you and ${senderRecord?.name ?? 'this person'}; an unprompted "Sent." or "Standing by." or "Just the schedule, nothing else." reads as meaningless and confusing because they have no idea what you're referring to. If you DO send an update, ALWAYS lead with full context: who you were texting (name + relationship), what they asked you, and what you did or are waiting on. GOOD: "${exampleName}${exampleRelationship} just asked for your schedule this week - I sent them the calendar entries, no other personal details, and I'll let you know when they reply." BAD: "Sent. Just the schedule." Most iMessage exchanges should resolve silently from ${primaryName}'s perspective; only break that silence with real signal and real context.`;
  // v2.7.23, the giant `══ INBOUND IMESSAGE, MUST GO VIA imessage_send ══`
  // delivery header was removed. The engine now auto-routes the model's
  // terminal text back via iMessage (see reply-destination.ts), so the
  // model no longer needs to be told to call a tool, it just writes,
  // engine delivers. The remaining SOURCE tag below carries the policy
  // + sender identity. The per-turn `[Reply destination: ...]` line in
  // the assembled system prompt tells the model SMS voice is required.
  const msgContent = `[SOURCE: IMESSAGE FROM ${senderLabel} - this person texted YOUR OWN iMessage account (the DOJO bridge - YOUR phone, not the user's). The text arrived via iMessage, not the dashboard chat. ${policyLine} ${replyHint} ${updateDiscipline} Respond to THIS topic only; do not pull in unrelated dashboard conversation context.] ${textForModel}`;

  // Stamp structured inbound metadata (v3.1.x attribution redesign).
  // iMessage previously relied on the in-memory pendingIMResponseMap +
  // prose [SOURCE: ...] marker. We now ALSO record structured meta so
  // the origin projection can tell "the owner texting" from "a friend
  // texting" (is_primary). recipientAddress mirrors the raw `sender`
  // that pendingIMResponseMap + getInboundSenderFor use, so reply
  // routing is byte-identical, this only ADDS the relation signal.
  const inboundMetaObj = {
    channel: 'imessage' as const,
    accountKind: 'agent' as const,
    // comms-audit I-1: authorize ONLY when there is an actual safe-sender
    // record, matching email/SMS/Teams (unknown sender → authorized:false →
    // downgraded to a dashboard notice, never an auto-reply). The old hardcoded
    // `true` contradicted the relation below (which can be 'third_party' when
    // senderRecord is null), and let a sender that passed the loose bridge
    // pre-filter but has no record earn an auto-reply turn, an asymmetry no
    // other channel allows. Owner/known_contact both have a record, so they are
    // unaffected; only a true unknown is denied (invariant 5).
    authorized: !!senderRecord,
    sender,
    recipientAddress: sender,
    chatType: 'dm' as const,
    relation: (senderRecord?.is_primary
      ? 'owner'
      : senderRecord
        ? 'known_contact'
        : 'third_party') as 'owner' | 'known_contact' | 'third_party',
    // RC-4/RC-8: structured agent-ness of the sender, so downstream gates
    // (ack suppression, courtesy damping) branch on data, not description prose.
    senderIsAgent: !!senderRecord?.is_agent,
  };

  // ── Atomic persist (+ optional cursor advance) ──
  // INSERT + inbound_meta stamp (+ the poll loop cursor advance when a ROWID
  // is supplied) commit in ONE transaction on the same connection, so there is
  // no crash window in which the cursor is past a row that was never persisted.
  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, created_at)
      VALUES (?, ?, 'user', ?, ?, datetime('now'))
    `).run(
      msgId,
      primaryId,
      msgContent,
      attachmentResult.uploadedFiles.length > 0 ? JSON.stringify(attachmentResult.uploadedFiles) : null,
    );
    recordInboundMeta(msgId, inboundMetaObj);
    if (advanceRowId !== null) {
      db.prepare(`
        INSERT INTO config (key, value, updated_at) VALUES ('imessage_last_rowid', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
      `).run(String(advanceRowId), String(advanceRowId));
    }
  })();

  // Everything below is POST-COMMIT: the row is durable and (for the poll loop)
  // the cursor advanced, so a failure here must never look like a persist
  // failure to the caller (no retry/rollback).
  try {
    broadcast({
      type: 'chat:message',
      agentId: primaryId,
      message: {
        id: msgId,
        agentId: primaryId,
        role: 'user' as const,
        content: msgContent,
        // OPEN-13: carry the SAME structured inbound_meta into the live
        // broadcast that the DB row holds, so the central origin stamp
        // (ws.ts stampChatMessageOrigin) derives identical attribution
        // live and on HTTP refetch. Without it the live broadcast had no
        // inboundMeta and fell back to marker-parsing, so a live-rendered
        // iMessage bubble could disagree with the refetched one (some
        // inbound bubbles rendered, others didn't).
        inboundMeta: JSON.stringify(inboundMetaObj),
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt: new Date().toISOString(),
        // Include the uploaded attachments in the WS payload so the
        // dashboard can render thumbnails the moment the iMessage
        // arrives, without waiting for a page refresh to re-fetch.
        ...(attachmentResult.uploadedFiles.length > 0
          ? { attachments: attachmentResult.uploadedFiles }
          : {}),
      },
    });

    // RC-8 courtesy damping: a KNOWN AGENT sender volleying content-free
    // courtesy (a stock sign-off, or one of our own ack-pool lines bounced
    // back) must not wake a full turn, that is the machine-to-machine
    // pleasantry loop the iMessage lane has no terminal-intent structure to
    // stop. The inbound row is already persisted above (invariant untouched);
    // here we skip the dispatch entirely and drop a visible system marker so
    // the exchange is still legible in history. Human senders, and any agent
    // message that carries real content, are unaffected and fall through to
    // the normal wake path below.
    const dampCourtesy =
      wakeAgent &&
      !!senderRecord?.is_agent &&
      !!cleanedText &&
      isContentFreeCourtesy(cleanedText);

    if (dampCourtesy && senderRecord) {
      const markerId = uuidv4();
      const markerContent = `[Courtesy reply from ${senderRecord.name} received; no turn taken]`;
      try {
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
          VALUES (?, ?, 'system', ?, datetime('now'))
        `).run(markerId, primaryId, markerContent);
        broadcast({
          type: 'chat:message',
          agentId: primaryId,
          message: {
            id: markerId, agentId: primaryId, role: 'system' as const,
            content: markerContent,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
      } catch (markerErr) {
        logger.warn('Failed to persist courtesy-damping marker (non-fatal)', {
          error: markerErr instanceof Error ? markerErr.message : String(markerErr),
        });
      }
      logger.info('RC-8: damped content-free courtesy from agent sender (no turn taken)', {
        sender, name: senderRecord.name,
      });
    } else if (wakeAgent) {
      // Flag that the primary agent next response is sent back over iMessage
      // to this sender.
      pendingIMResponseMap.set(primaryId, { sender });
      // D10 busy-ack: if this message just queued behind a running turn older
      // than 60s, tell the sender once (deterministic engine send, never a
      // model turn). No-op when no turn is running (the probe path).
      try {
        maybeSendBusyAck(primaryId, sender);
      } catch (ackErr) {
        logger.warn('Busy-ack attempt failed (non-fatal)', {
          error: ackErr instanceof Error ? ackErr.message : String(ackErr),
        });
      }
      // D10 ingest/dispatch split: do NOT await the turn; the runtime
      // serializes per agent (activeRuns + pendingWakeups) and rows persist in
      // ROWID order before dispatch, mirroring how SMS / email / Teams dispatch.
      const runtime = getAgentRuntime();
      void runtime.handleMessage(primaryId, msgContent).catch(err => {
        logger.error('Failed to process iMessage in runtime', {
          error: err instanceof Error ? err.message : String(err),
        });
        clearIMResponseFlag(primaryId, sender);
      });
    }
  } catch (postErr) {
    logger.error('Post-persist broadcast/dispatch failed for inbound iMessage (row is persisted; re-drain will serve it)', {
      rowid: advanceRowId,
      error: postErr instanceof Error ? postErr.message : String(postErr),
    });
  }

  return { outcome: 'dispatched', reply: null, messageId: msgId };
}

async function pollMessages(): Promise<void> {
  if (approvedSenders.length === 0) return;
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    // Open the Messages database read-only
    const chatDb = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });

    try {
      // Build a query that matches ANY approved sender. No text filter -
      // image-only messages store U+FFFC in `text` and we want them through.
      // SQL LIKE is intentionally loose (`%address%`); we re-validate
      // each row against findSafeSenderByAddress below so substring false-
      // matches (e.g. group-chat synthetic IDs that happen to contain a
      // safe sender's digits) are dropped before reaching the agent.
      const placeholders = approvedSenders.map(() => 'c.chat_identifier LIKE ?').join(' OR ');
      const likeParams = approvedSenders.map(s => `%${s.address}%`);

      const messages = chatDb.prepare(`
        SELECT m.ROWID, m.text, m.is_from_me, m.date, m.cache_has_attachments, c.chat_identifier
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE m.ROWID > ?
          AND m.is_from_me = 0
          AND (${placeholders})
        ORDER BY m.ROWID ASC
        LIMIT 10
      `).all(lastSeenRowId, ...likeParams) as Array<{
        ROWID: number;
        text: string | null;
        is_from_me: number;
        date: number;
        cache_has_attachments: number;
        chat_identifier: string;
      }>;

      // ── D19 pt3: advance-after-persist ──
      // lastSeenRowId used to advance BEFORE the message INSERT, so a crash
      // in the read→persist window (which includes attachment copying and
      // HEIC conversion) permanently dropped that text from both stores.
      // Now a row's advance happens in exactly one of two places:
      //   (a) a deliberate skip path (non-safe-sender, empty reaction row,
      //       handled command, persist given up after bounded retries):
      //       advancePastRow, semantics unchanged from before; or
      //   (b) the persist path: inside the SAME SQLite transaction as the
      //       message INSERT, so persist + advance are atomic.
      // Crash windows, walked explicitly:
      //   1. Crash BEFORE the transaction commits: no message row, rowid not
      //      advanced. Next poll re-reads the same chat.db row. No loss, no
      //      duplicate.
      //   2. Crash AFTER the commit (before broadcast/dispatch): message row
      //      AND rowid are both durable, so the next poll does not re-read
      //      it; the persisted row sits waiting and the boot re-drain serves
      //      it (D19 pt1 reconciliation). No loss. There is no window in
      //      which the rowid is past an unpersisted message.
      //   3. Orphaned attachment copies from a crash mid-window are benign
      //      (re-poll re-copies under a fresh name).
      const advancePastRow = (rowId: number): void => {
        lastSeenRowId = rowId;
        saveLastSeenRowId(rowId);
        deferredAttachmentRetries.delete(rowId);
        persistRetries.delete(rowId);
      };

      for (const msg of messages) {
        // ── Offline-replay age floor ──
        // Skip (but permanently advance past) any row older than the floor so a
        // long-offline box does not auto-reply to stale texts on reconnect. Placed
        // BEFORE the attachment gate so a stale message never triggers attachment
        // copying either. When the age can't be determined (null), fall through and
        // process normally, dropping a real text is worse than a rare stale reply.
        const sentAtMs = appleMessageDateToUnixMs(msg.date);
        if (sentAtMs !== null && Date.now() - sentAtMs > IMESSAGE_MAX_REPLAY_AGE_MS) {
          logger.info('iMessage skipped, older than the offline-replay floor (advancing cursor past it)', {
            rowid: msg.ROWID,
            ageHours: Math.round((Date.now() - sentAtMs) / 3_600_000),
          });
          advancePastRow(msg.ROWID); // deliberate skip, advance so it is never re-read
          continue;
        }

        // ── Attachment-readiness gate ──
        // If chat.db claims this message has attachments but the files
        // aren't on disk yet (iCloud sync, slow download, etc.), defer
        // processing by breaking out of this poll cycle WITHOUT
        // advancing lastSeenRowId. The next poll will see the same
        // message again and retry. Bounded by MAX_ATTACHMENT_RETRIES so
        // a permanently-missing file can't block the bridge forever.
        if (msg.cache_has_attachments === 1) {
          const readiness = isMessageAttachmentReady(chatDb, msg.ROWID);
          if (!readiness.ready) {
            const retries = (deferredAttachmentRetries.get(msg.ROWID) ?? 0) + 1;
            if (retries < MAX_ATTACHMENT_RETRIES) {
              deferredAttachmentRetries.set(msg.ROWID, retries);
              logger.info('iMessage attachment not ready, deferring to next poll', {
                rowid: msg.ROWID,
                retry: retries,
                maxRetries: MAX_ATTACHMENT_RETRIES,
                reason: readiness.reason,
              });
              break; // stop processing this cycle, do NOT advance lastSeenRowId
            }
            // Give up and process the message without attachments so the
            // bridge doesn't get permanently stuck on a broken download.
            logger.warn('iMessage attachment never became ready, processing without it', {
              rowid: msg.ROWID,
              retriesAttempted: retries,
              reason: readiness.reason,
            });
            deferredAttachmentRetries.delete(msg.ROWID);
          }
        }

        const sender = msg.chat_identifier;
        const primaryId = getPrimaryAgentId();

        // Tighten the SQL LIKE filter: confirm the chat_identifier
        // actually matches a saved safe-sender record (addressesMatch is
        // stricter than SQL substring). Drops group-chat synthetic IDs
        // and substring false-matches.
        if (!findSafeSenderByAddress(approvedSenders, sender)) {
          logger.warn('iMessage dropped: chat_identifier matched SQL filter but no safe-sender record', {
            chatIdentifier: sender,
            rowid: msg.ROWID,
          });
          advancePastRow(msg.ROWID); // deliberate skip, advance as before
          continue;
        }

        // Sanitize text: strip U+FFFC attachment placeholders so we don't
        // forward control characters to the model.
        const cleanedText = stripAttachmentPlaceholder(msg.text);

        // Pull every attachment linked to this message. The helper classifies
        // each into one of three buckets: deliverable bytes (image/PDF,
        // copied to uploads dir), inlined text (small text files read into
        // memory), or mention-only metadata (video/audio/office/unknown ,
        // the model is told they exist so it can decide how to respond).
        const attachmentResult = fetchImessageAttachments(chatDb, msg.ROWID, primaryId);
        const totalAttachmentCount =
          attachmentResult.uploadedFiles.length +
          attachmentResult.inlinedTextBlocks.length +
          attachmentResult.mentionedAttachments.length;

        // Skip rows that are neither text nor any kind of attachment ,
        // these are reactions, typing indicators, etc.
        if (!cleanedText && totalAttachmentCount === 0) {
          logger.debug('iMessage skipped, no text and no attachments of any kind', {
            rowid: msg.ROWID,
          });
          advancePastRow(msg.ROWID); // deliberate skip, advance as before
          continue;
        }

        logger.info('iMessage received', {
          from: sender,
          text: cleanedText.slice(0, 100),
          uploaded: attachmentResult.uploadedFiles.length,
          inlined: attachmentResult.inlinedTextBlocks.length,
          mentioned: attachmentResult.mentionedAttachments.length,
        });

        // (v2.3.16) The dedicated `imessage:received` WS event was removed ,
        // it duplicated the `chat:message` broadcast at line ~574 below
        // (which the dashboard already renders) and the dashboard never
        // subscribed to the dedicated event. iMessage is a channel on the
        // primary agent's chat, not a separate stream.

        // Command intercept + fallthrough dispatch both run through the ONE
        // shared inbound processor the dev probe also drives, so the harness
        // verifies the exact path a real inbound traverses (no bypass seam).
        // The poll loop owns the chat.db cursor: it hands the ROWID for the
        // atomic advance and does persist-failure retries here.
        let inboundOutcome;
        try {
          inboundOutcome = await processInboundIMessage({
            sender,
            cleanedText,
            attachmentResult,
            advanceRowId: msg.ROWID,
            wakeAgent: true,
          });
        } catch (err) {
          // Persist failed: the message is NOT in the store and the durable
          // lastSeenRowId was NOT advanced (the transaction rolled back).
          // Retry this same row next poll, bounded so a permanently failing
          // row can not wedge the bridge forever. After the cap, advance past
          // it loudly (the pre-D19 behavior, made deliberate and bounded).
          const tries = (persistRetries.get(msg.ROWID) ?? 0) + 1;
          if (tries < MAX_PERSIST_RETRIES) {
            persistRetries.set(msg.ROWID, tries);
            logger.error('Failed to persist inbound iMessage, will retry next poll', {
              rowid: msg.ROWID,
              attempt: tries,
              maxRetries: MAX_PERSIST_RETRIES,
              error: err instanceof Error ? err.message : String(err),
            });
            break; // do not advance; re-read this row on the next poll
          }
          logger.error('Giving up on inbound iMessage after bounded persist retries, advancing past it', {
            rowid: msg.ROWID,
            attemptsMade: tries,
            error: err instanceof Error ? err.message : String(err),
          });
          advancePastRow(msg.ROWID);
          continue;
        }

        if (inboundOutcome.outcome === 'command') {
          // Command fully handled (reply already texted inside the processor);
          // advance past the row exactly as before.
          advancePastRow(msg.ROWID);
          continue;
        }

        // Dispatched: the processor transaction already advanced
        // imessage_last_rowid atomically with the INSERT. Sync the in-memory
        // cursor + clear the per-row retry counters, matching prior semantics.
        lastSeenRowId = msg.ROWID;
        deferredAttachmentRetries.delete(msg.ROWID);
        persistRetries.delete(msg.ROWID);
      }
    } finally {
      chatDb.close();
    }
  } catch (err) {
    // Silently handle if Messages database is not accessible
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('SQLITE_CANTOPEN') && !msg.includes('no such file')) {
      logger.error('iMessage polling error', { error: msg });
    }
  } finally {
    pollInFlight = false;
  }
}

export function startIMBridge(recipientId: string): void {
  if (pollTimer) {
    logger.warn('iMessage bridge already running');
    return;
  }

  // Load approved senders from config, falling back to legacy single recipient.
  // parseSafeSenders accepts both the legacy string[] shape and the new
  // SafeSender[] shape, so an install that hasn't yet re-saved Settings keeps
  // working with bare phone-string entries.
  const db = getDb();
  const sendersRow = db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
  approvedSenders = parseSafeSenders(sendersRow?.value ?? null);
  if (approvedSenders.length === 0) {
    approvedSenders = [{
      address: recipientId,
      name: recipientId,
      description: undefined,
      is_primary: true,
      sharing_level: 'open_book',
    }];
  }

  lastSeenRowId = loadLastSeenRowId();

  // If no stored lastSeenRowId (first run or reset), seed from the current max ROWID
  // so we only process messages received AFTER the bridge starts, not the entire history
  if (lastSeenRowId === 0) {
    try {
      const chatDb = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
      try {
        const maxRow = chatDb.prepare('SELECT MAX(ROWID) as maxId FROM message').get() as { maxId: number | null } | undefined;
        if (maxRow?.maxId) {
          lastSeenRowId = maxRow.maxId;
          saveLastSeenRowId(lastSeenRowId);
          logger.info('Seeded lastSeenRowId from Messages DB (first run)', { lastSeenRowId });
        }
      } finally {
        chatDb.close();
      }
    } catch (err) {
      // If we can't read chat.db, leave at 0, pollMessages will handle the error gracefully
      logger.warn('Could not seed lastSeenRowId from Messages DB', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Starting iMessage bridge', { approvedSenders, lastSeenRowId });

  // Start polling
  pollTimer = setInterval(() => {
    pollMessages().catch(err => {
      logger.error('iMessage poll cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POLL_INTERVAL_MS);

  // Initial poll
  pollMessages().catch(() => {});
}

export function stopIMBridge(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    approvedSenders = [];
    logger.info('iMessage bridge stopped');
  }
}

/**
 * Re-read imessage_approved_senders from the config table into the bridge's
 * in-memory list. The poll loop matches only against this list, so adding a
 * second sender via the dashboard would otherwise sit in the DB while the
 * bridge keeps querying for the original sender only, incoming messages
 * from the new sender arrive in Messages but never reach the agent.
 *
 * Called from PUT /settings/:key whenever imessage_approved_senders changes.
 * No-op if the bridge isn't currently running (startIMBridge will load the
 * fresh list on its own when iMessage is re-enabled).
 */
export function reloadApprovedSenders(): void {
  if (!pollTimer) return;
  const db = getDb();
  const sendersRow = db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
  const parsed = parseSafeSenders(sendersRow?.value ?? null);
  if (parsed.length > 0) {
    approvedSenders = parsed;
    logger.info('Reloaded approved senders from config', {
      count: approvedSenders.length,
      addresses: approvedSenders.map(s => s.address),
    });
    return;
  }
  logger.warn('reloadApprovedSenders called but config key empty/invalid - leaving in-memory list unchanged');
}

// ── iMessage sending via imsg CLI ──────────────────────────────────────
//
// All iMessage sending uses the `imsg` CLI (github.com/steipete/imsg).
// imsg is installed automatically by the dojo installer (install.sh)
// and handles text, file attachments, phone number normalization, and
// service detection reliably across all macOS versions.
//
// If imsg isn't available (shouldn't happen after a proper install),
// falls back to raw AppleScript for text-only messages. File
// attachments require imsg, AppleScript's POSIX file handling is
// broken on newer macOS.

function findImsg(): string | null {
  for (const p of ['/opt/homebrew/bin/imsg', '/usr/local/bin/imsg', `${os.homedir()}/.dojo/bin/imsg`]) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* continue */ }
  }
  try {
    execSync('which imsg', { encoding: 'utf-8', stdio: 'pipe' });
    return 'imsg';
  } catch {
    return null;
  }
}

let imsgPathCached: string | null | undefined = undefined;
function getImsgPath(): string | null {
  if (imsgPathCached === undefined) imsgPathCached = findImsg();
  return imsgPathCached;
}

// AppleScript fallback for text-only, used only when imsg isn't installed
function sendIMessageViaAppleScript(recipient: string, text: string): void {
  const escapedRecipient = recipient.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // Escape for AppleScript double-quoted strings: backslashes and double quotes.
  // Newlines can't appear inside AppleScript string literals, so we break the
  // literal and concatenate using the linefeed character constant instead.
  const escapedText = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '" & (ASCII character 10) & "');

  // Select the iMessage service POSITIONALLY, not via `1st service whose
  // service type = iMessage`. That filtered ("whose") reference throws
  // AppleScript error -10002 ("Invalid key form") on macOS 26/Sequoia, breaking
  // the engine's text fallback. Iterating `services` element-by-element and
  // checking each one's type avoids the bad key form; if none reports the
  // iMessage type, fall back to `item 1 of services` (the generic positional
  // reference confirmed working on Sequoia).
  const script = `
    tell application "Messages"
      set targetService to missing value
      repeat with s in services
        try
          if (service type of s) is iMessage then
            set targetService to s
            exit repeat
          end if
        end try
      end repeat
      if targetService is missing value then set targetService to item 1 of services
      set targetBuddy to buddy "${escapedRecipient}" of targetService
      send "${escapedText}" to targetBuddy
    end tell
  `;
  execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
    timeout: 10000,
    encoding: 'utf-8',
  });
}

// v2.3.19, returns true if the send actually succeeded, false if every
// path failed (imsg CLI errored, AppleScript denied, etc.). Pre-spec
// this returned void and silently swallowed failures, which left
// imessage_send callers reporting "sent" to the agent (and thus to the
// user) when nothing actually went through.
export function sendIMessage(recipient: string, rawText: string): boolean {
  // Sanitize for iMessage, strip markdown, literal \n, excessive whitespace.
  // This runs on ALL iMessage paths so nothing gets through unsanitized.
  let text = rawText;
  text = text.replace(/\\n/g, '\n');               // literal \n → real newline
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');     // **bold** → bold
  text = text.replace(/\*(.+?)\*/g, '$1');          // *italic* → italic
  text = text.replace(/`([^`]+)`/g, '$1');          // `code` → code
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').trim()); // code blocks
  text = text.replace(/^#{1,6}\s+/gm, '');          // # headers → plain
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // [text](url) → text
  text = text.replace(/\n{3,}/g, '\n\n');           // collapse excessive newlines
  text = text.trim();

  try {
    const imsg = getImsgPath();
    let via: 'imsg' | 'applescript' = 'applescript';
    if (imsg) {
      try {
        // Use execFileSync (not execSync) so the text is passed as a raw argument,
        // bypassing the shell entirely. execSync builds a shell command string where
        // $100 becomes a variable expansion (→ "00") and JSON-escaped \n sequences
        // are passed literally instead of as real newlines.
        execFileSync(
          imsg,
          ['send', '--to', recipient, '--text', text, '--service', 'imessage'],
          { timeout: 15000, encoding: 'utf-8', stdio: 'pipe' },
        );
        via = 'imsg';
      } catch (imsgErr) {
        // imsg is present but FAILED, e.g. imsg v0.11.1 installed as a raw
        // binary crashes with SIGTRAP because its compiled
        // PhoneNumberKit_PhoneNumberKit.bundle didn't ship alongside it. Text
        // delivery doesn't need imsg, so fall back to AppleScript instead of
        // dropping the message. (Attachments still require imsg, see
        // sendIMessageWithAttachment.)
        logger.warn('imsg send failed, falling back to AppleScript', {
          recipient,
          error: imsgErr instanceof Error ? imsgErr.message : String(imsgErr),
        });
        sendIMessageViaAppleScript(recipient, text);
        via = 'applescript';
      }
    } else {
      sendIMessageViaAppleScript(recipient, text);
    }

    logger.info('iMessage sent', { recipient, textLength: text.length, via });
    // (v2.3.16) Dropped dedicated `imessage:sent` WS broadcast, the
    // dashboard sees outbound delivery via the [SENT VIA IMESSAGE to <owner>]
    // system marker that the loop persists in the chat stream.
    return true;
  } catch (err) {
    logger.error('Failed to send iMessage', {
      error: err instanceof Error ? err.message : String(err),
      recipient,
    });
    return false;
  }
}

/**
 * Send a single file attachment via iMessage with an optional text caption.
 * Requires the imsg CLI. Returns true on success, false on any failure
 * (caller can decide how to report, internal helpers use this directly,
 * the agent-facing imessage_send tool uses sendIMessageWithAttachments).
 */
export function sendIMessageWithAttachment(
  recipient: string,
  filePath: string,
  caption?: string,
): boolean {
  // C14: safe-sender revalidation, a sender removed from the allowlist mid-conversation
  // must not still receive FILES while their text reply is correctly suppressed (inv-5
  // asymmetry). Mirrors sendResponseViaIMessage's recipient check. (Capturing attachment
  // sends in test mode, "never really text a real address during a harness test", is
  // injected by the local test harness as a patch, NOT baked into base source, so this
  // file ships with no harness dependency.)
  if (!findSafeSenderByAddress(getSafeSenders(), recipient)) {
    logger.warn('Attachment send suppressed: recipient not on safe-sender list', { recipient });
    return false;
  }
  const imsg = getImsgPath();

  if (!imsg) {
    logger.warn('imsg CLI not found - cannot send file attachment. Install via: git clone https://github.com/steipete/imsg.git && cd imsg && make build && sudo cp bin/imsg /usr/local/bin/');
    return false;
  }

  try {
    const args = ['send', '--to', recipient];
    if (caption) args.push('--text', caption);
    args.push('--file', filePath, '--service', 'imessage');
    execFileSync(imsg, args, { timeout: 30000, encoding: 'utf-8', stdio: 'pipe' });
    logger.info('iMessage attachment sent', { recipient, filePath, hasCaption: Boolean(caption) });
    return true;
  } catch (err) {
    logger.error('imsg attachment send failed', {
      error: err instanceof Error ? err.message : String(err),
      recipient,
      filePath,
    });
    return false;
  }
}

/**
 * Send a text message plus zero or more file attachments. The caption rides
 * with the first file (iMessage shows it as a single bubble + thumbnail).
 * Additional files go in separate bubbles. Returns { ok, sent, failed } so
 * the caller can report partial-success without misleading the user.
 *
 * If `filePaths` is empty, this is equivalent to sendIMessage(recipient, text).
 */
export function sendIMessageWithAttachments(
  recipient: string,
  text: string,
  filePaths: readonly string[],
): { ok: boolean; sentFiles: string[]; failedFiles: string[]; textSent: boolean } {
  if (filePaths.length === 0) {
    const ok = sendIMessage(recipient, text);
    return { ok, sentFiles: [], failedFiles: [], textSent: ok };
  }

  // Verify every file exists before we start sending. Refusing up front beats
  // a half-delivered message where some attachments arrived and one didn't.
  for (const p of filePaths) {
    if (!fs.existsSync(p)) {
      logger.error('iMessage attachment file missing - aborting send', { path: p });
      return { ok: false, sentFiles: [], failedFiles: [p], textSent: false };
    }
  }

  // First file carries the caption; subsequent files go bare.
  const sentFiles: string[] = [];
  const failedFiles: string[] = [];
  let textSent = false;

  for (let i = 0; i < filePaths.length; i++) {
    const caption = i === 0 && text.trim() ? text : undefined;
    const ok = sendIMessageWithAttachment(recipient, filePaths[i], caption);
    if (ok) {
      sentFiles.push(filePaths[i]);
      if (i === 0 && caption) textSent = true;
    } else {
      failedFiles.push(filePaths[i]);
    }
  }

  // If the first file failed AND the caption didn't ride with anything else,
  // make one more attempt to deliver the text on its own so the recipient at
  // least gets the message body even though attachments didn't.
  if (!textSent && text.trim()) {
    const ok = sendIMessage(recipient, text);
    if (ok) textSent = true;
  }

  return { ok: failedFiles.length === 0, sentFiles, failedFiles, textSent };
}

// ── Alert & Sender Helpers ──

/**
 * Return the full safe-sender records, loading from config if the bridge
 * isn't currently running. Always parsed through parseSafeSenders so callers
 * never see the legacy string[] shape.
 */
export function getSafeSenders(): SafeSender[] {
  if (approvedSenders.length > 0) return approvedSenders.map(s => ({ ...s }));
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
    return parseSafeSenders(row?.value ?? null);
  } catch {
    return [];
  }
}

/**
 * Primary user's address (the "starred" sender). The is_primary flag on the
 * record is now authoritative; the legacy imessage_default_sender config key
 * is consulted only as a fallback for installs that haven't re-saved Settings.
 */
export function getDefaultSender(): string | null {
  const records = getSafeSenders();
  const primary = records.find(s => s.is_primary);
  if (primary) return primary.address;

  // Legacy fallback while older installs migrate.
  const legacy = readLegacyDefaultSender();
  if (legacy) return legacy;

  return records.length > 0 ? records[0].address : null;
}

/**
 * Address-only view, kept for callers that just need the allowlist. New code
 * should prefer getSafeSenders() so it can read names/descriptions too.
 */
export function getApprovedSenders(): string[] {
  return getSafeSenders().map(s => s.address);
}

export function sendAlert(message: string, urgency: 'info' | 'warning' | 'critical' | 'notice'): void {
  try {
    // v2.3.19 (error-handling-spec Phase 5), only CRITICAL alerts go
    // to iMessage. User feedback: "I only want true blockers or true
    // issues the user needs to be aware of to go to imessage." Warning
    // and info still get logged (and broadcast to the dashboard
    // separately via chat:error / Vitals), they just don't ping the
    // phone. If a caller is wrong-severity, fix it at the call site ,
    // don't override here.
    //
    // v2.5.7, added 'notice' for friendly status announcements that
    // SHOULD go to iMessage but DON'T deserve the scary "[CRITICAL]"
    // prefix (e.g. "Dojo is online at <url>"). Routes to iMessage same
    // as critical, but with no urgency tag prepended.
    const scrubbed = scrubTechnicalDetail(message);

    if (urgency !== 'critical' && urgency !== 'notice') {
      logger.info('Alert suppressed from iMessage (non-critical/non-notice)', {
        urgency,
        message: scrubbed.slice(0, 200),
      });
      return;
    }

    const fullMessage = urgency === 'critical' ? `[CRITICAL] ${scrubbed}` : scrubbed;
    logger.info(`Sending ${urgency} alert to iMessage`, {
      message: scrubbed.slice(0, 200),
    });

    const recipient = getDefaultSender();
    if (!recipient) {
      logger.warn('Cannot send alert: no default sender configured');
      return;
    }
    sendIMessage(recipient, fullMessage);
  } catch (err) {
    logger.error('Failed to send alert', {
      error: err instanceof Error ? err.message : String(err),
      urgency,
    });
  }
}

export function isIMBridgeRunning(): boolean {
  return pollTimer !== null;
}

export function getIMBridgeStatus(): {
  running: boolean;
  enabled: boolean;
  connected: boolean;
  approvedSenders: string[];
  safeSenders: SafeSender[];
  lastSeenRowId: number;
} {
  const running = pollTimer !== null;
  const records = getSafeSenders();
  const hasSenders = records.length > 0;
  return {
    running,
    enabled: hasSenders || running,
    connected: running,
    approvedSenders: records.map(s => s.address),
    safeSenders: records,
    lastSeenRowId,
  };
}
