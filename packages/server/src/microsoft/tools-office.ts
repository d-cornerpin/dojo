// ════════════════════════════════════════
// Microsoft Office Document Generation Tools
// Creates Word, Excel, PowerPoint files and uploads to OneDrive
// ════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '../agent/tools.js';
import { getValidAccessToken } from './auth.js';
import { logMicrosoftActivity } from './activity-log.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import JSZip from 'jszip';

const logger = createLogger('office-tools');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ─────────────────────────────────────────
// v2.5.10 — Shared edit helpers
//
// .docx and .pptx are ZIP archives containing XML files. To edit in place:
//   1. Download bytes
//   2. Unzip with JSZip
//   3. Modify the relevant XML files
//   4. Re-zip
//   5. PUT back to the same OneDrive path (preserves the file_id → existing
//      share links stay alive)
//
// For .xlsx we use the Microsoft Graph Workbook API instead, which supports
// true in-place cell editing via REST — no download-modify-upload needed.
// ─────────────────────────────────────────

async function downloadFileBytes(fileId: string): Promise<Buffer> {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Not authenticated with Microsoft');
  const resp = await fetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/content`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

async function getFileMeta(fileId: string): Promise<{ name: string; parentId?: string }> {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Not authenticated with Microsoft');
  const resp = await fetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}?$select=name,parentReference`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Meta fetch failed: HTTP ${resp.status}`);
  const data = await resp.json() as { name: string; parentReference?: { id?: string } };
  return { name: data.name, parentId: data.parentReference?.id };
}

// The Word edit tools were built around OneDrive file_ids (download → edit the
// document.xml → upload back). But on a local-only setup (Microsoft not
// connected) documents live on disk under ~/.dojo/uploads/<agent>/ and there is
// NO file_id — so the edit tools were unusable and the agent had to regenerate
// the whole doc on every change. This resolver lets the SAME edit handlers run
// against a LOCAL .docx: pass `path` (or pass the absolute path as `file_id` —
// models conflate the two) and the read/write ends become plain disk I/O. The
// in-between XML manipulation is identical, so every edit op works locally.
interface OfficeEditTarget {
  isLocal: boolean;
  name: string;
  /** What to pass back to edit this file again — a local path or a file_id. */
  handle: string;
  read(): Promise<Buffer>;
  writeBack(buf: Buffer, mimeType: string): Promise<{ name: string; ref: string; localPath?: string }>;
}

async function resolveOfficeEditTarget(
  args: Record<string, unknown>,
  ext: '.docx' | '.xlsx',
): Promise<OfficeEditTarget | string> {
  const explicitPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
  const fileId = typeof args.file_id === 'string' && args.file_id.trim() ? args.file_id.trim() : undefined;
  // A file_id that's actually a filesystem path (starts with / or ~) is local.
  const pathLike = explicitPath ?? (fileId && (fileId.startsWith('/') || fileId.startsWith('~')) ? fileId : undefined);

  if (pathLike) {
    const abs = pathLike.startsWith('~') ? path.join(os.homedir(), pathLike.slice(1)) : pathLike;
    if (!fs.existsSync(abs)) {
      return `Error: no file found at ${abs}. Create it first (e.g. office_create_word_document), or pass the exact path the create tool returned.`;
    }
    if (path.extname(abs).toLowerCase() !== ext) {
      return `Error: ${abs} is not a ${ext} file.`;
    }
    return {
      isLocal: true,
      name: path.basename(abs),
      handle: abs,
      read: async () => fs.readFileSync(abs),
      writeBack: async (buf) => { fs.writeFileSync(abs, buf); return { name: path.basename(abs), ref: `Saved to ${abs}.`, localPath: abs }; },
    };
  }

  if (fileId) {
    const meta = await getFileMeta(fileId);
    return {
      isLocal: false,
      name: meta.name,
      handle: fileId,
      read: async () => downloadFileBytes(fileId),
      writeBack: async (buf, mimeType) => {
        const r = await uploadToOneDrive(buf, meta.name, mimeType, meta.parentId);
        return { name: r.name, ref: `File ID: ${r.id}\nOpen: ${r.webUrl}` };
      },
    };
  }

  return 'Error: provide `path` (a local .docx on disk) or `file_id` (a OneDrive .docx) to edit.';
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ── Local Excel (.xlsx) editing via ExcelJS ──
// The Excel edit tools (read/write range, append rows, add/delete sheet) were
// Graph-only. On a local-only setup they now read → modify → write the workbook
// on disk with ExcelJS (the same lib office_create_spreadsheet uses). Each
// handler checks for a local path first; otherwise the existing Graph path runs.
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function localXlsxPath(args: Record<string, unknown>): string | null {
  const explicit = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
  const fid = typeof args.file_id === 'string' ? args.file_id.trim() : undefined;
  const p = explicit ?? (fid && (fid.startsWith('/') || fid.startsWith('~')) ? fid : undefined);
  if (!p) return null;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadLocalWorkbook(absPath: string): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExcelJSMod: any = await (Function('return import("exceljs")')());
  const ExcelJS = ExcelJSMod.default ?? ExcelJSMod;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync(absPath));
  return wb;
}

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n; // 1-based
}

// Parse "A1", "A1:C3", "$B$2:$B$10" → 1-based inclusive bounds.
function parseA1Range(range: string): { startRow: number; startCol: number; endRow: number; endCol: number } | null {
  const m = range.replace(/\$/g, '').match(/^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/);
  if (!m) return null;
  const c1 = colLettersToIndex(m[1]);
  const r1 = parseInt(m[2], 10);
  const c2 = m[3] ? colLettersToIndex(m[3]) : c1;
  const r2 = m[4] ? parseInt(m[4], 10) : r1;
  return { startRow: Math.min(r1, r2), startCol: Math.min(c1, c2), endRow: Math.max(r1, r2), endCol: Math.max(c1, c2) };
}

// ExcelJS cell.value can be a formula object {formula,result}, a date, rich
// text, or a hyperlink. Reduce to a plain JSON-friendly value for read results.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function plainCellValue(cell: any): unknown {
  const v = cell?.value;
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('result' in v) return (v as { result?: unknown }).result ?? null;
    if ('richText' in v || 'hyperlink' in v) return cell.text;
    if ('text' in v) return (v as { text?: unknown }).text;
  }
  return v;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveLocalSheet(wb: any, sheetName?: string): any {
  if (sheetName) return wb.getWorksheet(sheetName);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return wb.worksheets.find((w: any) => w.state !== 'hidden') ?? wb.worksheets[0];
}

/**
 * Extract the inner content of `<w:body>` from a Word document's document.xml.
 * Returns the prefix (everything before body open), body inner XML, and the
 * suffix (closing tag + sectPr + closing document). Used so we can splice
 * paragraphs into the existing document without disturbing section properties
 * (page size, margins, headers/footers) that live in sectPr at the body end.
 */
function splitDocumentXml(documentXml: string): { prefix: string; bodyInner: string; suffix: string } {
  const bodyOpenMatch = documentXml.match(/<w:body[^>]*>/);
  const bodyCloseIdx = documentXml.lastIndexOf('</w:body>');
  if (!bodyOpenMatch || bodyCloseIdx === -1) {
    throw new Error('Malformed document.xml: missing <w:body> markers');
  }
  const bodyOpenEnd = bodyOpenMatch.index! + bodyOpenMatch[0].length;
  // Section properties (sectPr) live as the LAST child of body. Preserve them
  // by treating from the first sectPr we find at end-of-body forward as suffix.
  // Tolerant of presence/absence of sectPr.
  const sectPrMatch = documentXml.slice(bodyOpenEnd, bodyCloseIdx).match(/<w:sectPr\b[\s\S]*$/);
  const bodyInnerEnd = sectPrMatch ? bodyOpenEnd + sectPrMatch.index! : bodyCloseIdx;
  return {
    prefix: documentXml.slice(0, bodyOpenEnd),
    bodyInner: documentXml.slice(bodyOpenEnd, bodyInnerEnd),
    suffix: documentXml.slice(bodyInnerEnd),
  };
}

/**
 * Split the body inner XML into a list of top-level block tokens.
 * In OOXML, body children are <w:p> (paragraphs), <w:tbl> (tables), or
 * <w:sectPr> (which we've already extracted). Returns the raw XML strings.
 */
function parseBodyBlocks(bodyInner: string): string[] {
  const blocks: string[] = [];
  let i = 0;
  while (i < bodyInner.length) {
    // Skip whitespace between blocks
    const wsMatch = bodyInner.slice(i).match(/^\s+/);
    if (wsMatch) { i += wsMatch[0].length; continue; }
    // Match the next block element
    const openMatch = bodyInner.slice(i).match(/^<(w:p|w:tbl)\b/);
    if (!openMatch) break;
    const tag = openMatch[1];
    // Find the matching close tag (non-nested for paragraphs; tables don't nest at top level)
    const closeMarker = `</${tag}>`;
    const closeIdx = bodyInner.indexOf(closeMarker, i);
    if (closeIdx === -1) break;
    const end = closeIdx + closeMarker.length;
    blocks.push(bodyInner.slice(i, end));
    i = end;
  }
  return blocks;
}

/**
 * Extract a short text preview from a `<w:p>` paragraph block. Concatenates
 * all <w:t> text runs. Returns empty string if the block has no text.
 */
function paragraphPreview(blockXml: string): { text: string; isHeading: boolean; level?: number } {
  // Match all <w:t>...</w:t> contents (handles xml:space="preserve" too)
  const texts: string[] = [];
  const textRe = /<w:t[^>]*>([^<]*)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = textRe.exec(blockXml)) !== null) texts.push(m[1]);
  const text = texts.join('').trim();
  // Detect heading via pStyle. Headings use Heading1/Heading2/Heading3.
  const headingMatch = blockXml.match(/<w:pStyle w:val="Heading(\d)"\/?>/);
  return {
    text,
    isHeading: !!headingMatch,
    level: headingMatch ? parseInt(headingMatch[1], 10) : undefined,
  };
}

/**
 * v2.5.13 — Extract the full text from a `<w:tbl>` table block.
 * Walks rows (`<w:tr>`) and cells (`<w:tc>`); within each cell, joins all
 * `<w:t>` text runs. Returns rows as a 2D array of strings. Used by
 * office_read_word_document so agents can actually see table contents.
 */
function extractTableText(blockXml: string): string[][] {
  const rows: string[][] = [];
  const rowRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
  let rowM: RegExpExecArray | null;
  while ((rowM = rowRe.exec(blockXml)) !== null) {
    const rowInner = rowM[1];
    const cells: string[] = [];
    const cellRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
    let cellM: RegExpExecArray | null;
    while ((cellM = cellRe.exec(rowInner)) !== null) {
      const cellInner = cellM[1];
      const texts: string[] = [];
      const tRe = /<w:t[^>]*>([^<]*)<\/w:t>/g;
      let tM: RegExpExecArray | null;
      while ((tM = tRe.exec(cellInner)) !== null) texts.push(tM[1]);
      cells.push(texts.join('').trim());
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * v2.5.13 — Extract slide text from a slide XML, separated into title and
 * body. Title is the first text shape with a placeholder type of ctrTitle
 * or title; body is everything else. Used by office_read_presentation.
 */
function extractSlideText(slideXml: string): { title: string; body: string[] } {
  // Title shape: find a <p:sp> shape that contains a placeholder of type
  // ctrTitle or title. Use \b after `sp` so we don't accidentally match
  // <p:spTree> (a wrapper element, not a shape).
  const titleSpMatch = slideXml.match(/<p:sp\b[^>]*>[\s\S]*?<p:ph[^>]*type="(?:ctrTitle|title)"[^>]*\/?>([\s\S]*?)<\/p:sp>/);
  const titleScope = titleSpMatch ? titleSpMatch[0] : '';
  const titleTexts: string[] = [];
  if (titleScope) {
    const re = /<a:t[^>]*>([^<]*)<\/a:t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(titleScope)) !== null) titleTexts.push(m[1]);
  }
  const title = titleTexts.join('').trim();
  // Body: walk each shape, extract its text. Skip the title shape if found.
  const body: string[] = [];
  const spRe = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g;
  let spM: RegExpExecArray | null;
  while ((spM = spRe.exec(slideXml)) !== null) {
    const spXml = spM[0];
    if (titleSpMatch && spXml === titleSpMatch[0]) continue;
    // For body, extract paragraphs (<a:p>) so each line becomes its own entry.
    const paraRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
    let paraM: RegExpExecArray | null;
    while ((paraM = paraRe.exec(spXml)) !== null) {
      const paraInner = paraM[1];
      const texts: string[] = [];
      const tRe = /<a:t[^>]*>([^<]*)<\/a:t>/g;
      let tM: RegExpExecArray | null;
      while ((tM = tRe.exec(paraInner)) !== null) texts.push(tM[1]);
      const line = texts.join('').trim();
      if (line) body.push(line);
    }
  }
  return { title, body };
}

/**
 * Generate the body-inner XML for a list of content blocks by using the
 * existing docx generator to produce a temporary document, then extracting
 * just the inner body from it. Reuses generateWordBuffer's logic so all the
 * existing block types (heading/paragraph/table/bullet_list/page_break) are
 * supported here for inserts/appends without reimplementing OOXML.
 */
async function blocksToBodyInnerXml(blocks: ContentBlock[]): Promise<string> {
  const buf = await generateWordBuffer(blocks);
  const zip = await JSZip.loadAsync(buf);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('Generated docx is missing word/document.xml');
  const xml = await docFile.async('string');
  const { bodyInner } = splitDocumentXml(xml);
  return bodyInner;
}

/**
 * Open a .docx buffer, rewrite document.xml with the provided string, return
 * the repacked buffer. Preserves all other parts of the archive (styles,
 * headers, footers, images, etc.).
 */
async function rewriteDocumentXml(buffer: Buffer, newDocumentXml: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  zip.file('word/document.xml', newDocumentXml);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

/**
 * Convert a zero-based column index to A1-style letter (0=A, 25=Z, 26=AA, …).
 * Used by office_append_spreadsheet_rows to compute the target range from
 * the appended-row dimensions.
 */
function columnIndexToLetter(idx: number): string {
  let result = '';
  let n = idx;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

/**
 * Escape a string for safe insertion into XML attribute or text content.
 */
function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Replace text inside <w:t> elements throughout the document. Find/replace
 * operates on the concatenated text of each <w:t> element individually —
 * this means it works when the find string is contained entirely within one
 * text run (the common case for short phrases), but cannot match text that
 * spans formatting boundaries (e.g. "hello **world**" stored as two runs).
 *
 * Returns { newXml, replacements } so the caller can report how many
 * substitutions happened.
 */
function replaceTextInDocumentXml(documentXml: string, find: string, replaceWith: string): { newXml: string; replacements: number } {
  if (!find) return { newXml: documentXml, replacements: 0 };
  let replacements = 0;
  const escapedFind = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedReplace = xmlEscape(replaceWith);
  // Match <w:t>...</w:t> (and <w:t xml:space="preserve">) bodies and replace inside.
  const newXml = documentXml.replace(/<w:t([^>]*)>([^<]*)<\/w:t>/g, (_full, attrs, inner) => {
    const replaced = inner.replace(new RegExp(escapedFind, 'g'), () => { replacements++; return escapedReplace; });
    return `<w:t${attrs}>${replaced}</w:t>`;
  });
  return { newXml, replacements };
}

/**
 * v2.5.10 — PowerPoint find/replace. The pptx XML uses DrawingML, so the
 * text-bearing element is <a:t> not <w:t>. Same single-run limitation.
 */
function replaceTextInSlideXml(slideXml: string, find: string, replaceWith: string): { newXml: string; replacements: number } {
  if (!find) return { newXml: slideXml, replacements: 0 };
  let replacements = 0;
  const escapedFind = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedReplace = xmlEscape(replaceWith);
  const newXml = slideXml.replace(/<a:t([^>]*)>([^<]*)<\/a:t>/g, (_full, attrs, inner) => {
    const replaced = inner.replace(new RegExp(escapedFind, 'g'), () => { replacements++; return escapedReplace; });
    return `<a:t${attrs}>${replaced}</a:t>`;
  });
  return { newXml, replacements };
}

/**
 * Get the ordered list of slide XML file names from a loaded pptx zip.
 * Reads ppt/_rels/presentation.xml.rels for the relationship → file map,
 * then reads ppt/presentation.xml for the actual slide order.
 */
async function getSlideOrder(zip: JSZip): Promise<Array<{ rId: string; file: string }>> {
  const relsFile = zip.file('ppt/_rels/presentation.xml.rels');
  const presFile = zip.file('ppt/presentation.xml');
  if (!relsFile || !presFile) throw new Error('Malformed pptx: missing presentation.xml or its rels');
  const relsXml = await relsFile.async('string');
  const presXml = await presFile.async('string');

  // Build rId → target map for relationships that point at slides
  const relMap = new Map<string, string>();
  const relRe = /<Relationship\s+([^>]*?)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(relsXml)) !== null) {
    const attrs = m[1];
    const idMatch = attrs.match(/Id="([^"]+)"/);
    const typeMatch = attrs.match(/Type="([^"]+)"/);
    const targetMatch = attrs.match(/Target="([^"]+)"/);
    if (idMatch && typeMatch && targetMatch && typeMatch[1].endsWith('/slide')) {
      relMap.set(idMatch[1], targetMatch[1]);
    }
  }
  // Read order from <p:sldIdLst><p:sldId r:id="rIdN"/>…</p:sldIdLst>
  const order: Array<{ rId: string; file: string }> = [];
  const slideIdRe = /<p:sldId[^>]*\sr:id="([^"]+)"[^>]*\/?>/g;
  while ((m = slideIdRe.exec(presXml)) !== null) {
    const rId = m[1];
    const target = relMap.get(rId);
    if (target) {
      // Target is relative to ppt/, e.g. "slides/slide1.xml" → "ppt/slides/slide1.xml"
      const file = target.startsWith('/') ? target.slice(1) : `ppt/${target}`;
      order.push({ rId, file });
    }
  }
  return order;
}

/**
 * Read a slide's title from its XML. Looks for the first <a:t> inside a
 * shape with placeholder type "title" or "ctrTitle"; falls back to the
 * first <a:t> anywhere in the slide.
 */
function slideTitleFromXml(slideXml: string): string {
  // Try to find a title placeholder shape first.
  // v2.5.13 — \b after `sp` to prevent matching <p:spTree> (the wrapper).
  const titleSpMatch = slideXml.match(/<p:sp\b[^>]*>[\s\S]*?<p:ph[^>]*type="(?:ctrTitle|title)"[^>]*\/?>([\s\S]*?)<\/p:sp>/);
  const searchScope = titleSpMatch ? titleSpMatch[0] : slideXml;
  const texts: string[] = [];
  const re = /<a:t[^>]*>([^<]*)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(searchScope)) !== null) texts.push(m[1]);
  return texts.join('').trim();
}

// ── Tool Definitions ──

export const officeToolDefinitions: ToolDefinition[] = [
  {
    name: 'office_create_word_document',
    description: 'Create a Word document (.docx) with formatted content. When Microsoft is connected, the file uploads to OneDrive and you get back a file ID + share link (and the file_id-driven edit tools — append, insert, replace, etc. — become usable). When Microsoft is NOT connected, the file is saved locally under your agent uploads dir and the result tells you the absolute path — and the Word edit tools (replace / insert / delete / append) work on that LOCAL path directly (pass path="..."), so you NEVER need to regenerate a document just to make a small change.\n\nThe document is composed of `content` blocks (paragraphs, headings, tables, lists, images, page breaks, table of contents). Optional top-level fields control page setup, default font, headers, footers, footnotes, and multi-column layouts.\n\nDefaults: US Letter, 1" margins, Arial 12pt, full-width tables with light-blue header row and grey borders. You only need to specify these if you want to override the default.\n\n**For long documents — use chunked create + append.** Everything you write into the `content` array counts against your model\'s output token budget (typically 8K-32K tokens depending on which model is in play). A single multi-page document with rich blocks (paragraphs, tables, lists, formatting) can blow that budget mid-tool-call and the call will truncate / fail. The correct pattern for anything longer than ~3-5 dense pages: open the doc with this tool carrying the first section (title page, intro, opening section), then use **office_append_to_word_document** for each subsequent chunk. The file_id and share link stay alive across appends; the doc grows in place. Plan for this upfront — don\'t try to cram a whole report into one call.\n\nKey rules the renderer follows for you (no manual handling needed):\n- Tables get proper widths and cell margins automatically — no more 1-character-wide columns.\n- Bullet/numbered lists use real Word list semantics, not unicode bullet characters.\n- Headings include outlineLevel so Word\'s navigation pane and Table of Contents work.\n- Page breaks are wrapped in valid paragraphs.\n- Cell text can be a plain string; only wrap it in a cell object when you actually need per-cell formatting. Plain strings save a lot of output budget.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name (e.g., "Project Report.docx")' },
        folder_id: { type: 'string', description: 'OneDrive folder ID (omit for root)' },
        page_size: {
          type: 'string',
          enum: ['letter', 'a4', 'legal', 'tabloid'],
          description: 'Page size. Default "letter" (US users). Use "a4" for international.',
        },
        orientation: {
          type: 'string',
          enum: ['portrait', 'landscape'],
          description: 'Page orientation. Default "portrait".',
        },
        margin_in: {
          type: 'number',
          description: 'Page margin in inches, applied to all four sides uniformly. Default 1.',
        },
        default_font: {
          type: 'string',
          description: 'Default body font. Default "Arial". Common choices: "Arial", "Calibri", "Times New Roman", "Georgia".',
        },
        default_font_size_pt: {
          type: 'number',
          description: 'Default body font size in points. Default 12.',
        },
        header: {
          type: 'array',
          description: 'Content blocks rendered at the top of every page (same block schema as `content`). Common pattern: one centered paragraph with the document title.',
          items: { type: 'object' },
        },
        footer: {
          type: 'array',
          description: 'Content blocks rendered at the bottom of every page (same block schema as `content`).',
          items: { type: 'object' },
        },
        footer_includes_page_number: {
          type: 'boolean',
          description: 'When true, appends a centered "Page X of Y" line to the footer using live page-number fields. Default false.',
        },
        footnotes: {
          type: 'object',
          description: 'Footnote definitions keyed by id (e.g., {"1": "Source: Annual Report 2024"}). Reference them inline by adding a `paragraph_rich` block whose runs include {kind: "footnote_ref", footnote_id: 1}.',
        },
        columns: {
          type: 'object',
          description: 'Multi-column layout (newsletter / brochure). Example: {count: 2, space_dxa: 720, equal_width: true, separate: true}.',
          properties: {
            count: { type: 'number' },
            space_dxa: { type: 'number', description: 'Gap between columns in DXA (1440 = 1 inch). Default 720 (0.5 inch).' },
            equal_width: { type: 'boolean' },
            separate: { type: 'boolean', description: 'Draw a vertical line between columns.' },
          },
        },
        smart_quotes: {
          type: 'boolean',
          description: 'When true, converts straight quotes (\' and ") to smart curly quotes (‘ ’ “ ”) throughout the document body. Default false to preserve backward compatibility — set true for professional typography in memos, letters, and reports. Disable if you have code samples or other content where straight quotes must stay literal.',
        },
        revision_author: {
          type: 'string',
          description: 'Default author name for tracked-change runs (paragraph_rich runs of kind "tracked_insert" or "tracked_delete"). Default "Claude". Individual runs can override via revision_author.',
        },
        content: {
          type: 'array',
          description: 'Ordered list of content blocks. Block types: heading, paragraph, paragraph_rich (mixed-formatting runs in one paragraph), table, bullet_list, numbered_list, page_break, image, toc.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['heading', 'paragraph', 'paragraph_rich', 'table', 'bullet_list', 'numbered_list', 'page_break', 'image', 'toc'] },

              // shared / heading / paragraph / list items
              text: { type: 'string', description: 'Text content. For paragraph_rich use `runs` instead. For table use `rows`. For bullet_list / numbered_list use `items`.' },
              level: { type: 'number', description: 'Heading level 1-6 (for heading type). Default 1.' },

              // paragraph styling
              bold: { type: 'boolean' },
              italic: { type: 'boolean' },
              underline: { type: 'boolean' },
              align: { type: 'string', enum: ['left', 'center', 'right', 'justified'] },
              font: { type: 'string', description: 'Override default font for this paragraph.' },
              size_pt: { type: 'number', description: 'Override default font size in points.' },
              color: { type: 'string', description: 'Hex color without leading #, e.g. "2E75B6".' },
              bookmark: { type: 'string', description: 'Anchor name. Other paragraphs can link here via a paragraph_rich run with {kind: "hyperlink", bookmark: <name>}.' },
              tab_stops: {
                type: 'array',
                description: 'Tab stops for this paragraph. Use with embedded \\t in text or with paragraph_rich runs of kind "tab". Example for a right-aligned date: [{position: "right_margin", align: "right"}]. For a dot-leader TOC line: [{position: "right_margin", align: "right", leader: "dot"}].',
                items: {
                  type: 'object',
                  properties: {
                    position: { description: '"right_margin" or a DXA position number.' },
                    align: { type: 'string', enum: ['left', 'right', 'center'] },
                    leader: { type: 'string', enum: ['dot', 'hyphen', 'underscore', 'none'] },
                  },
                },
              },

              // paragraph_rich
              runs: {
                type: 'array',
                description: 'Array of runs for paragraph_rich. Each run has a `kind`: "text" (styled text), "hyperlink" (external `url` or internal `bookmark`), "footnote_ref" (with footnote_id matching a key in `footnotes`), "page_number"/"page_count" (live fields for headers/footers), "line_break" (soft break), or "tab".',
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['text', 'hyperlink', 'footnote_ref', 'page_number', 'page_count', 'line_break', 'tab'] },
                    text: { type: 'string' },
                    bold: { type: 'boolean' },
                    italic: { type: 'boolean' },
                    underline: { type: 'boolean' },
                    color: { type: 'string' },
                    size_pt: { type: 'number' },
                    font: { type: 'string' },
                    url: { type: 'string', description: 'External hyperlink URL.' },
                    bookmark: { type: 'string', description: 'Internal hyperlink anchor.' },
                    footnote_id: { description: 'Footnote ID, matches a key in `footnotes`.' },
                  },
                },
              },

              // table
              rows: {
                type: 'array',
                description: '2D array of cells. Each cell is either a plain string or an object {text, bold, italic, shading_hex, align}. First row is treated as the header (bold + shaded by default).',
                items: { type: 'array', items: {} },
              },
              column_widths_dxa: {
                type: 'array',
                description: 'Optional column widths in DXA (1440 = 1 inch). If omitted, columns are sized evenly across the content area. Must sum to content width if provided.',
                items: { type: 'number' },
              },
              header_shading_hex: { type: 'string', description: 'Header-row shading hex (default "D5E8F0"). Empty string disables.' },
              border_color_hex: { type: 'string', description: 'Border color hex (default "CCCCCC"). Empty string disables borders.' },
              first_row_bold: { type: 'boolean', description: 'Whether the first row is bold (default true).' },

              // list items
              items: { type: 'array', items: { type: 'string' }, description: 'List items for bullet_list / numbered_list.' },

              // image
              path: { type: 'string', description: 'Absolute path on disk to the image (for image block).' },
              width_in: { type: 'number', description: 'Display width in inches (image). Default 3.' },
              height_in: { type: 'number', description: 'Display height in inches (image). Default 3.' },
              alt: { type: 'string', description: 'Alt text for accessibility (image).' },
              image_type: { type: 'string', enum: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg'], description: 'Image format override; defaults to file extension.' },

              // toc
              toc_title: { type: 'string', description: 'Title rendered above the auto-generated TOC. Default "Table of Contents".' },
              toc_heading_levels: { type: 'string', description: 'Heading levels to include, e.g. "1-3" (default).' },
            },
          },
        },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'office_append_to_word_document',
    description: 'Append content to the END of an existing Word document — a LOCAL .docx (pass path="...") or one on OneDrive (pass file_id). The original content is preserved. For inserting at a specific position, use office_insert_in_word_document instead.\n\n**This is the natural continuation tool for long documents.** Because every block you pass to office_create_word_document counts against your model\'s per-call output token budget, multi-page docs (anything past ~3-5 dense pages of content) reliably overflow a single tool call. The shipping pattern: open the doc with office_create_word_document carrying the first chunk (title, intro, opening section), then call this tool once per subsequent chunk until the doc is complete. Each append is an independent tool call with its own output budget, so a 30-page report becomes ~5-10 sequential append calls, each well within budget. No content limit per call from us — only the model\'s output cap, which resets per call.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a LOCAL .docx on disk (what office_create_word_document returns when Microsoft is not connected). Provide either path OR file_id.' },
        file_id: { type: 'string', description: 'OneDrive file ID of the existing .docx (Microsoft-connected setups). Provide either file_id OR path.' },
        content: {
          type: 'array',
          description: 'Content blocks to append (same schema as office_create_word_document)',
          items: { type: 'object' },
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'office_get_word_document_outline',
    description: 'Read the structure of an existing Word document: a list of blocks (paragraphs, headings, tables) with zero-based index numbers and a short text preview of each. Use this BEFORE office_insert_in_word_document or office_delete_block_in_word_document to know which index to target. For the actual content of the document, use office_read_word_document instead.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a LOCAL .docx on disk. Provide either path OR file_id.' },
        file_id: { type: 'string', description: 'OneDrive file ID of the .docx to inspect. Provide either file_id OR path.' },
      },
      required: [],
    },
  },
  {
    name: 'office_read_word_document',
    description: 'Read the FULL text content of a Word document (.docx). Returns headings, paragraphs, and table contents in document order — this is the read-equivalent of file_read for .docx files. Supports pagination via offset+limit (block-indexed) for large documents. Use this when the user asks you to read, summarize, quote, or extract content from a Word doc; use office_get_word_document_outline only when you need to know block indexes for an edit operation.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a LOCAL .docx on disk. Provide either path OR file_id.' },
        file_id: { type: 'string', description: 'OneDrive file ID of the .docx to read. Provide either file_id OR path.' },
        offset: { type: 'number', description: 'Zero-based block index to start reading from. Default 0.' },
        limit: { type: 'number', description: 'Maximum number of blocks to return. Default 200, max 500. Combined with a per-call response cap; very large blocks may produce fewer.' },
        format: { type: 'string', enum: ['text', 'json'], description: 'Output format: "text" (default — clean, readable transcript with markdown-style headings) or "json" (structured array of {index, type, text, rows?} objects, useful before edits).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 8000,
  },
  {
    name: 'office_replace_in_word_document',
    description: 'Find and replace text throughout an existing Word document. Preserves formatting. Limitation: the find string must be contained within a single formatted run — works for unformatted text or text in one consistent style; cannot match text that spans bold/italic boundaries.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a LOCAL .docx on disk. Provide either path OR file_id.' },
        file_id: { type: 'string', description: 'OneDrive file ID of the .docx to edit. Provide either file_id OR path.' },
        find: { type: 'string', description: 'Text to search for (exact match, case-sensitive)' },
        replace: { type: 'string', description: 'Replacement text. Use empty string to delete the find text.' },
      },
      required: ['find', 'replace'],
    },
  },
  {
    name: 'office_insert_in_word_document',
    description: 'Insert content blocks at a specific position in an existing Word document. The position is a zero-based index — call office_get_word_document_outline first to know which index to target. To insert at the very beginning use position 0; to insert before the third block use position 2.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a LOCAL .docx on disk. Provide either path OR file_id.' },
        file_id: { type: 'string', description: 'OneDrive file ID of the .docx to edit. Provide either file_id OR path.' },
        position: { type: 'number', description: 'Zero-based index where the new content goes. Existing block at this index shifts down.' },
        content: {
          type: 'array',
          description: 'Content blocks to insert (same schema as office_create_word_document)',
          items: { type: 'object' },
        },
      },
      required: ['position', 'content'],
    },
  },
  {
    name: 'office_delete_block_in_word_document',
    description: 'Delete one or more blocks from an existing Word document by zero-based index. Use office_get_word_document_outline first to know which indexes to target. Can delete a single block or a range. Indexes refer to the document BEFORE the delete — to delete blocks 5, 6, and 7, pass start=5, count=3.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a LOCAL .docx on disk. Provide either path OR file_id.' },
        file_id: { type: 'string', description: 'OneDrive file ID of the .docx to edit. Provide either file_id OR path.' },
        start: { type: 'number', description: 'Zero-based index of the first block to delete' },
        count: { type: 'number', description: 'Number of consecutive blocks to delete (default 1)' },
      },
      required: ['start'],
    },
  },
  {
    name: 'office_get_spreadsheet_range',
    description: 'Read a range of cells from an existing Excel spreadsheet. Works on a LOCAL .xlsx (pass path="...") or one on OneDrive (pass file_id). Returns the cell values as a 2D array. Use this to inspect data before editing.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a LOCAL .xlsx on disk (what office_create_spreadsheet returns when Microsoft is not connected). Provide either path OR file_id.' },
        file_id: { type: 'string', description: 'OneDrive file ID of the .xlsx. Provide either file_id OR path.' },
        sheet_name: { type: 'string', description: 'Worksheet name (e.g. "Sheet1"). If omitted, reads from the first sheet.' },
        range: { type: 'string', description: 'A1-style range (e.g. "A1:D10"). If omitted, returns the used range of the sheet.' },
      },
      required: [],
    },
  },
  {
    name: 'office_write_spreadsheet_range',
    description: 'Write values to a specific range in an existing Excel spreadsheet — true in-place edit. Works on a LOCAL .xlsx (pass path="...") or one on OneDrive (pass file_id). Do NOT recreate the whole workbook to change a few cells.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a LOCAL .xlsx on disk. Provide either path OR file_id.' },
        file_id: { type: 'string', description: 'OneDrive file ID of the .xlsx. Provide either file_id OR path.' },
        sheet_name: { type: 'string', description: 'Worksheet name (e.g. "Sheet1"). If omitted, writes to the first sheet.' },
        range: { type: 'string', description: 'A1-style range to write (e.g. "A1:C3"). The values array dimensions must match this range exactly.' },
        values: { type: 'array', description: '2D array of cell values. Outer array = rows, inner array = columns. Values are strings or numbers.', items: { type: 'array', items: {} } },
      },
      required: ['range', 'values'],
    },
  },
  {
    name: 'office_append_spreadsheet_rows',
    description: 'Append rows to the end of an existing worksheet (after the last used row). True in-place edit. Works on a LOCAL .xlsx (pass path="...") or one on OneDrive (pass file_id).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a LOCAL .xlsx on disk. Provide either path OR file_id.' },
        file_id: { type: 'string', description: 'OneDrive file ID of the .xlsx. Provide either file_id OR path.' },
        sheet_name: { type: 'string', description: 'Worksheet name. If omitted, appends to the first sheet.' },
        rows: { type: 'array', description: '2D array of row values to append', items: { type: 'array', items: {} } },
      },
      required: ['rows'],
    },
  },
  {
    name: 'office_add_sheet',
    description: 'Add a new worksheet to an existing Excel workbook. True in-place edit. Works on a LOCAL .xlsx (pass path="...") or one on OneDrive (pass file_id).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a LOCAL .xlsx on disk. Provide either path OR file_id.' },
        file_id: { type: 'string', description: 'OneDrive file ID of the .xlsx. Provide either file_id OR path.' },
        sheet_name: { type: 'string', description: 'Name for the new worksheet' },
      },
      required: ['sheet_name'],
    },
  },
  {
    name: 'office_delete_sheet',
    description: 'Delete a worksheet from an existing Excel workbook. Cannot delete the only sheet. Works on a LOCAL .xlsx (pass path="...") or one on OneDrive (pass file_id).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a LOCAL .xlsx on disk. Provide either path OR file_id.' },
        file_id: { type: 'string', description: 'OneDrive file ID of the .xlsx. Provide either file_id OR path.' },
        sheet_name: { type: 'string', description: 'Worksheet name to delete' },
      },
      required: ['sheet_name'],
    },
  },
  {
    name: 'office_create_spreadsheet',
    description: 'Create an Excel spreadsheet (.xlsx). When Microsoft is connected, the file uploads to OneDrive (file_id + share link returned, file_id-driven workbook edit tools usable). When Microsoft is NOT connected, the file is saved locally under your agent uploads dir and the result tells you the absolute path; the Graph workbook tools aren\'t available against that path.\n\n**Cells, not columns.** Everything — values, formulas, styling, widths — goes through the `sheets[].rows` 2D array. There is NO sheet-level `formulas`, `columns`, `header_row`, or `currency_format` field — if you pass any of those, the call will be REJECTED with a corrective error. Column widths live on `sheets[].column_widths`; per-row / per-cell style lives inside the row cells.\n\nEach cell is either a plain primitive (string / number / boolean) OR an object with rich properties. Example: a formula cell looks like `{ formula: "=SUM(B2:B9)", number_format: "$#,##0" }`. A currency input looks like `{ value: 150000, number_format: "$#,##0", font: { color: "0070C0" } }` (blue inputs by financial-model convention). A percent looks like `{ formula: "=B4/B2", number_format: "0.0%" }`.\n\nCell object full surface: `{ value, formula, number_format, font: { name, size, bold, italic, underline, color }, fill_hex, align: "left"|"center"|"right"|"justified", v_align, border: "all"|"top"|"bottom"|"left"|"right"|"none", wrap_text, comment, hyperlink }`. Leading "=" on `formula` is optional.\n\nPer-sheet you can also set `column_widths` (array of numbers in Excel character units, e.g. [22, 14, 14, 14]), `freeze_rows`, `freeze_cols`, `default_header_row` (auto-styles row 1 with bold + light-blue fill — true by default), `zoom_pct`, `hidden`.\n\nKey defaults the renderer applies:\n- The first row gets bold + light-blue fill automatically unless `default_header_row: false` is passed.\n- Numbers stay numeric (SUM etc. work); strings stay text.\n- Common financial-model color convention: blue inputs (color "0070C0"), black formulas (default), green cross-sheet refs (color "00B050"), red external refs (color "C00000"), yellow assumption fill ("FFF2CC").\n- Number formats: "$#,##0;($#,##0);-" for currency, "0.0%" for percentages, "0.00x" for multiples, "yyyy-mm-dd" for dates.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name (e.g., "Budget.xlsx")' },
        folder_id: { type: 'string', description: 'OneDrive folder ID (omit for root)' },
        sheets: {
          type: 'array',
          description: 'Array of sheet specs. Each sheet has a name, 2D rows array, and optional column widths / freeze rows / freeze cols / default_header_row / zoom_pct / hidden.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Sheet name (must be unique within the workbook, max 31 chars, cannot contain : \\ / ? * [ ]).' },
              rows: {
                type: 'array',
                description: '2D array of cells. Each cell is either a plain value (string / number / boolean / null) or an object with: value, formula, number_format, font ({name, size, bold, italic, underline, color}), fill_hex, align (left/center/right/justified), v_align (top/middle/bottom), border (all/top/bottom/left/right/none), wrap_text, comment (cell note), hyperlink (URL).',
                items: { type: 'array', items: {} },
              },
              column_widths: {
                type: 'array',
                items: { type: ['number', 'null'] },
                description: 'Per-column widths in Excel character units (a value of 12 ≈ 12 characters wide). Use null to leave a column at default. Example: [20, 30, null, 12].',
              },
              freeze_rows: { type: 'number', description: 'Freeze the top N rows. Default 1 if default_header_row is true; 0 otherwise.' },
              freeze_cols: { type: 'number', description: 'Freeze the left N columns. Default 0.' },
              default_header_row: { type: 'boolean', description: 'When true (default), the first row is auto-styled as a header: bold text + light-blue fill, and the row gets frozen. Set to false to disable.' },
              zoom_pct: { type: 'number', description: 'Default zoom percentage (e.g. 100, 125, 150).' },
              hidden: { type: 'boolean', description: 'Create the sheet as hidden (still in the workbook, hidden in the Excel UI).' },
            },
            required: ['name', 'rows'],
          },
        },
      },
      required: ['filename', 'sheets'],
    },
  },
  {
    name: 'office_get_presentation_outline',
    description: 'Read the structure of an existing PowerPoint: a list of slides with index numbers and the title text of each. Use this BEFORE office_insert_slide or office_delete_slide. For the actual slide content, use office_read_presentation instead.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .pptx to inspect' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'office_read_presentation',
    description: 'Read the FULL text content of a PowerPoint deck (.pptx) on OneDrive — title and body text per slide. This is the read-equivalent of file_read for .pptx files. Supports pagination via offset+limit (slide-indexed) for large decks. Use this when the user asks you to read, summarize, quote, or extract content from a PowerPoint; use office_get_presentation_outline only when you need slide indexes for an edit operation.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .pptx to read' },
        offset: { type: 'number', description: 'Zero-based slide index to start reading from. Default 0.' },
        limit: { type: 'number', description: 'Maximum number of slides to return. Default 50, max 200.' },
        format: { type: 'string', enum: ['text', 'json'], description: 'Output format: "text" (default — clean per-slide transcript) or "json" (structured array of {index, title, body[]} objects).' },
      },
      required: ['file_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 8000,
  },
  {
    name: 'office_replace_in_presentation',
    description: 'Find and replace text across all slides in an existing PowerPoint. Same limitation as the Word equivalent: matches text contained within a single formatted run. File ID and share links preserved.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .pptx to edit' },
        find: { type: 'string', description: 'Text to search for (exact match, case-sensitive)' },
        replace: { type: 'string', description: 'Replacement text. Use empty string to delete the find text.' },
      },
      required: ['file_id', 'find', 'replace'],
    },
  },
  {
    name: 'office_insert_slide',
    description: 'Insert a new slide at a specific position (zero-based) in an existing PowerPoint. Existing slides shift down. New slide uses a simple title + body layout.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .pptx' },
        position: { type: 'number', description: 'Zero-based index where the new slide goes. Use 0 to insert at the start. Use the current slide count to append.' },
        title: { type: 'string', description: 'Slide title' },
        body: { type: 'string', description: 'Slide body text (optional)' },
      },
      required: ['file_id', 'position', 'title'],
    },
  },
  {
    name: 'office_delete_slide',
    description: 'Delete a slide from an existing PowerPoint by zero-based index. Remaining slides shift up.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .pptx' },
        position: { type: 'number', description: 'Zero-based index of the slide to delete' },
      },
      required: ['file_id', 'position'],
    },
  },
  {
    name: 'office_create_presentation',
    description: 'Create a PowerPoint presentation (.pptx). When Microsoft is connected, the file uploads to OneDrive (file_id + share link returned, file_id-driven slide edit tools usable). When Microsoft is NOT connected, the file is saved locally under your agent uploads dir and the result tells you the absolute path; the file_id-driven edit tools aren\'t available against that path.\n\nThe deck has an optional `theme` (colors, fonts, slide size) and an array of `slides`. Each slide picks a `layout` preset (title / content / two_column / comparison / big_stat / image / blank) that auto-places common content (title, body, bullets), OR provides explicit `elements[]` (text boxes, shapes, images, tables) at exact x/y/w/h positions. Both can be mixed on the same slide — layout-driven content renders first, free-form elements go on top.\n\nLayouts:\n- `title`: centered hero title + subtitle. Use for the opening slide.\n- `content`: title at top + body underneath. If `body` is a string[], renders as bullets.\n- `two_column`: title + two side-by-side bodies (`body_left`, `body_right`). Both can be string[] for bullets.\n- `comparison`: like two_column but adds a vertical accent divider between columns. Use for pros/cons, before/after, option A vs B.\n- `big_stat`: huge centered statistic (`stat_value`, e.g. "$2.4M") with optional small `title` above and `stat_label` below.\n- `image`: title + centered image (path or URL) + optional caption (body).\n- `blank`: no auto-placed content; use `elements[]` exclusively for fully custom slides.\n\nText content fields (`title`, `body`, `body_left`, etc., and the `text` field of a text-element) accept three shapes: a plain string, an array of strings (renders as bullets / multiple lines depending on context), or an array of run objects `{text, bold, italic, underline, color, size, font, break, url}` for mixed formatting.\n\nSpeaker notes go on `notes` per slide. Slide background can be overridden via `background_hex`.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name (e.g., "Pitch Deck.pptx")' },
        folder_id: { type: 'string', description: 'OneDrive folder ID (omit for root)' },
        theme: {
          type: 'object',
          description: 'Deck-level theme. All fields optional. Colors are hex without #. Default: blue/grey palette, Calibri fonts, widescreen (16:9).',
          properties: {
            primary: { type: 'string', description: 'Primary brand color (titles, accents). Hex without #.' },
            secondary: { type: 'string' },
            accent: { type: 'string', description: 'Accent color (dividers, callouts).' },
            background: { type: 'string', description: 'Default slide background.' },
            text: { type: 'string', description: 'Default body text color.' },
            title_font: { type: 'string', description: 'Font for titles (default Calibri).' },
            body_font: { type: 'string', description: 'Font for body text (default Calibri).' },
            slide_size: { type: 'string', enum: ['standard', 'wide'], description: '"wide" = 16:9 (default), "standard" = 4:3.' },
          },
        },
        slides: {
          type: 'array',
          description: 'Ordered list of slides.',
          items: {
            type: 'object',
            properties: {
              layout: { type: 'string', enum: ['title', 'content', 'two_column', 'comparison', 'big_stat', 'image', 'blank'], description: 'Layout preset. Defaults to "content" when title/body are set, "blank" when only `elements` is given.' },
              title: { description: 'Slide title (string OR rich runs).' },
              subtitle: { description: 'Subtitle for the title layout.' },
              body: { description: 'Body content. For "content" layout: string or string[] (bullets). For "image": optional caption.' },
              body_left: { description: 'Left-column body for two_column / comparison.' },
              body_right: { description: 'Right-column body for two_column / comparison.' },
              image_path: { type: 'string', description: 'Absolute path to a local image (for the "image" layout).' },
              image_url: { type: 'string', description: 'Remote image URL (for the "image" layout).' },
              stat_value: { type: 'string', description: 'Big centered statistic for big_stat layout (e.g. "$2.4M").' },
              stat_label: { description: 'Caption under the stat (string or rich runs).' },
              elements: {
                type: 'array',
                description: 'Free-form elements rendered on top of any layout content. Each has a `type`: "text", "shape", "image", or "table". All require explicit x/y/w/h in inches.',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['text', 'shape', 'image', 'table'] },
                    // text
                    text: { description: 'Text content for text elements / text-on-shape / table cells. String, string[], or run array.' },
                    x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
                    font_size: { type: 'number' },
                    bold: { type: 'boolean' },
                    italic: { type: 'boolean' },
                    color: { type: 'string' },
                    align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
                    v_align: { type: 'string', enum: ['top', 'middle', 'bottom'] },
                    bullet: { description: 'true = unordered bullet, "numbered" = 1. 2. 3., omit = no bullets.' },
                    fill_hex: { type: 'string' },
                    font_face: { type: 'string' },
                    // shape
                    shape_type: { type: 'string', enum: ['rect', 'rounded_rect', 'ellipse', 'triangle', 'line', 'arrow'] },
                    border_hex: { type: 'string' },
                    border_pt: { type: 'number' },
                    text_color: { type: 'string' },
                    text_size: { type: 'number' },
                    text_align: { type: 'string', enum: ['left', 'center', 'right'] },
                    text_v_align: { type: 'string', enum: ['top', 'middle', 'bottom'] },
                    // image
                    path: { type: 'string', description: 'Absolute path for an image element.' },
                    url: { type: 'string', description: 'Remote URL for an image element.' },
                    data: { type: 'string', description: 'Base64-encoded data for an image element (no data: prefix).' },
                    alt: { type: 'string' },
                    sizing: { type: 'string', enum: ['contain', 'cover'] },
                    // table
                    rows: { type: 'array', description: '2D array of cells for table elements; each cell is a string or rich runs.', items: { type: 'array', items: {} } },
                    header_row: { type: 'boolean' },
                    header_fill_hex: { type: 'string' },
                    col_widths: { type: 'array', items: { type: 'number' } },
                  },
                },
              },
              notes: { type: 'string', description: 'Speaker notes for this slide.' },
              background_hex: { type: 'string', description: 'Override slide background color (hex without #).' },
            },
          },
        },
      },
      required: ['filename', 'slides'],
    },
  },
];

// ── Helpers ──

// ── Word document schema ──
//
// The schema below is the canonical shape an agent passes to
// office_create_word_document and the append/insert siblings. The shape
// stayed backward-compatible across the v2.9.x rewrite — old callers
// supplying { type: 'paragraph', text, bold, italic, align } still work
// and produce the same paragraphs; new optional fields and block types
// add expressiveness without breaking anything.
//
// Design rules followed throughout:
//   - Use US Letter as default page size (most docx-js consumers expect
//     this; the library's own default is A4).
//   - Default font is Arial 12pt — universally rendered, readable.
//   - Tables always set width + columnWidths + per-cell width in DXA,
//     plus cell margins. Without all of these Word collapses columns to
//     1-character wide for content that lacks spaces (the bug that
//     drove this rewrite).
//   - Heading paragraph styles include outlineLevel so Word's
//     navigation pane and Table of Contents both work.
//   - Bullet/numbered lists use docx-js numbering refs, not raw
//     unicode bullet characters (the latter break list semantics in
//     some Word versions and on screen readers).

interface TextRunSpec {
  /**
   * Kind of run inside a rich paragraph.
   * - text: plain styled text
   * - hyperlink: clickable link (external `url` OR internal `bookmark`)
   * - footnote_ref: superscript number referencing a footnote (must
   *   match a key in WordDocOptions.footnotes)
   * - page_number: live page number field (use only inside a footer/header)
   * - page_count: live total page count field (use only inside footer/header)
   * - line_break: soft break within the same paragraph
   * - tab: tab character (use with paragraph.tab_stops for alignment)
   * - tracked_insert: text marked as an insertion (tracked change). The
   *   recipient sees it as an editorial insertion they can accept or
   *   reject in Word.
   * - tracked_delete: text marked as a deletion (tracked change).
   *   Renders as strikethrough until the recipient accepts the change.
   */
  kind:
    | 'text'
    | 'hyperlink'
    | 'footnote_ref'
    | 'page_number'
    | 'page_count'
    | 'line_break'
    | 'tab'
    | 'tracked_insert'
    | 'tracked_delete';
  text?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Hex color without leading '#', e.g. '2E75B6' */
  color?: string;
  /** Font size in points (note: docx uses half-points internally, we convert). */
  size_pt?: number;
  font?: string;
  /** External hyperlink target. */
  url?: string;
  /** Internal hyperlink anchor (use with a `bookmark` set somewhere in the doc). */
  bookmark?: string;
  /** Footnote ID matching a key in WordDocOptions.footnotes. */
  footnote_id?: string | number;
  /** Override the revision author (only for tracked_insert / tracked_delete). Falls back to WordDocOptions.revision_author or 'Claude'. */
  revision_author?: string;
  /** Override the revision date in ISO 8601 (only for tracked_insert / tracked_delete). Falls back to now. */
  revision_date?: string;
}

interface TableCellSpec {
  text?: string;
  bold?: boolean;
  italic?: boolean;
  /** Cell background as hex, e.g. 'D5E8F0'. */
  shading_hex?: string;
  align?: 'left' | 'center' | 'right' | 'justified';
}

type TableCellInput = string | TableCellSpec;

interface ContentBlock {
  type:
    | 'heading'
    | 'paragraph'
    | 'paragraph_rich'
    | 'table'
    | 'bullet_list'
    | 'numbered_list'
    | 'page_break'
    | 'image'
    | 'toc';

  // ── shared ──
  text?: string;

  // ── heading ──
  level?: number;

  // ── paragraph + paragraph_rich + bullet/numbered list items ──
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right' | 'justified';
  font?: string;
  size_pt?: number;
  color?: string;
  /** Anchor name for internal hyperlinks targeting this paragraph. */
  bookmark?: string;
  /**
   * Tab stops on this paragraph. Use with `runs` of kind 'tab' or with
   * embedded \t in plain text to align content at the stop. `position`:
   *   - 'right_margin' = MAX (typical for right-aligned dates etc.)
   *   - number = DXA position
   * `leader`: 'dot' produces a dot leader (chapter ......... 3).
   */
  tab_stops?: Array<{
    position: 'right_margin' | number;
    align?: 'left' | 'right' | 'center';
    leader?: 'dot' | 'hyphen' | 'underscore' | 'none';
  }>;

  // ── paragraph_rich ──
  runs?: TextRunSpec[];

  // ── table ──
  /** 2D rows. Each cell can be a plain string or a TableCellSpec. First row is treated as header (bold + shaded). */
  rows?: TableCellInput[][];
  /** Optional column-width override in DXA. If omitted, columns are sized evenly to fit the content area. Length MUST equal the column count. */
  column_widths_dxa?: number[];
  /** Header row shading as hex (default 'D5E8F0'). Set to '' to disable header shading. */
  header_shading_hex?: string;
  /** Border color hex (default 'CCCCCC'). Set to '' to disable borders. */
  border_color_hex?: string;
  /** First-row gets bold text (default true). */
  first_row_bold?: boolean;

  // ── bullet_list / numbered_list ──
  items?: string[];

  // ── image ──
  /** Absolute path on disk to the image file. */
  path?: string;
  /** Display width in inches. */
  width_in?: number;
  /** Display height in inches. */
  height_in?: number;
  /** Alt text for accessibility. */
  alt?: string;
  /** Image format (png/jpg/gif/bmp/svg). If omitted, derived from the file extension. */
  image_type?: 'png' | 'jpg' | 'jpeg' | 'gif' | 'bmp' | 'svg';

  // ── toc ──
  /** Title rendered above the auto-generated table of contents. */
  toc_title?: string;
  /** Heading levels to include, e.g. '1-3' (default). */
  toc_heading_levels?: string;
}

/** Top-level document options for office_create_word_document. */
interface WordDocOptions {
  /** Default 'letter'. */
  page_size?: 'letter' | 'a4' | 'legal' | 'tabloid';
  /** Default 'portrait'. */
  orientation?: 'portrait' | 'landscape';
  /** Page margin in inches (uniform on all sides). Default 1. */
  margin_in?: number;
  /** Default font, e.g. 'Arial' (default), 'Calibri', 'Times New Roman'. */
  default_font?: string;
  /** Default font size in points (default 12). */
  default_font_size_pt?: number;
  /** Content blocks rendered in the page header (top of every page). */
  header?: ContentBlock[];
  /** Content blocks rendered in the page footer (bottom of every page). */
  footer?: ContentBlock[];
  /** Shortcut: when true, appends a centered "Page X of Y" line to the footer. */
  footer_includes_page_number?: boolean;
  /** Footnote definitions keyed by id. Reference them in paragraph_rich runs via { kind: 'footnote_ref', footnote_id }. */
  footnotes?: Record<string, string>;
  /** Multi-column layout (newsletters/brochures). */
  columns?: { count: number; equal_width?: boolean; space_dxa?: number; separate?: boolean };
  /** Convert straight quotes ('", "") to smart quotes (', ', ", ") throughout the document. Default false (preserves backward compatibility). */
  smart_quotes?: boolean;
  /** Default author name for tracked-change runs. Default 'Claude'. */
  revision_author?: string;
}

/**
 * Smart-quote normalization. Converts straight quotes into their
 * curly equivalents. Heuristic: a straight quote that follows
 * whitespace, opening punctuation, or is at the start of a string is
 * an opener; everything else is a closer. The skill recommends
 * this for professional typography — disabled by default so code
 * samples and technical content stay literal.
 */
function smartenQuotes(text: string): string {
  if (!text) return text;
  return text
    .replace(/(^|[\s(\[{<])"/g, '$1“')         // opening double
    .replace(/"/g, '”')                            // closing double
    .replace(/(^|[\s(\[{<])'/g, '$1‘')           // opening single
    .replace(/'/g, '’');                           // closing single / apostrophe
}

/**
 * Save an office document buffer in the right place for the calling
 * agent's environment. When Microsoft is connected, upload to OneDrive
 * (file_id + share link returned, plus all the existing edit tools
 * work). When Microsoft is NOT connected, fall back to a local save
 * under ~/.dojo/uploads/<agentId>/<filename> — same pattern as the PDF
 * tools — so an agent on a local-only setup can still create Office
 * files. The create tool returns a user-facing summary either way; the
 * shape of what's available next (file_id-driven edits vs. just a
 * local path) is named explicitly in the result so the agent knows.
 */
async function saveOfficeBuffer(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  agentId: string,
  folderId: string | undefined,
  kind: 'word' | 'excel' | 'powerpoint',
): Promise<string> {
  const { isMicrosoftConnected } = await import('./auth.js');
  if (isMicrosoftConnected('agent')) {
    const result = await uploadToOneDrive(buffer, filename, mimeType, folderId);
    const kindLabel = kind === 'word' ? 'Word document' : kind === 'excel' ? 'Excel spreadsheet' : 'PowerPoint presentation';
    return `${kindLabel} "${result.name}" created on OneDrive.\nFile ID: ${result.id}\nOpen: ${result.webUrl}${result.shareLink ? `\nShare link: ${result.shareLink}` : ''}`;
  }
  // Local fallback. Mirror the PDF tools' uploads-dir pattern so every
  // agent-generated file lives in one predictable place.
  const dir = path.join(os.homedir(), '.dojo', 'uploads', agentId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const outPath = path.join(dir, safe);
  fs.writeFileSync(outPath, buffer);
  const kindLabel = kind === 'word' ? 'Word document' : kind === 'excel' ? 'Excel spreadsheet' : 'PowerPoint presentation';
  const shareLine = `To give the user a downloadable URL for this file, call share_file with path="${outPath}" — do NOT invent or guess a URL.`;
  // Word and Excel are editable IN PLACE on disk — their edit tools accept a
  // local `path`. This is the key affordance: without it the model regenerates
  // the whole file on every change and the canvas churns. PowerPoint edits still
  // need the Graph connection.
  if (kind === 'word') {
    return (
      `Word document created locally at ${outPath} (${buffer.length} bytes). ` +
      `To EDIT it (now or later) do NOT regenerate it — call the Word edit tools with path="${outPath}": ` +
      `office_replace_in_word_document (change text), office_insert_in_word_document / office_delete_block_in_word_document (add or remove blocks), office_append_to_word_document (add to the end). ` +
      `Call office_get_word_document_outline or office_read_word_document with path="${outPath}" first to see current block indexes. Edits save back to the same file and refresh the canvas automatically. ` +
      shareLine
    );
  }
  if (kind === 'excel') {
    return (
      `Excel spreadsheet created locally at ${outPath} (${buffer.length} bytes). ` +
      `To EDIT it (now or later) do NOT recreate it — call the spreadsheet edit tools with path="${outPath}": ` +
      `office_write_spreadsheet_range (set cells in a range), office_append_spreadsheet_rows (add rows), office_add_sheet / office_delete_sheet (manage worksheets). ` +
      `Call office_get_spreadsheet_range with path="${outPath}" first to see current values. Edits save back to the same file and refresh the canvas automatically. ` +
      shareLine
    );
  }
  return (
    `${kindLabel} created locally at ${outPath} (${buffer.length} bytes). ` +
    shareLine + ' ' +
    `Microsoft is not connected, so this was saved to disk instead of OneDrive — the file_id-driven slide edit tools are NOT available for it. To edit presentations in place, connect Microsoft in Settings → Integrations; otherwise recreate the file with your changes.`
  );
}

async function uploadToOneDrive(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  folderId?: string,
): Promise<{ id: string; name: string; webUrl: string; shareLink: string | null }> {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Not authenticated with Microsoft');

  const encodedName = encodeURIComponent(filename);
  const endpoint = folderId
    ? `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(folderId)}:/${encodedName}:/content`
    : `${GRAPH_BASE}/me/drive/root:/${encodedName}:/content`;

  const resp = await fetch(endpoint, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
    body: buffer,
    signal: AbortSignal.timeout(60000),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Upload failed (${resp.status}): ${err.slice(0, 200)}`);
  }

  const data = await resp.json() as { id: string; name: string; webUrl: string };

  // Auto-generate shareable link
  let shareLink: string | null = null;
  try {
    const linkResp = await fetch(`${GRAPH_BASE}/me/drive/items/${data.id}/createLink`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'view', scope: 'anonymous' }),
    });
    if (linkResp.ok) {
      const linkData = await linkResp.json() as { link?: { webUrl?: string } };
      shareLink = linkData.link?.webUrl ?? null;
    }
  } catch { /* best effort */ }

  return { id: data.id, name: data.name, webUrl: data.webUrl, shareLink };
}

// ── Word Document Generation ──

// All Office packages are dynamically imported since they may not be installed yet.
// TypeScript uses 'any' for these — the packages are optional runtime dependencies.

/**
 * Page dimensions in DXA (1440 DXA = 1 inch). Defaults to US Letter
 * because docx-js's own default is A4, which silently produces wrong
 * margins for US users.
 */
const PAGE_SIZES_DXA: Record<string, { width: number; height: number }> = {
  letter:  { width: 12240, height: 15840 },
  a4:      { width: 11906, height: 16838 },
  legal:   { width: 12240, height: 20160 },
  tabloid: { width: 17280, height: 22320 },
};

/**
 * Reference for content-width math: page width minus left+right margin
 * (in DXA). Used to size full-width tables and column-width arithmetic.
 */
function contentWidthDxa(pageW: number, marginInches: number): number {
  return pageW - Math.round(marginInches * 1440 * 2);
}

/**
 * Map the agent-friendly align string to docx-js AlignmentType.
 */
function resolveAlign(docx: any, align?: string): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (align) {
    case 'center':    return docx.AlignmentType.CENTER;
    case 'right':     return docx.AlignmentType.RIGHT;
    case 'justified': return docx.AlignmentType.JUSTIFIED;
    case 'left':
    default:          return docx.AlignmentType.LEFT;
  }
}

/**
 * Build the styles config that docx-js attaches to the Document. We
 * override the built-in Heading 1/2/3 styles so they use the chosen
 * default font and include outlineLevel (required for Word's
 * navigation pane and Table of Contents to find them).
 */
function buildStylesConfig(docx: any, defaultFont: string, defaultSizeHalfPt: number): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    default: {
      document: { run: { font: defaultFont, size: defaultSizeHalfPt } },
    },
    paragraphStyles: [
      {
        id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 36, bold: true, font: defaultFont, color: '000000' },
        paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 },
      },
      {
        id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 32, bold: true, font: defaultFont, color: '000000' },
        paragraph: { spacing: { before: 200, after: 200 }, outlineLevel: 1 },
      },
      {
        id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 28, bold: true, font: defaultFont, color: '000000' },
        paragraph: { spacing: { before: 160, after: 160 }, outlineLevel: 2 },
      },
    ],
  };
}

/**
 * Numbering config providing two refs: 'bullets' (•) and 'numbers' (1. 2. 3.).
 * Both indented 0.5", hanging 0.25". docx-js requires this; raw unicode
 * bullets in paragraph text break list semantics in some Word versions.
 */
function buildNumberingConfig(docx: any): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    config: [
      {
        reference: 'bullets',
        levels: [{
          level: 0, format: docx.LevelFormat.BULLET, text: '•',
          alignment: docx.AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      },
      {
        reference: 'numbers',
        levels: [{
          level: 0, format: docx.LevelFormat.DECIMAL, text: '%1.',
          alignment: docx.AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      },
    ],
  };
}

/**
 * Convert a TextRunSpec into a docx-js run object. Returns either a
 * single object (TextRun, InternalHyperlink, ExternalHyperlink, etc.)
 * or null if the spec is invalid for its kind.
 */
function buildRunFromSpec(
  docx: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  spec: TextRunSpec,
  defaultFont: string,
  ctx?: { smartQuotes?: boolean; revisionAuthor?: string },
): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  const formatting = {
    bold: spec.bold ?? false,
    italics: spec.italic ?? false,
    underline: spec.underline ? {} : undefined,
    color: spec.color,
    size: spec.size_pt ? Math.round(spec.size_pt * 2) : undefined,
    font: spec.font ?? defaultFont,
  };
  const rawText = spec.text ?? '';
  const text = ctx?.smartQuotes ? smartenQuotes(rawText) : rawText;
  const revisionAuthor = spec.revision_author ?? ctx?.revisionAuthor ?? 'Claude';
  const revisionDate = spec.revision_date ?? new Date().toISOString();
  switch (spec.kind) {
    case 'text':
      return new docx.TextRun({ text, ...formatting });
    case 'hyperlink': {
      if (spec.url) {
        return new docx.ExternalHyperlink({
          link: spec.url,
          children: [new docx.TextRun({ text: spec.text ?? spec.url, style: 'Hyperlink', ...formatting })],
        });
      }
      if (spec.bookmark) {
        return new docx.InternalHyperlink({
          anchor: spec.bookmark,
          children: [new docx.TextRun({ text: spec.text ?? '', style: 'Hyperlink', ...formatting })],
        });
      }
      return null;
    }
    case 'footnote_ref':
      if (spec.footnote_id === undefined) return null;
      return new docx.FootnoteReferenceRun(Number(spec.footnote_id));
    case 'page_number':
      return new docx.TextRun({ children: [docx.PageNumber.CURRENT], ...formatting });
    case 'page_count':
      return new docx.TextRun({ children: [docx.PageNumber.TOTAL_PAGES], ...formatting });
    case 'line_break':
      return new docx.TextRun({ break: 1 });
    case 'tab':
      return new docx.TextRun({ children: ['\t'], ...formatting });
    case 'tracked_insert':
      // docx-js InsertedTextRun wraps a TextRun in a <w:ins> element
      // with author + date attributes — Word reads it as an editorial
      // insertion the recipient can accept or reject in the Review tab.
      return new docx.InsertedTextRun({
        text,
        ...formatting,
        author: revisionAuthor,
        date: revisionDate,
        id: 0, // docx auto-assigns IDs from this seed
      });
    case 'tracked_delete':
      // DeletedTextRun emits <w:del> + <w:delText>; rendered as
      // strikethrough until the recipient accepts the change.
      return new docx.DeletedTextRun({
        text,
        ...formatting,
        author: revisionAuthor,
        date: revisionDate,
        id: 0,
      });
    default:
      return null;
  }
}

/**
 * Resolve a paragraph's tab stops into docx-js TabStop config.
 */
function buildTabStops(docx: any, stops: NonNullable<ContentBlock['tab_stops']>): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  return stops.map((s) => {
    const typeMap: Record<string, any> = { // eslint-disable-line @typescript-eslint/no-explicit-any
      left: docx.TabStopType.LEFT, right: docx.TabStopType.RIGHT, center: docx.TabStopType.CENTER,
    };
    const leaderMap: Record<string, any> = { // eslint-disable-line @typescript-eslint/no-explicit-any
      dot: docx.LeaderType.DOT, hyphen: docx.LeaderType.HYPHEN, underscore: docx.LeaderType.UNDERSCORE,
    };
    return {
      type: typeMap[s.align ?? 'left'],
      position: s.position === 'right_margin' ? docx.TabStopPosition.MAX : s.position,
      leader: s.leader && s.leader !== 'none' ? leaderMap[s.leader] : undefined,
    };
  });
}

/**
 * Convert a heading level number into the docx-js HeadingLevel enum.
 */
function resolveHeadingLevel(docx: any, level?: number): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (level) {
    case 2: return docx.HeadingLevel.HEADING_2;
    case 3: return docx.HeadingLevel.HEADING_3;
    case 4: return docx.HeadingLevel.HEADING_4;
    case 5: return docx.HeadingLevel.HEADING_5;
    case 6: return docx.HeadingLevel.HEADING_6;
    case 1:
    default: return docx.HeadingLevel.HEADING_1;
  }
}

/**
 * Build one TableCell with proper width, margins, and optional shading.
 */
function buildTableCell(
  docx: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  input: TableCellInput,
  widthDxa: number,
  defaults: { isHeader: boolean; headerShadingHex: string; borderColorHex: string; defaultFont: string; defaultSizeHalfPt: number; firstRowBold: boolean; smartQuotes: boolean },
): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  const rawSpec: TableCellSpec = typeof input === 'string' ? { text: input } : input;
  const spec: TableCellSpec = { ...rawSpec, text: rawSpec.text };
  const borderStyle = defaults.borderColorHex
    ? { style: docx.BorderStyle.SINGLE, size: 1, color: defaults.borderColorHex }
    : { style: docx.BorderStyle.NONE, size: 0, color: 'auto' };
  const borders = { top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle };
  const shadingHex = spec.shading_hex
    ?? (defaults.isHeader && defaults.headerShadingHex ? defaults.headerShadingHex : undefined);
  return new docx.TableCell({
    width: { size: widthDxa, type: docx.WidthType.DXA },
    borders,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    shading: shadingHex ? { fill: shadingHex, type: docx.ShadingType.CLEAR, color: 'auto' } : undefined,
    children: [new docx.Paragraph({
      alignment: resolveAlign(docx, spec.align),
      children: [new docx.TextRun({
        text: defaults.smartQuotes ? smartenQuotes(spec.text ?? '') : (spec.text ?? ''),
        bold: spec.bold ?? (defaults.isHeader && defaults.firstRowBold),
        italics: spec.italic ?? false,
        font: defaults.defaultFont,
        size: defaults.defaultSizeHalfPt,
      })],
    })],
  });
}

/**
 * Render a single ContentBlock into one or more docx-js child objects
 * (paragraphs, tables, TOC entries, etc.). Returns an array; most blocks
 * produce a single element, lists produce one element per item, etc.
 */
function renderBlock(
  docx: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  block: ContentBlock,
  ctx: {
    contentWidthDxa: number;
    defaultFont: string;
    defaultSizeHalfPt: number;
    smartQuotes: boolean;
    revisionAuthor: string;
  },
): unknown[] {
  const smarten = (t: string): string => ctx.smartQuotes ? smartenQuotes(t) : t;
  switch (block.type) {
    case 'heading': {
      const text = smarten(block.text ?? '');
      const runs = [new docx.TextRun({ text, bold: true, font: block.font ?? ctx.defaultFont })];
      return [new docx.Paragraph({
        heading: resolveHeadingLevel(docx, block.level),
        alignment: resolveAlign(docx, block.align),
        children: runs,
      })];
    }
    case 'paragraph': {
      const sizeHalfPt = block.size_pt ? Math.round(block.size_pt * 2) : undefined;
      const run = new docx.TextRun({
        text: smarten(block.text ?? ''),
        bold: block.bold ?? false,
        italics: block.italic ?? false,
        underline: block.underline ? {} : undefined,
        color: block.color,
        size: sizeHalfPt,
        font: block.font ?? ctx.defaultFont,
      });
      // If this paragraph is meant to be an internal-link target, wrap
      // the text run inside a Bookmark so the anchor is anchored to
      // visible content (an empty Bookmark sibling doesn't reliably
      // resolve in Word).
      const children = block.bookmark
        ? [new docx.Bookmark({ id: block.bookmark, children: [run] })]
        : [run];
      return [new docx.Paragraph({
        alignment: resolveAlign(docx, block.align),
        tabStops: block.tab_stops ? buildTabStops(docx, block.tab_stops) : undefined,
        children,
      })];
    }
    case 'paragraph_rich': {
      const runs = (block.runs ?? [])
        .map((r) => buildRunFromSpec(docx, r, block.font ?? ctx.defaultFont, { smartQuotes: ctx.smartQuotes, revisionAuthor: ctx.revisionAuthor }))
        .filter((r) => r !== null);
      // If the paragraph also defines a bookmark anchor, wrap the first
      // text run in a Bookmark element so internal hyperlinks can target
      // this paragraph.
      const children = block.bookmark
        ? [new docx.Bookmark({ id: block.bookmark, children: runs }) as unknown]
        : runs;
      return [new docx.Paragraph({
        alignment: resolveAlign(docx, block.align),
        tabStops: block.tab_stops ? buildTabStops(docx, block.tab_stops) : undefined,
        children,
      })];
    }
    case 'table': {
      const rows = block.rows ?? [];
      if (rows.length === 0) return [];
      const cols = Math.max(...rows.map((r) => r.length));
      if (cols === 0) return [];
      // Default to full-width even-column distribution. Override via
      // column_widths_dxa if the caller has a layout in mind.
      let columnWidths: number[];
      if (block.column_widths_dxa && block.column_widths_dxa.length === cols) {
        columnWidths = block.column_widths_dxa;
      } else {
        const per = Math.floor(ctx.contentWidthDxa / cols);
        columnWidths = new Array(cols).fill(per);
        // Push leftover DXA into the last column so the total matches exactly.
        columnWidths[cols - 1] += ctx.contentWidthDxa - per * cols;
      }
      const headerShadingHex = block.header_shading_hex === '' ? '' : (block.header_shading_hex ?? 'D5E8F0');
      const borderColorHex = block.border_color_hex === '' ? '' : (block.border_color_hex ?? 'CCCCCC');
      const firstRowBold = block.first_row_bold ?? true;
      const tableRows = rows.map((row, rowIdx) => new docx.TableRow({
        children: Array.from({ length: cols }).map((_, c) => buildTableCell(
          docx,
          row[c] ?? '',
          columnWidths[c],
          {
            isHeader: rowIdx === 0,
            headerShadingHex, borderColorHex,
            defaultFont: ctx.defaultFont, defaultSizeHalfPt: ctx.defaultSizeHalfPt, firstRowBold,
            smartQuotes: ctx.smartQuotes,
          },
        )),
      }));
      return [new docx.Table({
        width: { size: ctx.contentWidthDxa, type: docx.WidthType.DXA },
        columnWidths,
        rows: tableRows,
        layout: docx.TableLayoutType.FIXED,
      })];
    }
    case 'bullet_list': {
      const items = block.items ?? [];
      return items.map((item) => new docx.Paragraph({
        numbering: { reference: 'bullets', level: 0 },
        children: [new docx.TextRun({ text: smarten(item), font: ctx.defaultFont })],
      }));
    }
    case 'numbered_list': {
      const items = block.items ?? [];
      return items.map((item) => new docx.Paragraph({
        numbering: { reference: 'numbers', level: 0 },
        children: [new docx.TextRun({ text: smarten(item), font: ctx.defaultFont })],
      }));
    }
    case 'page_break':
      return [new docx.Paragraph({ children: [new docx.PageBreak()] })];
    case 'image': {
      const imgPath = block.path;
      if (!imgPath) return [];
      try {
        if (!fs.existsSync(imgPath)) {
          logger.warn('Word image block: file not found, skipping', { path: imgPath });
          return [];
        }
        const data = fs.readFileSync(imgPath);
        const ext = (block.image_type ?? path.extname(imgPath).slice(1).toLowerCase());
        const widthPx = Math.round((block.width_in ?? 3) * 96); // 1in ≈ 96px
        const heightPx = Math.round((block.height_in ?? 3) * 96);
        const altTitle = block.alt ?? path.basename(imgPath);
        return [new docx.Paragraph({
          children: [new docx.ImageRun({
            type: ext,
            data,
            transformation: { width: widthPx, height: heightPx },
            altText: { title: altTitle, description: altTitle, name: altTitle },
          })],
        })];
      } catch (err) {
        logger.warn('Word image block render failed (non-fatal)', {
          path: imgPath, error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    }
    case 'toc': {
      const title = block.toc_title ?? 'Table of Contents';
      const range = block.toc_heading_levels ?? '1-3';
      return [
        new docx.Paragraph({
          heading: docx.HeadingLevel.HEADING_1,
          children: [new docx.TextRun({ text: title, bold: true, font: ctx.defaultFont })],
        }),
        new docx.TableOfContents(title, { hyperlink: true, headingStyleRange: range }),
      ];
    }
    default:
      return [];
  }
}

async function generateWordBuffer(blocks: ContentBlock[], options: WordDocOptions = {}): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docx: any = await (Function('return import("docx")')());

  const pageKey = options.page_size ?? 'letter';
  const pageDxa = PAGE_SIZES_DXA[pageKey] ?? PAGE_SIZES_DXA.letter;
  const marginIn = options.margin_in ?? 1;
  const marginDxa = Math.round(marginIn * 1440);
  const defaultFont = options.default_font ?? 'Arial';
  const defaultSizePt = options.default_font_size_pt ?? 12;
  const defaultSizeHalfPt = Math.round(defaultSizePt * 2);
  const orientation = options.orientation ?? 'portrait';
  const contentDxa = orientation === 'landscape'
    ? contentWidthDxa(pageDxa.height, marginIn) // landscape: use long edge as content width
    : contentWidthDxa(pageDxa.width, marginIn);

  const smartQuotes = options.smart_quotes ?? false;
  const revisionAuthor = options.revision_author ?? 'Claude';
  const renderCtx = { contentWidthDxa: contentDxa, defaultFont, defaultSizeHalfPt, smartQuotes, revisionAuthor };

  // Render top-level body content.
  const children: unknown[] = [];
  for (const block of blocks) {
    for (const node of renderBlock(docx, block, renderCtx)) children.push(node);
  }

  // Render header / footer if supplied. Each becomes its own
  // Paragraph/Table list. We render via the same renderBlock helper so
  // every supported block type works inside headers and footers too.
  const headerContent = options.header
    ? options.header.flatMap((b) => renderBlock(docx, b, renderCtx))
    : [];
  const footerContent = options.footer
    ? options.footer.flatMap((b) => renderBlock(docx, b, renderCtx))
    : [];
  if (options.footer_includes_page_number) {
    footerContent.push(new docx.Paragraph({
      alignment: docx.AlignmentType.CENTER,
      children: [
        new docx.TextRun({ text: 'Page ', font: defaultFont, size: defaultSizeHalfPt }),
        new docx.TextRun({ children: [docx.PageNumber.CURRENT], font: defaultFont, size: defaultSizeHalfPt }),
        new docx.TextRun({ text: ' of ', font: defaultFont, size: defaultSizeHalfPt }),
        new docx.TextRun({ children: [docx.PageNumber.TOTAL_PAGES], font: defaultFont, size: defaultSizeHalfPt }),
      ],
    }));
  }

  // Footnotes: docx-js expects them keyed by id.
  const footnotes: Record<string, unknown> | undefined = options.footnotes
    ? Object.fromEntries(
      Object.entries(options.footnotes).map(([id, text]) => [
        id,
        { children: [new docx.Paragraph({ children: [new docx.TextRun({ text, font: defaultFont, size: defaultSizeHalfPt })] })] },
      ]),
    )
    : undefined;

  // Multi-column section configuration.
  const columnsCfg = options.columns
    ? {
      count: options.columns.count,
      space: options.columns.space_dxa ?? 720,
      equalWidth: options.columns.equal_width ?? true,
      separate: options.columns.separate ?? false,
    }
    : undefined;

  // Section page setup. Landscape: docx-js swaps width/height
  // internally, so pass portrait dimensions and set orientation.
  const pageSize = {
    width: pageDxa.width,
    height: pageDxa.height,
    orientation: orientation === 'landscape' ? docx.PageOrientation.LANDSCAPE : docx.PageOrientation.PORTRAIT,
  };

  const sectionProps: Record<string, unknown> = {
    page: {
      size: pageSize,
      margin: { top: marginDxa, right: marginDxa, bottom: marginDxa, left: marginDxa },
    },
  };
  if (columnsCfg) sectionProps.column = columnsCfg;

  const section: Record<string, unknown> = { properties: sectionProps, children };
  if (headerContent.length > 0) {
    section.headers = { default: new docx.Header({ children: headerContent }) };
  }
  if (footerContent.length > 0) {
    section.footers = { default: new docx.Footer({ children: footerContent }) };
  }

  const docConfig: Record<string, unknown> = {
    styles: buildStylesConfig(docx, defaultFont, defaultSizeHalfPt),
    numbering: buildNumberingConfig(docx),
    sections: [section],
  };
  if (footnotes) docConfig.footnotes = footnotes;

  const doc = new docx.Document(docConfig);
  return Buffer.from(await docx.Packer.toBuffer(doc));
}

// ── Excel Generation ──
//
// Pre-rewrite this used SheetJS (xlsx) and accepted only plain string
// values. That gave the agent no way to write formulas, number formats,
// colors, comments, or column widths — every spreadsheet came out as
// undifferentiated grey text. Switching to ExcelJS opens the full
// styling surface without adding native dependencies.
//
// The schema stays backward-compatible: rows of plain strings still
// work and render exactly as before. Anywhere a cell can be a string,
// it can now alternatively be a CellSpec object with formula / style /
// number_format / etc.

/** One cell in a sheet. Plain primitives are rendered as values; objects unlock styling. */
type ExcelCellInput = string | number | boolean | null | undefined | ExcelCellSpec;

interface ExcelCellFont {
  name?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Hex without leading '#', e.g. '2E75B6'. */
  color?: string;
}

interface ExcelCellSpec {
  /** Literal value. Numbers stay numeric; strings stay text; booleans stay boolean. */
  value?: string | number | boolean | null;
  /** Excel formula. Leading '=' is optional — the renderer adds it if missing. */
  formula?: string;
  /** Excel number format string. Examples: "$#,##0.00", "0.0%", "yyyy-mm-dd", "[Red](#,##0)". */
  number_format?: string;
  font?: ExcelCellFont;
  /** Cell background fill as hex. */
  fill_hex?: string;
  align?: 'left' | 'center' | 'right' | 'justified';
  v_align?: 'top' | 'middle' | 'bottom';
  /** Add a thin black border on the named side(s). */
  border?: 'all' | 'top' | 'bottom' | 'left' | 'right' | 'none';
  /** Wrap long text. Default false. */
  wrap_text?: boolean;
  /** Cell comment (note). Useful for documenting assumptions on hardcoded inputs. */
  comment?: string;
  /** External hyperlink URL. */
  hyperlink?: string;
}

interface ExcelSheetSpec {
  name: string;
  rows: ExcelCellInput[][];
  /** Per-column widths in character units (Excel's native unit). null/omitted = auto. */
  column_widths?: Array<number | null>;
  /** Number of rows from the top to freeze (e.g. 1 to freeze the header row). */
  freeze_rows?: number;
  /** Number of columns from the left to freeze. */
  freeze_cols?: number;
  /** Apply bold + light-blue fill to the first row automatically. Default true. */
  default_header_row?: boolean;
  /** Sheet zoom level (e.g. 100, 125, 150). */
  zoom_pct?: number;
  /** When true, the sheet is created as hidden (still in the workbook, hidden in the UI). */
  hidden?: boolean;
}

/** Resolve an ExcelCellInput into the value and style pieces ExcelJS expects. */
function applyExcelCell(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cell: any,
  input: ExcelCellInput,
  headerDefault: boolean,
): void {
  // Primitive path: plain string/number/boolean → just set value.
  if (input === undefined || input === null) {
    if (headerDefault) {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD5E8F0' } };
    }
    return;
  }
  if (typeof input !== 'object') {
    cell.value = input;
    if (headerDefault) {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD5E8F0' } };
    }
    return;
  }

  const spec = input as ExcelCellSpec;
  if (spec.formula) {
    // ExcelJS expects `formula` without the leading '='. Strip if the
    // agent passes it the natural Excel way.
    cell.value = { formula: spec.formula.replace(/^=/, ''), result: undefined };
  } else if (spec.value !== undefined) {
    cell.value = spec.value;
  }
  if (spec.hyperlink) {
    cell.value = { text: typeof spec.value === 'string' ? spec.value : (spec.hyperlink), hyperlink: spec.hyperlink };
  }
  if (spec.number_format) cell.numFmt = spec.number_format;

  const fontMerge: Record<string, unknown> = {};
  if (headerDefault) fontMerge.bold = true;
  if (spec.font) {
    if (spec.font.name) fontMerge.name = spec.font.name;
    if (spec.font.size) fontMerge.size = spec.font.size;
    if (spec.font.bold !== undefined) fontMerge.bold = spec.font.bold;
    if (spec.font.italic !== undefined) fontMerge.italic = spec.font.italic;
    if (spec.font.underline !== undefined) fontMerge.underline = spec.font.underline;
    if (spec.font.color) fontMerge.color = { argb: 'FF' + spec.font.color.replace(/^#/, '').toUpperCase() };
  }
  if (Object.keys(fontMerge).length > 0) cell.font = fontMerge;

  const fillHex = spec.fill_hex ?? (headerDefault ? 'D5E8F0' : undefined);
  if (fillHex) {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF' + fillHex.replace(/^#/, '').toUpperCase() },
    };
  }

  if (spec.align || spec.v_align || spec.wrap_text) {
    cell.alignment = {
      horizontal: spec.align,
      vertical: spec.v_align,
      wrapText: spec.wrap_text ?? false,
    };
  }

  if (spec.border && spec.border !== 'none') {
    const line = { style: 'thin', color: { argb: 'FF000000' } };
    const borders: Record<string, unknown> = {};
    if (spec.border === 'all') Object.assign(borders, { top: line, bottom: line, left: line, right: line });
    else borders[spec.border] = line;
    cell.border = borders;
  }

  if (spec.comment) {
    cell.note = { texts: [{ text: spec.comment }] };
  }
}

async function generateExcelBuffer(sheets: ExcelSheetSpec[]): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExcelJSMod: any = await (Function('return import("exceljs")')());
  const ExcelJS = ExcelJSMod.default ?? ExcelJSMod;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'DOJO';
  wb.created = new Date();

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name, {
      properties: { defaultRowHeight: 15 },
      state: sheet.hidden ? 'hidden' : 'visible',
      views: [{
        zoomScale: sheet.zoom_pct,
        state: 'frozen',
        xSplit: sheet.freeze_cols ?? 0,
        ySplit: sheet.freeze_rows ?? (sheet.default_header_row !== false && sheet.rows.length > 0 ? 1 : 0),
      }],
    });

    // Apply column widths up front. ExcelJS sets these per-column via
    // worksheet.columns or worksheet.getColumn(idx).width.
    if (sheet.column_widths) {
      sheet.column_widths.forEach((w, i) => {
        if (w !== null && w !== undefined) ws.getColumn(i + 1).width = w;
      });
    }

    // Default-header-row sentinel: when true (the default), the first
    // row's cells get bold + light-blue fill unless the cell spec
    // overrides those properties explicitly.
    const headerRow = sheet.default_header_row !== false;

    sheet.rows.forEach((row, rIdx) => {
      const wsRow = ws.getRow(rIdx + 1);
      row.forEach((cellInput, cIdx) => {
        const cell = wsRow.getCell(cIdx + 1);
        applyExcelCell(cell, cellInput, headerRow && rIdx === 0);
      });
      wsRow.commit();
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

// ── PowerPoint Generation ──
//
// Pre-rewrite this generated single-layout title+body slides with hard-
// coded x/y positioning. Every deck looked identical and there was no
// way to add shapes, images, tables, or speaker notes. The rewrite adds:
//   - A deck-level theme (colors + font pair + 4:3 vs 16:9 slide size)
//   - Seven layout presets (title, content, two_column, comparison,
//     big_stat, image, blank) that auto-place common content
//   - Free-form `elements[]` per slide for shapes, images, text boxes,
//     tables — each with explicit x/y/w/h
//   - Rich text runs with per-run formatting
//   - Bullet + numbered lists
//   - Speaker notes
//   - Slide background overrides
//
// Backward compatible: a slide with only `{ title, body }` still
// renders exactly like before, with no theme changes.

interface PptxTheme {
  /** Brand primary color (hex without #). Used for titles + accent shapes when nothing more specific is set. */
  primary?: string;
  /** Secondary color. */
  secondary?: string;
  /** Accent color (e.g. for callouts, dividers). */
  accent?: string;
  /** Slide background color. */
  background?: string;
  /** Body text color. */
  text?: string;
  /** Title font. */
  title_font?: string;
  /** Body font. */
  body_font?: string;
  /** Slide size. 'wide' = 16:9 (LAYOUT_WIDE), 'standard' = 4:3 (LAYOUT_4x3). Default 'wide'. */
  slide_size?: 'standard' | 'wide';
}

type PptxTextRun = string | {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  size?: number;
  font?: string;
  /** When true, this run starts on a new line. */
  break?: boolean;
  /** Hyperlink URL. */
  url?: string;
};

/** Plain string or array of runs for mixed-formatting text. */
type PptxTextContent = string | string[] | PptxTextRun[];

interface PptxTextBox {
  type: 'text';
  text: PptxTextContent;
  /** Inches. If omitted, the slide layout's defaults apply. */
  x?: number; y?: number; w?: number; h?: number;
  font_size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  v_align?: 'top' | 'middle' | 'bottom';
  /** Bullet rendering: true = unordered bullet, 'numbered' = 1. 2. 3., false/omitted = no bullets. */
  bullet?: boolean | 'numbered';
  fill_hex?: string;
  font_face?: string;
}

interface PptxShape {
  type: 'shape';
  shape_type: 'rect' | 'rounded_rect' | 'ellipse' | 'triangle' | 'line' | 'arrow';
  x: number; y: number; w: number; h: number;
  fill_hex?: string;
  border_hex?: string;
  border_pt?: number;
  /** Optional text rendered inside the shape. */
  text?: PptxTextContent;
  text_color?: string;
  text_size?: number;
  text_align?: 'left' | 'center' | 'right';
  text_v_align?: 'top' | 'middle' | 'bottom';
}

interface PptxImage {
  type: 'image';
  /** Absolute path to a local file. */
  path?: string;
  /** Remote URL. */
  url?: string;
  /** Base64-encoded data (no data: prefix). */
  data?: string;
  x: number; y: number; w: number; h: number;
  alt?: string;
  /** 'contain' fits inside w/h preserving aspect; 'cover' fills (may crop); default lets pptxgenjs handle it. */
  sizing?: 'contain' | 'cover';
}

interface PptxTable {
  type: 'table';
  rows: PptxTextContent[][];
  x: number; y: number; w: number; h: number;
  /** Apply bold + accent fill to the first row. Default true. */
  header_row?: boolean;
  /** Header row fill hex; defaults to theme.primary or a light grey. */
  header_fill_hex?: string;
  /** Per-column widths in inches. Must sum to roughly w. */
  col_widths?: number[];
}

type PptxElement = PptxTextBox | PptxShape | PptxImage | PptxTable;

interface PptxSlide {
  /** Layout preset. 'blank' = no auto-placed content; use `elements` directly. Default 'content' when title+body are present, 'blank' when only `elements` is given. */
  layout?: 'title' | 'content' | 'two_column' | 'comparison' | 'big_stat' | 'image' | 'blank';
  // Layout-driven content (auto-placed):
  title?: PptxTextContent;
  subtitle?: PptxTextContent;
  /** Body content. For 'content' layout: string or string[] (bullets). For 'comparison'/'two_column': use body_left/body_right instead. */
  body?: PptxTextContent;
  body_left?: PptxTextContent;
  body_right?: PptxTextContent;
  /** Image source for the 'image' layout. */
  image_path?: string;
  image_url?: string;
  /** Large centered statistic for the 'big_stat' layout. */
  stat_value?: string;
  stat_label?: string;
  // Free-form override path:
  elements?: PptxElement[];
  /** Speaker notes for this slide. */
  notes?: string;
  /** Override the slide background color. */
  background_hex?: string;
}

interface PptxOptions {
  theme?: PptxTheme;
}

/** Resolved theme with defaults applied. */
interface ResolvedTheme {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  titleFont: string;
  bodyFont: string;
  slideSize: 'standard' | 'wide';
}

function resolveTheme(theme: PptxTheme | undefined): ResolvedTheme {
  return {
    primary:    theme?.primary    ?? '2E75B6',
    secondary:  theme?.secondary  ?? '4F81BD',
    accent:     theme?.accent     ?? 'C0504D',
    background: theme?.background ?? 'FFFFFF',
    text:       theme?.text       ?? '262626',
    titleFont:  theme?.title_font ?? 'Calibri',
    bodyFont:   theme?.body_font  ?? 'Calibri',
    slideSize:  theme?.slide_size ?? 'wide',
  };
}

/** Map our agent-facing align value to pptxgenjs's string. */
function pptxAlign(a?: 'left' | 'center' | 'right' | 'justify'): 'left' | 'center' | 'right' | 'justify' | undefined {
  return a;
}

/** Convert PptxTextContent → array of runs that pptxgenjs.addText understands. */
function pptxRuns(content: PptxTextContent | undefined, defaultColor: string, defaultFont: string): unknown {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  // Array of strings → each becomes a line with break:true
  if ((content as unknown[]).every((c) => typeof c === 'string')) {
    return (content as string[]).map((s, i) => ({
      text: s,
      options: { breakLine: i < content.length - 1, color: defaultColor, fontFace: defaultFont },
    }));
  }
  // Array of run objects.
  return (content as PptxTextRun[]).map((r) => {
    if (typeof r === 'string') return { text: r, options: { color: defaultColor, fontFace: defaultFont } };
    return {
      text: r.text,
      options: {
        bold: r.bold,
        italic: r.italic,
        underline: r.underline ? { style: 'sng' } : undefined,
        color: r.color ?? defaultColor,
        fontSize: r.size,
        fontFace: r.font ?? defaultFont,
        breakLine: r.break,
        hyperlink: r.url ? { url: r.url } : undefined,
      },
    };
  });
}

/** Map shape_type → pptxgenjs ShapeType. Tolerant of pptxgenjs version differences. */
function pptxShapeType(docx: any, kind: PptxShape['shape_type']): unknown { // eslint-disable-line @typescript-eslint/no-explicit-any
  const map: Record<string, string> = {
    rect: 'rect',
    rounded_rect: 'roundRect',
    ellipse: 'ellipse',
    triangle: 'triangle',
    line: 'line',
    arrow: 'rightArrow',
  };
  // pptxgenjs exposes shape constants on the constructor as `ShapeType`.
  return docx.ShapeType?.[map[kind]] ?? map[kind];
}

/**
 * Render one PptxElement onto a slide. `s` is the pptxgenjs slide handle.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderPptxElement(PptxGenJS: any, s: any, el: PptxElement, theme: ResolvedTheme): void {
  switch (el.type) {
    case 'text': {
      const runs = pptxRuns(el.text, el.color ?? theme.text, el.font_face ?? theme.bodyFont);
      s.addText(runs, {
        x: el.x ?? 0.5, y: el.y ?? 0.5, w: el.w ?? 9, h: el.h ?? 1,
        fontSize: el.font_size,
        bold: el.bold,
        italic: el.italic,
        color: el.color ?? theme.text,
        align: pptxAlign(el.align),
        valign: el.v_align,
        bullet: el.bullet === true ? true : el.bullet === 'numbered' ? { type: 'number' } : undefined,
        fill: el.fill_hex ? { color: el.fill_hex } : undefined,
        fontFace: el.font_face ?? theme.bodyFont,
      });
      return;
    }
    case 'shape': {
      const shapeKind = pptxShapeType(PptxGenJS, el.shape_type);
      s.addShape(shapeKind, {
        x: el.x, y: el.y, w: el.w, h: el.h,
        fill: el.fill_hex ? { color: el.fill_hex } : undefined,
        line: el.border_hex ? { color: el.border_hex, width: el.border_pt ?? 1 } : undefined,
      });
      if (el.text !== undefined) {
        // Text-in-shape is implemented by overlaying a text box at the
        // same coordinates — pptxgenjs supports text on shapes only when
        // the text is supplied at addShape time as the second arg of the
        // newer API. Overlay works across versions.
        s.addText(pptxRuns(el.text, el.text_color ?? theme.text, theme.bodyFont), {
          x: el.x, y: el.y, w: el.w, h: el.h,
          fontSize: el.text_size,
          color: el.text_color ?? theme.text,
          align: pptxAlign(el.text_align),
          valign: el.text_v_align,
        });
      }
      return;
    }
    case 'image': {
      const opts: Record<string, unknown> = { x: el.x, y: el.y, w: el.w, h: el.h };
      if (el.path) opts.path = el.path;
      else if (el.url) opts.path = el.url;
      else if (el.data) opts.data = `data:image/png;base64,${el.data}`;
      if (el.alt) opts.altText = el.alt;
      if (el.sizing === 'contain') opts.sizing = { type: 'contain', w: el.w, h: el.h };
      else if (el.sizing === 'cover') opts.sizing = { type: 'cover', w: el.w, h: el.h };
      try {
        s.addImage(opts);
      } catch (err) {
        logger.warn('PPTX image element failed to render', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    case 'table': {
      const headerRow = el.header_row !== false;
      const headerFill = el.header_fill_hex ?? theme.primary;
      const rows = el.rows.map((row, rIdx) => row.map((cell) => {
        const isHeader = headerRow && rIdx === 0;
        const cellRuns = pptxRuns(cell, isHeader ? 'FFFFFF' : theme.text, theme.bodyFont);
        // pptxgenjs cell format: { text, options }
        return {
          text: cellRuns,
          options: {
            bold: isHeader || undefined,
            fill: isHeader ? { color: headerFill } : undefined,
            color: isHeader ? 'FFFFFF' : theme.text,
            fontFace: theme.bodyFont,
            valign: 'middle' as const,
          },
        };
      }));
      s.addTable(rows, {
        x: el.x, y: el.y, w: el.w, h: el.h,
        colW: el.col_widths,
        border: { type: 'solid', pt: 1, color: 'CCCCCC' },
      });
      return;
    }
  }
}

/**
 * Auto-place layout-driven content (title, body, etc.) before any
 * free-form `elements[]` get rendered on top.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function placeLayoutContent(PptxGenJS: any, s: any, slide: PptxSlide, theme: ResolvedTheme, slideW: number): void {
  // The seven layouts each have a default content placement. Anything
  // the slide also supplies via `elements` gets rendered AFTER, on top.
  const layout = slide.layout ?? (slide.elements && slide.title === undefined ? 'blank' : 'content');
  const midX = slideW / 2;
  switch (layout) {
    case 'blank':
      return;
    case 'title': {
      if (slide.title !== undefined) {
        s.addText(pptxRuns(slide.title, theme.primary, theme.titleFont), {
          x: 0.5, y: 2.2, w: slideW - 1, h: 1.5,
          fontSize: 44, bold: true, align: 'center', color: theme.primary, fontFace: theme.titleFont,
        });
      }
      if (slide.subtitle !== undefined) {
        s.addText(pptxRuns(slide.subtitle, theme.text, theme.bodyFont), {
          x: 0.5, y: 3.8, w: slideW - 1, h: 0.8,
          fontSize: 22, align: 'center', color: theme.text, fontFace: theme.bodyFont,
        });
      }
      return;
    }
    case 'content': {
      if (slide.title !== undefined) {
        s.addText(pptxRuns(slide.title, theme.primary, theme.titleFont), {
          x: 0.5, y: 0.3, w: slideW - 1, h: 0.9,
          fontSize: 32, bold: true, color: theme.primary, fontFace: theme.titleFont,
        });
      }
      if (slide.body !== undefined) {
        const isBullets = Array.isArray(slide.body) && slide.body.every((b) => typeof b === 'string');
        s.addText(pptxRuns(slide.body, theme.text, theme.bodyFont), {
          x: 0.5, y: 1.3, w: slideW - 1, h: 4.5,
          fontSize: 18, color: theme.text, fontFace: theme.bodyFont,
          bullet: isBullets ? true : undefined,
        });
      }
      return;
    }
    case 'two_column': {
      if (slide.title !== undefined) {
        s.addText(pptxRuns(slide.title, theme.primary, theme.titleFont), {
          x: 0.5, y: 0.3, w: slideW - 1, h: 0.9,
          fontSize: 32, bold: true, color: theme.primary, fontFace: theme.titleFont,
        });
      }
      const colW = (slideW - 1.5) / 2;
      const isLeftBullets = Array.isArray(slide.body_left) && (slide.body_left as unknown[]).every((b) => typeof b === 'string');
      const isRightBullets = Array.isArray(slide.body_right) && (slide.body_right as unknown[]).every((b) => typeof b === 'string');
      if (slide.body_left !== undefined) {
        s.addText(pptxRuns(slide.body_left, theme.text, theme.bodyFont), {
          x: 0.5, y: 1.3, w: colW, h: 4.5, fontSize: 18, color: theme.text, fontFace: theme.bodyFont,
          bullet: isLeftBullets ? true : undefined,
        });
      }
      if (slide.body_right !== undefined) {
        s.addText(pptxRuns(slide.body_right, theme.text, theme.bodyFont), {
          x: 0.5 + colW + 0.5, y: 1.3, w: colW, h: 4.5, fontSize: 18, color: theme.text, fontFace: theme.bodyFont,
          bullet: isRightBullets ? true : undefined,
        });
      }
      return;
    }
    case 'comparison': {
      // Same as two_column but with column headers and a vertical
      // divider line drawn between the two halves.
      if (slide.title !== undefined) {
        s.addText(pptxRuns(slide.title, theme.primary, theme.titleFont), {
          x: 0.5, y: 0.3, w: slideW - 1, h: 0.9,
          fontSize: 32, bold: true, color: theme.primary, fontFace: theme.titleFont,
        });
      }
      const colW = (slideW - 1.5) / 2;
      s.addShape(pptxShapeType(PptxGenJS, 'line'), {
        x: midX, y: 1.3, w: 0, h: 4.5,
        line: { color: theme.accent, width: 1 },
      });
      if (slide.body_left !== undefined) {
        const isLeftBullets = Array.isArray(slide.body_left) && (slide.body_left as unknown[]).every((b) => typeof b === 'string');
        s.addText(pptxRuns(slide.body_left, theme.text, theme.bodyFont), {
          x: 0.5, y: 1.3, w: colW, h: 4.5, fontSize: 18, color: theme.text, fontFace: theme.bodyFont,
          bullet: isLeftBullets ? true : undefined,
        });
      }
      if (slide.body_right !== undefined) {
        const isRightBullets = Array.isArray(slide.body_right) && (slide.body_right as unknown[]).every((b) => typeof b === 'string');
        s.addText(pptxRuns(slide.body_right, theme.text, theme.bodyFont), {
          x: 0.5 + colW + 0.5, y: 1.3, w: colW, h: 4.5, fontSize: 18, color: theme.text, fontFace: theme.bodyFont,
          bullet: isRightBullets ? true : undefined,
        });
      }
      return;
    }
    case 'big_stat': {
      if (slide.title !== undefined) {
        s.addText(pptxRuns(slide.title, theme.text, theme.bodyFont), {
          x: 0.5, y: 0.3, w: slideW - 1, h: 0.7,
          fontSize: 20, align: 'center', color: theme.text, fontFace: theme.bodyFont,
        });
      }
      if (slide.stat_value !== undefined) {
        s.addText(slide.stat_value, {
          x: 0.5, y: 1.5, w: slideW - 1, h: 2.5,
          fontSize: 120, bold: true, align: 'center', color: theme.primary, fontFace: theme.titleFont,
        });
      }
      if (slide.stat_label !== undefined) {
        s.addText(pptxRuns(slide.stat_label, theme.text, theme.bodyFont), {
          x: 0.5, y: 4.2, w: slideW - 1, h: 0.8,
          fontSize: 24, align: 'center', color: theme.text, fontFace: theme.bodyFont,
        });
      }
      return;
    }
    case 'image': {
      if (slide.title !== undefined) {
        s.addText(pptxRuns(slide.title, theme.primary, theme.titleFont), {
          x: 0.5, y: 0.3, w: slideW - 1, h: 0.7,
          fontSize: 28, bold: true, color: theme.primary, fontFace: theme.titleFont,
        });
      }
      if (slide.image_path || slide.image_url) {
        s.addImage({
          path: slide.image_path ?? slide.image_url,
          x: 1, y: 1.2, w: slideW - 2, h: 4.5,
          sizing: { type: 'contain', w: slideW - 2, h: 4.5 },
        });
      }
      if (slide.body !== undefined) {
        s.addText(pptxRuns(slide.body, theme.text, theme.bodyFont), {
          x: 0.5, y: 6, w: slideW - 1, h: 0.8,
          fontSize: 16, align: 'center', color: theme.text, fontFace: theme.bodyFont,
        });
      }
      return;
    }
  }
}

async function generatePptxBuffer(
  slides: PptxSlide[],
  options: PptxOptions = {},
): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pptxMod: any = await (Function('return import("pptxgenjs")')());
  // pptxgenjs ships as a CJS module with a default export class. The
  // ESM/CJS interop can layer the class one or two levels deep depending
  // on the loader (tsx differs from plain Node here). Unwrap until we
  // hit a constructor.
  let PptxGenJS: any = pptxMod; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let i = 0; i < 3 && typeof PptxGenJS !== 'function'; i++) {
    PptxGenJS = PptxGenJS?.default ?? PptxGenJS;
  }
  if (typeof PptxGenJS !== 'function') {
    throw new Error('pptxgenjs did not expose a constructor — module shape changed?');
  }
  const pptx = new PptxGenJS();
  pptx.author = 'DOJO';
  pptx.company = '';
  pptx.title = '';

  const theme = resolveTheme(options.theme);
  pptx.layout = theme.slideSize === 'standard' ? 'LAYOUT_4x3' : 'LAYOUT_WIDE';

  // pptxgenjs maps LAYOUT_4x3 to 10x7.5 and LAYOUT_WIDE to 13.333x7.5.
  const slideW = theme.slideSize === 'standard' ? 10 : 13.333;

  for (const slide of slides) {
    const s = pptx.addSlide();
    if (slide.background_hex) {
      s.background = { color: slide.background_hex };
    } else if (theme.background && theme.background !== 'FFFFFF') {
      s.background = { color: theme.background };
    }
    placeLayoutContent(PptxGenJS, s, slide, theme, slideW);
    if (slide.elements) {
      for (const el of slide.elements) {
        renderPptxElement(PptxGenJS, s, el, theme);
      }
    }
    if (slide.notes) s.addNotes(slide.notes);
  }

  const arrayBuffer = await pptx.write({ outputType: 'arraybuffer' }) as ArrayBuffer;
  return Buffer.from(arrayBuffer);
}

// ── Tool Execution ──

const officeToolDefByName = new Map(officeToolDefinitions.map(t => [t.name, t]));

/**
 * Three tiers of gating (see the filter in agent/tools.ts):
 *   - CREATE tools work locally: they only need the npm packages (docx,
 *     exceljs, pptxgenjs) and write to disk. Granted to every agent.
 *   - LOCAL EDIT/READ tools (Word AND Excel) also work locally: they accept a
 *     `path` and read/manipulate/write the .docx or .xlsx on disk (they still
 *     accept a OneDrive file_id when Microsoft is connected). Granted alongside
 *     the creates so a local-only setup can EDIT in place instead of
 *     regenerating. Exposed as two honestly-named arrays,
 *     officeWordEditToolDefinitions and officeExcelEditToolDefinitions, so the
 *     array name cannot hide that Excel is a local-granted member (that mislabel
 *     is what dropped all 11 from the docs index).
 *   - The remaining EDIT/READ tools (PowerPoint slide ops and any other
 *     Graph-backed office op) genuinely need the Graph connection, so they stay
 *     gated behind full Microsoft access.
 */
const OFFICE_CREATE_TOOL_NAMES = new Set([
  'office_create_word_document',
  'office_create_spreadsheet',
  'office_create_presentation',
]);
const OFFICE_WORD_EDIT_TOOL_NAMES = new Set([
  'office_append_to_word_document',
  'office_get_word_document_outline',
  'office_read_word_document',
  'office_replace_in_word_document',
  'office_insert_in_word_document',
  'office_delete_block_in_word_document',
]);
const OFFICE_EXCEL_EDIT_TOOL_NAMES = new Set([
  'office_get_spreadsheet_range',
  'office_write_spreadsheet_range',
  'office_append_spreadsheet_rows',
  'office_add_sheet',
  'office_delete_sheet',
]);
// Union of the two local-capable edit sets. Kept for the Graph-only negative
// filter below; callers granting local edit push the Word and Excel arrays.
const OFFICE_LOCAL_EDIT_TOOL_NAMES = new Set([...OFFICE_WORD_EDIT_TOOL_NAMES, ...OFFICE_EXCEL_EDIT_TOOL_NAMES]);
export const officeCreateToolDefinitions: ToolDefinition[] = officeToolDefinitions.filter(t => OFFICE_CREATE_TOOL_NAMES.has(t.name));
// Word edit/read tools, local-capable (path-based), granted without Microsoft.
export const officeWordEditToolDefinitions: ToolDefinition[] = officeToolDefinitions.filter(t => OFFICE_WORD_EDIT_TOOL_NAMES.has(t.name));
// Excel range/sheet edit tools, ALSO local-capable (path-based) and granted
// without Microsoft alongside the Word set. This is its own honestly-named
// array on purpose: folding these into a "Word" list is exactly what let all
// 11 local edit tools drop out of the docs index (getAllToolDefinitions),
// so load_tool_docs answered "Tools not found" for tools the model could see.
export const officeExcelEditToolDefinitions: ToolDefinition[] = officeToolDefinitions.filter(t => OFFICE_EXCEL_EDIT_TOOL_NAMES.has(t.name));
// Everything else (PowerPoint edit/read), Graph-only, Microsoft required.
export const officeEditToolDefinitions: ToolDefinition[] = officeToolDefinitions.filter(
  t => !OFFICE_CREATE_TOOL_NAMES.has(t.name) && !OFFICE_LOCAL_EDIT_TOOL_NAMES.has(t.name),
);

export async function executeOfficeTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  const { validateAgainstSchema } = await import('../agent/tool-helpers.js');
  const def = officeToolDefByName.get(name);
  const schemaErr = validateAgainstSchema(name, def?.input_schema as Parameters<typeof validateAgainstSchema>[1], args);
  if (schemaErr) return schemaErr;

  switch (name) {
    case 'office_create_word_document': {
      try {
        let filename = args.filename as string;
        if (!filename.endsWith('.docx')) filename += '.docx';
        const blocks = args.content as ContentBlock[];
        const folderId = args.folder_id as string | undefined;

        // Top-level document options (page setup, default font,
        // headers/footers, footnotes, columns). Anything omitted falls
        // back to the renderer's sensible defaults (US Letter, 1"
        // margins, Arial 12pt, full-width tables).
        const docOptions: WordDocOptions = {
          page_size: args.page_size as WordDocOptions['page_size'],
          orientation: args.orientation as WordDocOptions['orientation'],
          margin_in: args.margin_in as number | undefined,
          default_font: args.default_font as string | undefined,
          default_font_size_pt: args.default_font_size_pt as number | undefined,
          header: args.header as ContentBlock[] | undefined,
          footer: args.footer as ContentBlock[] | undefined,
          footer_includes_page_number: args.footer_includes_page_number as boolean | undefined,
          footnotes: args.footnotes as Record<string, string> | undefined,
          columns: args.columns as WordDocOptions['columns'],
          smart_quotes: args.smart_quotes as boolean | undefined,
          revision_author: args.revision_author as string | undefined,
        };
        const buffer = await generateWordBuffer(blocks, docOptions);
        const summary = await saveOfficeBuffer(buffer, filename, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', agentId, folderId, 'word');
        logMicrosoftActivity({ agentId, agentName, action: 'office_create_word_document', actionType: 'write', details: JSON.stringify({ filename }), apiEndpoint: 'drive/upload', success: true });
        return summary;
      } catch (err) {
        return `Error creating Word document: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_append_to_word_document': {
      try {
        const target = await resolveOfficeEditTarget(args, '.docx');
        if (typeof target === 'string') return target;
        const blocks = args.content as ContentBlock[];

        // v2.5.10 — actually append now. Previously this re-generated the
        // doc from scratch and overwrote the original (despite the name).
        const existingBuffer = await target.read();
        const zip = await JSZip.loadAsync(existingBuffer);
        const docFile = zip.file('word/document.xml');
        if (!docFile) return 'Error: existing file is missing word/document.xml — not a valid Word doc?';
        const documentXml = await docFile.async('string');
        const { prefix, bodyInner, suffix } = splitDocumentXml(documentXml);

        const newInner = await blocksToBodyInnerXml(blocks);
        const updatedDocXml = prefix + bodyInner + newInner + suffix;
        const updatedBuffer = await rewriteDocumentXml(existingBuffer, updatedDocXml);

        const w = await target.writeBack(updatedBuffer, DOCX_MIME);
        logMicrosoftActivity({ agentId, agentName, action: 'office_append_to_word_document', actionType: 'write', details: JSON.stringify({ local: target.isLocal, blocksAppended: blocks.length }), apiEndpoint: target.isLocal ? 'local' : 'drive/upload', success: true });
        return `Word document "${w.name}" updated (${blocks.length} block(s) appended).\n${w.ref}`;
      } catch (err) {
        return `Error appending to document: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_get_word_document_outline': {
      try {
        const target = await resolveOfficeEditTarget(args, '.docx');
        if (typeof target === 'string') return target;
        const buf = await target.read();
        const zip = await JSZip.loadAsync(buf);
        const docFile = zip.file('word/document.xml');
        if (!docFile) return 'Error: file is missing word/document.xml — not a valid Word doc?';
        const xml = await docFile.async('string');
        const { bodyInner } = splitDocumentXml(xml);
        const blocks = parseBodyBlocks(bodyInner);
        const outline = blocks.map((b, idx) => {
          if (b.startsWith('<w:tbl')) {
            return { index: idx, type: 'table', preview: '[table]' };
          }
          const { text, isHeading, level } = paragraphPreview(b);
          const previewText = text.length > 80 ? text.slice(0, 80) + '…' : text;
          return {
            index: idx,
            type: isHeading ? `heading-${level ?? 1}` : 'paragraph',
            preview: previewText || '[empty]',
          };
        });
        logMicrosoftActivity({ agentId, agentName, action: 'office_get_word_document_outline', actionType: 'read', details: JSON.stringify({ local: target.isLocal, blockCount: outline.length }), apiEndpoint: target.isLocal ? 'local' : 'drive/download', success: true });
        return JSON.stringify({ file: target.name, ...(target.isLocal ? { path: target.handle } : { file_id: target.handle }), blocks: outline });
      } catch (err) {
        return `Error reading document outline: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_read_word_document': {
      try {
        const target = await resolveOfficeEditTarget(args, '.docx');
        if (typeof target === 'string') return target;
        const offset = Math.max(0, Math.floor((args.offset as number | undefined) ?? 0));
        const limit = Math.min(500, Math.max(1, Math.floor((args.limit as number | undefined) ?? 200)));
        const format = (args.format as string | undefined) === 'json' ? 'json' : 'text';
        const buf = await target.read();
        const zip = await JSZip.loadAsync(buf);
        const docFile = zip.file('word/document.xml');
        if (!docFile) return 'Error: file is missing word/document.xml — not a valid Word doc?';
        const xml = await docFile.async('string');
        const { bodyInner } = splitDocumentXml(xml);
        const blocks = parseBodyBlocks(bodyInner);
        const meta = { name: target.name };
        const totalBlocks = blocks.length;
        const slice = blocks.slice(offset, offset + limit);

        type ReadBlock =
          | { index: number; type: 'paragraph'; text: string }
          | { index: number; type: 'heading'; level: number; text: string }
          | { index: number; type: 'table'; rows: string[][] };
        const parsed: ReadBlock[] = slice.map((b, i) => {
          const idx = offset + i;
          if (b.startsWith('<w:tbl')) {
            return { index: idx, type: 'table', rows: extractTableText(b) };
          }
          const { text, isHeading, level } = paragraphPreview(b);
          if (isHeading) {
            return { index: idx, type: 'heading', level: level ?? 1, text };
          }
          return { index: idx, type: 'paragraph', text };
        });

        logMicrosoftActivity({ agentId, agentName, action: 'office_read_word_document', actionType: 'read', details: JSON.stringify({ local: target.isLocal, offset, returned: parsed.length, totalBlocks }), apiEndpoint: target.isLocal ? 'local' : 'drive/download', success: true });

        if (format === 'json') {
          return JSON.stringify({
            file: meta.name,
            ...(target.isLocal ? { path: target.handle } : { file_id: target.handle }),
            total_blocks: totalBlocks,
            offset,
            returned: parsed.length,
            has_more: offset + parsed.length < totalBlocks,
            blocks: parsed,
          });
        }

        // Plain-text mode: clean transcript with markdown-style formatting.
        const lines: string[] = [];
        lines.push(`# ${meta.name}`);
        lines.push(`[blocks ${offset}–${offset + parsed.length - 1} of ${totalBlocks}]`);
        lines.push('');
        for (const b of parsed) {
          if (b.type === 'heading') {
            lines.push(`${'#'.repeat(Math.min(6, b.level + 1))} ${b.text || '[empty heading]'}`);
            lines.push('');
          } else if (b.type === 'paragraph') {
            lines.push(b.text || '');
            lines.push('');
          } else {
            // table — render as markdown table
            const rows = b.rows;
            if (rows.length === 0) {
              lines.push('[empty table]');
            } else {
              const colCount = Math.max(...rows.map(r => r.length));
              for (let r = 0; r < rows.length; r++) {
                const padded = [...rows[r]];
                while (padded.length < colCount) padded.push('');
                lines.push('| ' + padded.map(c => c.replace(/\|/g, '\\|')).join(' | ') + ' |');
                if (r === 0) {
                  lines.push('|' + ' --- |'.repeat(colCount));
                }
              }
            }
            lines.push('');
          }
        }
        if (offset + parsed.length < totalBlocks) {
          lines.push(`[truncated — ${totalBlocks - offset - parsed.length} more blocks. Call office_read_word_document(${target.isLocal ? `path="${target.handle}"` : `file_id="${target.handle}"`}, offset=${offset + parsed.length}) for the next slice.]`);
        }
        return lines.join('\n').trim();
      } catch (err) {
        return `Error reading document: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_replace_in_word_document': {
      try {
        const target = await resolveOfficeEditTarget(args, '.docx');
        if (typeof target === 'string') return target;
        const find = args.find as string;
        const replace = args.replace as string;
        if (!find) return 'Error: find cannot be empty';

        const existingBuffer = await target.read();
        const zip = await JSZip.loadAsync(existingBuffer);
        const docFile = zip.file('word/document.xml');
        if (!docFile) return 'Error: file is missing word/document.xml — not a valid Word doc?';
        const documentXml = await docFile.async('string');
        const { newXml, replacements } = replaceTextInDocumentXml(documentXml, find, replace);
        if (replacements === 0) {
          return `No matches for "${find}" found in the document. Note: find/replace only matches text within a single formatted run — text spanning bold/italic boundaries can't be matched this way.`;
        }
        const updatedBuffer = await rewriteDocumentXml(existingBuffer, newXml);
        const w = await target.writeBack(updatedBuffer, DOCX_MIME);
        logMicrosoftActivity({ agentId, agentName, action: 'office_replace_in_word_document', actionType: 'write', details: JSON.stringify({ local: target.isLocal, replacements }), apiEndpoint: target.isLocal ? 'local' : 'drive/upload', success: true });
        return `Replaced ${replacements} occurrence(s) of "${find}" in "${w.name}".\n${w.ref}`;
      } catch (err) {
        return `Error replacing text: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_insert_in_word_document': {
      try {
        const target = await resolveOfficeEditTarget(args, '.docx');
        if (typeof target === 'string') return target;
        const position = args.position as number;
        const blocks = args.content as ContentBlock[];

        const existingBuffer = await target.read();
        const zip = await JSZip.loadAsync(existingBuffer);
        const docFile = zip.file('word/document.xml');
        if (!docFile) return 'Error: file is missing word/document.xml — not a valid Word doc?';
        const documentXml = await docFile.async('string');
        const { prefix, bodyInner, suffix } = splitDocumentXml(documentXml);
        const existingBlocks = parseBodyBlocks(bodyInner);

        if (position < 0 || position > existingBlocks.length) {
          return `Error: position ${position} out of range. Document has ${existingBlocks.length} blocks (valid positions: 0 to ${existingBlocks.length}).`;
        }
        const newInner = await blocksToBodyInnerXml(blocks);
        const before = existingBlocks.slice(0, position).join('');
        const after = existingBlocks.slice(position).join('');
        const updatedBodyInner = before + newInner + after;
        const updatedDocXml = prefix + updatedBodyInner + suffix;
        const updatedBuffer = await rewriteDocumentXml(existingBuffer, updatedDocXml);
        const w = await target.writeBack(updatedBuffer, DOCX_MIME);
        logMicrosoftActivity({ agentId, agentName, action: 'office_insert_in_word_document', actionType: 'write', details: JSON.stringify({ local: target.isLocal, position, blocksInserted: blocks.length }), apiEndpoint: target.isLocal ? 'local' : 'drive/upload', success: true });
        return `Inserted ${blocks.length} block(s) at position ${position} in "${w.name}".\n${w.ref}`;
      } catch (err) {
        return `Error inserting blocks: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_delete_block_in_word_document': {
      try {
        const target = await resolveOfficeEditTarget(args, '.docx');
        if (typeof target === 'string') return target;
        const start = args.start as number;
        const count = (args.count as number | undefined) ?? 1;
        if (count < 1) return 'Error: count must be at least 1';

        const existingBuffer = await target.read();
        const zip = await JSZip.loadAsync(existingBuffer);
        const docFile = zip.file('word/document.xml');
        if (!docFile) return 'Error: file is missing word/document.xml — not a valid Word doc?';
        const documentXml = await docFile.async('string');
        const { prefix, bodyInner, suffix } = splitDocumentXml(documentXml);
        const existingBlocks = parseBodyBlocks(bodyInner);

        if (start < 0 || start >= existingBlocks.length) {
          return `Error: start ${start} out of range. Document has ${existingBlocks.length} blocks (valid indexes: 0 to ${existingBlocks.length - 1}).`;
        }
        const actualCount = Math.min(count, existingBlocks.length - start);
        const updatedBlocks = [...existingBlocks.slice(0, start), ...existingBlocks.slice(start + actualCount)];
        const updatedDocXml = prefix + updatedBlocks.join('') + suffix;
        const updatedBuffer = await rewriteDocumentXml(existingBuffer, updatedDocXml);
        const w = await target.writeBack(updatedBuffer, DOCX_MIME);
        logMicrosoftActivity({ agentId, agentName, action: 'office_delete_block_in_word_document', actionType: 'write', details: JSON.stringify({ local: target.isLocal, start, count: actualCount }), apiEndpoint: target.isLocal ? 'local' : 'drive/upload', success: true });
        return `Deleted ${actualCount} block(s) starting at position ${start} in "${w.name}".\n${w.ref}`;
      } catch (err) {
        return `Error deleting blocks: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_get_spreadsheet_range': {
      try {
        const sheetName = args.sheet_name as string | undefined;
        const range = args.range as string | undefined;

        const lp = localXlsxPath(args);
        if (lp) {
          if (!fs.existsSync(lp)) return `Error: no file found at ${lp}.`;
          const wb = await loadLocalWorkbook(lp);
          const ws = resolveLocalSheet(wb, sheetName);
          if (!ws) return `Error: sheet "${sheetName ?? '(first)'}" not found. Sheets: ${wb.worksheets.map((w: { name: string }) => w.name).join(', ')}.`;
          const bounds = range ? parseA1Range(range) : { startRow: 1, startCol: 1, endRow: Math.max(1, ws.rowCount), endCol: Math.max(1, ws.columnCount) };
          if (!bounds) return `Error: could not parse range "${range}". Use A1 notation like "A1:C10".`;
          const values: unknown[][] = [];
          for (let r = bounds.startRow; r <= bounds.endRow; r++) {
            const row: unknown[] = [];
            for (let c = bounds.startCol; c <= bounds.endCol; c++) row.push(plainCellValue(ws.getCell(r, c)));
            values.push(row);
          }
          logMicrosoftActivity({ agentId, agentName, action: 'office_get_spreadsheet_range', actionType: 'read', details: JSON.stringify({ local: true, sheet: ws.name, range }), apiEndpoint: 'local', success: true });
          return JSON.stringify({ sheet: ws.name, address: range ?? 'usedRange', values });
        }

        const fileId = args.file_id as string;
        const token = await getValidAccessToken();
        if (!token) return 'Error: Not authenticated with Microsoft';

        // Resolve sheet name if not specified — use the first one
        const sheetSegment = sheetName
          ? `worksheets('${encodeURIComponent(sheetName)}')`
          : `worksheets/$/Default`; // workbook default sheet
        let url: string;
        if (sheetName) {
          if (range) {
            url = `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/workbook/${sheetSegment}/range(address='${encodeURIComponent(range)}')`;
          } else {
            url = `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/workbook/${sheetSegment}/usedRange`;
          }
        } else {
          // Get the first sheet via listing then read
          const listResp = await fetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/workbook/worksheets`, { headers: { Authorization: `Bearer ${token}` } });
          if (!listResp.ok) return `Error listing worksheets: HTTP ${listResp.status}`;
          const listData = await listResp.json() as { value?: Array<{ name: string }> };
          const firstSheet = listData.value?.[0]?.name;
          if (!firstSheet) return 'Error: workbook has no worksheets';
          const seg = `worksheets('${encodeURIComponent(firstSheet)}')`;
          url = range
            ? `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/workbook/${seg}/range(address='${encodeURIComponent(range)}')`
            : `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/workbook/${seg}/usedRange`;
        }
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!resp.ok) return `Error reading range: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`;
        const data = await resp.json() as { values?: unknown[][]; address?: string };
        logMicrosoftActivity({ agentId, agentName, action: 'office_get_spreadsheet_range', actionType: 'read', details: JSON.stringify({ fileId, sheetName, range }), apiEndpoint: 'workbook/range', success: true });
        return JSON.stringify({ address: data.address, values: data.values ?? [] });
      } catch (err) {
        return `Error reading spreadsheet range: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_write_spreadsheet_range': {
      try {
        const sheetName = args.sheet_name as string | undefined;
        const range = args.range as string;
        const values = args.values as unknown[][];
        if (!range) return 'Error: range is required';
        if (!Array.isArray(values) || !Array.isArray(values[0])) return 'Error: values must be a 2D array';

        const lp = localXlsxPath(args);
        if (lp) {
          if (!fs.existsSync(lp)) return `Error: no file found at ${lp}.`;
          const bounds = parseA1Range(range);
          if (!bounds) return `Error: could not parse range "${range}". Use A1 notation like "A1".`;
          const wb = await loadLocalWorkbook(lp);
          const ws = resolveLocalSheet(wb, sheetName);
          if (!ws) return `Error: sheet "${sheetName ?? '(first)'}" not found.`;
          for (let i = 0; i < values.length; i++) {
            const rowVals = values[i] as unknown[];
            for (let j = 0; j < rowVals.length; j++) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ws.getCell(bounds.startRow + i, bounds.startCol + j).value = rowVals[j] as any;
            }
          }
          await wb.xlsx.writeFile(lp);
          logMicrosoftActivity({ agentId, agentName, action: 'office_write_spreadsheet_range', actionType: 'write', details: JSON.stringify({ local: true, sheet: ws.name, range, rowCount: values.length }), apiEndpoint: 'local', success: true });
          return `Wrote ${values.length} row(s) to ${ws.name}!${range}. Saved to ${lp}.`;
        }

        const fileId = args.file_id as string;
        const token = await getValidAccessToken();
        if (!token) return 'Error: Not authenticated with Microsoft';

        let resolvedSheet = sheetName;
        if (!resolvedSheet) {
          const listResp = await fetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/workbook/worksheets`, { headers: { Authorization: `Bearer ${token}` } });
          if (!listResp.ok) return `Error listing worksheets: HTTP ${listResp.status}`;
          const listData = await listResp.json() as { value?: Array<{ name: string }> };
          resolvedSheet = listData.value?.[0]?.name;
          if (!resolvedSheet) return 'Error: workbook has no worksheets';
        }
        const url = `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/workbook/worksheets('${encodeURIComponent(resolvedSheet)}')/range(address='${encodeURIComponent(range)}')`;
        const resp = await fetch(url, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values }),
        });
        if (!resp.ok) return `Error writing range: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`;
        logMicrosoftActivity({ agentId, agentName, action: 'office_write_spreadsheet_range', actionType: 'write', details: JSON.stringify({ fileId, sheetName: resolvedSheet, range, rowCount: values.length }), apiEndpoint: 'workbook/range', success: true });
        const meta = await getFileMeta(fileId);
        return `Wrote ${values.length} row(s) to ${resolvedSheet}!${range} in "${meta.name}".\nFile ID: ${fileId}`;
      } catch (err) {
        return `Error writing range: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_append_spreadsheet_rows': {
      try {
        const sheetName = args.sheet_name as string | undefined;
        const rows = args.rows as unknown[][];
        if (!Array.isArray(rows) || rows.length === 0) return 'Error: rows must be a non-empty 2D array';

        const lp = localXlsxPath(args);
        if (lp) {
          if (!fs.existsSync(lp)) return `Error: no file found at ${lp}.`;
          const wb = await loadLocalWorkbook(lp);
          const ws = resolveLocalSheet(wb, sheetName);
          if (!ws) return `Error: sheet "${sheetName ?? '(first)'}" not found.`;
          for (const row of rows) ws.addRow(row as unknown[]);
          await wb.xlsx.writeFile(lp);
          logMicrosoftActivity({ agentId, agentName, action: 'office_append_spreadsheet_rows', actionType: 'write', details: JSON.stringify({ local: true, sheet: ws.name, rowCount: rows.length }), apiEndpoint: 'local', success: true });
          return `Appended ${rows.length} row(s) to ${ws.name}. Saved to ${lp}.`;
        }

        const fileId = args.file_id as string;
        const token = await getValidAccessToken();
        if (!token) return 'Error: Not authenticated with Microsoft';

        let resolvedSheet = sheetName;
        if (!resolvedSheet) {
          const listResp = await fetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/workbook/worksheets`, { headers: { Authorization: `Bearer ${token}` } });
          if (!listResp.ok) return `Error listing worksheets: HTTP ${listResp.status}`;
          const listData = await listResp.json() as { value?: Array<{ name: string }> };
          resolvedSheet = listData.value?.[0]?.name;
          if (!resolvedSheet) return 'Error: workbook has no worksheets';
        }

        // Find the next empty row: read usedRange.address to get the bottom-right cell.
        const usedResp = await fetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/workbook/worksheets('${encodeURIComponent(resolvedSheet)}')/usedRange?$select=address,rowCount,columnCount`, { headers: { Authorization: `Bearer ${token}` } });
        let firstAppendRow = 1;
        if (usedResp.ok) {
          const usedData = await usedResp.json() as { rowIndex?: number; rowCount?: number };
          firstAppendRow = (usedData.rowIndex ?? 0) + (usedData.rowCount ?? 0) + 1;
        }
        const colCount = (rows[0] as unknown[]).length;
        const endCol = columnIndexToLetter(colCount - 1);
        const range = `A${firstAppendRow}:${endCol}${firstAppendRow + rows.length - 1}`;
        const url = `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/workbook/worksheets('${encodeURIComponent(resolvedSheet)}')/range(address='${encodeURIComponent(range)}')`;
        const resp = await fetch(url, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: rows }),
        });
        if (!resp.ok) return `Error appending rows: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`;
        logMicrosoftActivity({ agentId, agentName, action: 'office_append_spreadsheet_rows', actionType: 'write', details: JSON.stringify({ fileId, sheetName: resolvedSheet, rowCount: rows.length, range }), apiEndpoint: 'workbook/range', success: true });
        const meta = await getFileMeta(fileId);
        return `Appended ${rows.length} row(s) to ${resolvedSheet} at ${range} in "${meta.name}".\nFile ID: ${fileId}`;
      } catch (err) {
        return `Error appending rows: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_add_sheet': {
      try {
        const sheetName = args.sheet_name as string;

        const lpAdd = localXlsxPath(args);
        if (lpAdd) {
          if (!fs.existsSync(lpAdd)) return `Error: no file found at ${lpAdd}.`;
          const wb = await loadLocalWorkbook(lpAdd);
          if (wb.getWorksheet(sheetName)) return `Error: a worksheet named "${sheetName}" already exists.`;
          wb.addWorksheet(sheetName);
          await wb.xlsx.writeFile(lpAdd);
          logMicrosoftActivity({ agentId, agentName, action: 'office_add_sheet', actionType: 'write', details: JSON.stringify({ local: true, sheetName }), apiEndpoint: 'local', success: true });
          return `Added worksheet "${sheetName}". Saved to ${lpAdd}.`;
        }

        const fileId = args.file_id as string;
        const token = await getValidAccessToken();
        if (!token) return 'Error: Not authenticated with Microsoft';
        const resp = await fetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/workbook/worksheets/add`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: sheetName }),
        });
        if (!resp.ok) return `Error adding sheet: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`;
        logMicrosoftActivity({ agentId, agentName, action: 'office_add_sheet', actionType: 'write', details: JSON.stringify({ fileId, sheetName }), apiEndpoint: 'workbook/worksheets/add', success: true });
        return `Added worksheet "${sheetName}" to file ${fileId}.`;
      } catch (err) {
        return `Error adding sheet: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_delete_sheet': {
      try {
        const sheetName = args.sheet_name as string;

        const lpDel = localXlsxPath(args);
        if (lpDel) {
          if (!fs.existsSync(lpDel)) return `Error: no file found at ${lpDel}.`;
          const wb = await loadLocalWorkbook(lpDel);
          const ws = wb.getWorksheet(sheetName);
          if (!ws) return `Error: no worksheet named "${sheetName}". Sheets: ${wb.worksheets.map((w: { name: string }) => w.name).join(', ')}.`;
          if (wb.worksheets.length <= 1) return 'Error: cannot delete the only worksheet in a workbook.';
          wb.removeWorksheet(ws.id);
          await wb.xlsx.writeFile(lpDel);
          logMicrosoftActivity({ agentId, agentName, action: 'office_delete_sheet', actionType: 'write', details: JSON.stringify({ local: true, sheetName }), apiEndpoint: 'local', success: true });
          return `Deleted worksheet "${sheetName}". Saved to ${lpDel}.`;
        }

        const fileId = args.file_id as string;
        const token = await getValidAccessToken();
        if (!token) return 'Error: Not authenticated with Microsoft';
        const resp = await fetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/workbook/worksheets('${encodeURIComponent(sheetName)}')`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) return `Error deleting sheet: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`;
        logMicrosoftActivity({ agentId, agentName, action: 'office_delete_sheet', actionType: 'write', details: JSON.stringify({ fileId, sheetName }), apiEndpoint: 'workbook/worksheets/delete', success: true });
        return `Deleted worksheet "${sheetName}" from file ${fileId}.`;
      } catch (err) {
        return `Error deleting sheet: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_create_spreadsheet': {
      try {
        let filename = args.filename as string;
        if (!filename.endsWith('.xlsx')) filename += '.xlsx';
        const sheets = args.sheets as ExcelSheetSpec[];
        const folderId = args.folder_id as string | undefined;

        // Schema-mismatch detection. The unknownArgsWarning gate at
        // tools.ts only checks top-level args, so nested wrong patterns
        // (sheet-level `formulas`, `columns`, `header_row`, etc.) used
        // to slip through silently and the agent's intended formatting
        // or formulas would be dropped without any indication. This
        // explicit check refuses the call with a corrective example
        // pointing at the right per-cell pattern.
        const KNOWN_SHEET_KEYS = new Set([
          'name', 'rows', 'column_widths', 'freeze_rows', 'freeze_cols',
          'default_header_row', 'zoom_pct', 'hidden',
        ]);
        const WRONG_TO_RIGHT: Record<string, string> = {
          formulas: 'Each formula belongs INSIDE its cell, not in a sheet-level array. Use `{ formula: "=SUM(B2:B9)", number_format: "$#,##0" }` as the cell value in your rows.',
          columns: 'Column widths live in `column_widths` (an array of numbers in Excel character units). Per-column styling lives in the cells of that column, not a separate columns array.',
          header_row: 'The first row is auto-styled as a header (bold + light-blue fill) when `default_header_row: true` (the default). To override, style the cells in row 0 directly.',
          currency_format: 'There is no sheet-level number format. Apply per-cell via `{ value: 150000, number_format: "$#,##0" }`.',
          column_styles: 'Per-column styling goes on the cells in that column. Use a cell object like `{ value: 0.12, number_format: "0.0%" }`.',
        };
        for (const sheet of sheets ?? []) {
          if (!sheet || typeof sheet !== 'object') continue;
          const wrong = Object.keys(sheet).filter((k) => !KNOWN_SHEET_KEYS.has(k));
          if (wrong.length > 0) {
            const hints = wrong.map((k) => `  - \`${k}\`: ${WRONG_TO_RIGHT[k] ?? 'not a recognized sheet field.'}`).join('\n');
            return (
              `Error: sheet "${sheet.name ?? '(unnamed)'}" used field(s) that are not part of the office_create_spreadsheet schema: ${wrong.map((w) => `\`${w}\``).join(', ')}. ` +
              `These fields were going to be silently dropped — refusing to write the file so you can fix them.\n\n${hints}\n\n` +
              `Allowed sheet fields: ${[...KNOWN_SHEET_KEYS].join(', ')}. Re-call this tool with the corrections.`
            );
          }
        }

        const buffer = await generateExcelBuffer(sheets);
        const summary = await saveOfficeBuffer(buffer, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', agentId, folderId, 'excel');
        logMicrosoftActivity({ agentId, agentName, action: 'office_create_spreadsheet', actionType: 'write', details: JSON.stringify({ filename, sheetCount: sheets.length }), apiEndpoint: 'drive/upload', success: true });
        return summary;
      } catch (err) {
        return `Error creating spreadsheet: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_get_presentation_outline': {
      try {
        const fileId = args.file_id as string;
        const buf = await downloadFileBytes(fileId);
        const zip = await JSZip.loadAsync(buf);
        const order = await getSlideOrder(zip);
        const outline: Array<{ index: number; title: string }> = [];
        for (let i = 0; i < order.length; i++) {
          const file = zip.file(order[i].file);
          const title = file ? slideTitleFromXml(await file.async('string')) : '[unreadable]';
          outline.push({ index: i, title: title || '[untitled]' });
        }
        const meta = await getFileMeta(fileId);
        logMicrosoftActivity({ agentId, agentName, action: 'office_get_presentation_outline', actionType: 'read', details: JSON.stringify({ fileId, slideCount: outline.length }), apiEndpoint: 'drive/download', success: true });
        return JSON.stringify({ file: meta.name, file_id: fileId, slides: outline });
      } catch (err) {
        return `Error reading presentation outline: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_read_presentation': {
      try {
        const fileId = args.file_id as string;
        const offset = Math.max(0, Math.floor((args.offset as number | undefined) ?? 0));
        const limit = Math.min(200, Math.max(1, Math.floor((args.limit as number | undefined) ?? 50)));
        const format = (args.format as string | undefined) === 'json' ? 'json' : 'text';
        const buf = await downloadFileBytes(fileId);
        const zip = await JSZip.loadAsync(buf);
        const order = await getSlideOrder(zip);
        const meta = await getFileMeta(fileId);
        const totalSlides = order.length;
        const slice = order.slice(offset, offset + limit);

        const slides: Array<{ index: number; title: string; body: string[] }> = [];
        for (let i = 0; i < slice.length; i++) {
          const file = zip.file(slice[i].file);
          if (!file) {
            slides.push({ index: offset + i, title: '[unreadable]', body: [] });
            continue;
          }
          const xml = await file.async('string');
          const { title, body } = extractSlideText(xml);
          slides.push({ index: offset + i, title: title || '[untitled]', body });
        }

        logMicrosoftActivity({ agentId, agentName, action: 'office_read_presentation', actionType: 'read', details: JSON.stringify({ fileId, offset, returned: slides.length, totalSlides }), apiEndpoint: 'drive/download', success: true });

        if (format === 'json') {
          return JSON.stringify({
            file: meta.name,
            file_id: fileId,
            total_slides: totalSlides,
            offset,
            returned: slides.length,
            has_more: offset + slides.length < totalSlides,
            slides,
          });
        }

        const lines: string[] = [];
        lines.push(`# ${meta.name}`);
        lines.push(`[slides ${offset + 1}–${offset + slides.length} of ${totalSlides}]`);
        lines.push('');
        for (const s of slides) {
          lines.push(`## Slide ${s.index + 1}: ${s.title}`);
          if (s.body.length === 0) {
            lines.push('[no body text]');
          } else {
            for (const line of s.body) lines.push(`- ${line}`);
          }
          lines.push('');
        }
        if (offset + slides.length < totalSlides) {
          lines.push(`[truncated — ${totalSlides - offset - slides.length} more slides. Call office_read_presentation(file_id="${fileId}", offset=${offset + slides.length}) for the next slice.]`);
        }
        return lines.join('\n').trim();
      } catch (err) {
        return `Error reading presentation: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_replace_in_presentation': {
      try {
        const fileId = args.file_id as string;
        const find = args.find as string;
        const replace = args.replace as string;
        if (!find) return 'Error: find cannot be empty';
        const buf = await downloadFileBytes(fileId);
        const zip = await JSZip.loadAsync(buf);
        const order = await getSlideOrder(zip);
        let totalReplacements = 0;
        for (const { file } of order) {
          const slideFile = zip.file(file);
          if (!slideFile) continue;
          const xml = await slideFile.async('string');
          const { newXml, replacements } = replaceTextInSlideXml(xml, find, replace);
          if (replacements > 0) {
            zip.file(file, newXml);
            totalReplacements += replacements;
          }
        }
        if (totalReplacements === 0) {
          return `No matches for "${find}" found in any slide. Note: find/replace only matches text within a single formatted run.`;
        }
        const updatedBuffer = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
        const meta = await getFileMeta(fileId);
        const result = await uploadToOneDrive(updatedBuffer, meta.name, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', meta.parentId);
        logMicrosoftActivity({ agentId, agentName, action: 'office_replace_in_presentation', actionType: 'write', details: JSON.stringify({ fileId, replacements: totalReplacements }), apiEndpoint: 'drive/upload', success: true });
        return `Replaced ${totalReplacements} occurrence(s) of "${find}" across ${order.length} slide(s) in "${result.name}".\nFile ID: ${result.id}\nOpen: ${result.webUrl}`;
      } catch (err) {
        return `Error replacing text in presentation: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_delete_slide': {
      try {
        const fileId = args.file_id as string;
        const position = args.position as number;
        const buf = await downloadFileBytes(fileId);
        const zip = await JSZip.loadAsync(buf);
        const order = await getSlideOrder(zip);
        if (position < 0 || position >= order.length) {
          return `Error: position ${position} out of range. Presentation has ${order.length} slide(s) (valid: 0 to ${order.length - 1}).`;
        }
        if (order.length === 1) return 'Error: cannot delete the only slide in a presentation.';
        const targetRel = order[position];

        // 1. Remove the <p:sldId r:id="targetRel.rId"/> entry from presentation.xml
        const presFile = zip.file('ppt/presentation.xml');
        if (!presFile) return 'Error: missing ppt/presentation.xml';
        let presXml = await presFile.async('string');
        const sldIdRe = new RegExp(`<p:sldId[^>]*\\sr:id="${targetRel.rId}"[^>]*/?>`, 'g');
        presXml = presXml.replace(sldIdRe, '');
        zip.file('ppt/presentation.xml', presXml);

        // 2. Remove the Relationship entry from presentation.xml.rels
        const relsFile = zip.file('ppt/_rels/presentation.xml.rels');
        if (relsFile) {
          let relsXml = await relsFile.async('string');
          const relRe = new RegExp(`<Relationship[^>]*Id="${targetRel.rId}"[^>]*/>`, 'g');
          relsXml = relsXml.replace(relRe, '');
          zip.file('ppt/_rels/presentation.xml.rels', relsXml);
        }

        // 3. Remove the slide XML file itself + its rels (leave dangling layout
        //    references; PowerPoint cleans those up on round-trip).
        zip.remove(targetRel.file);
        const slideRelsPath = targetRel.file.replace(/^ppt\/slides\//, 'ppt/slides/_rels/') + '.rels';
        zip.remove(slideRelsPath);

        // 4. Remove the slide entry from [Content_Types].xml
        const ctFile = zip.file('[Content_Types].xml');
        if (ctFile) {
          let ctXml = await ctFile.async('string');
          const slidePart = '/' + targetRel.file;
          const overrideRe = new RegExp(`<Override[^>]*PartName="${slidePart.replace(/\//g, '\\/')}"[^>]*/>`, 'g');
          ctXml = ctXml.replace(overrideRe, '');
          zip.file('[Content_Types].xml', ctXml);
        }

        const updatedBuffer = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
        const meta = await getFileMeta(fileId);
        const result = await uploadToOneDrive(updatedBuffer, meta.name, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', meta.parentId);
        logMicrosoftActivity({ agentId, agentName, action: 'office_delete_slide', actionType: 'write', details: JSON.stringify({ fileId, position }), apiEndpoint: 'drive/upload', success: true });
        return `Deleted slide at position ${position} from "${result.name}". ${order.length - 1} slide(s) remain.\nFile ID: ${result.id}\nOpen: ${result.webUrl}`;
      } catch (err) {
        return `Error deleting slide: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_insert_slide': {
      try {
        const fileId = args.file_id as string;
        const position = args.position as number;
        const title = args.title as string;
        const body = (args.body as string | undefined) ?? '';

        const buf = await downloadFileBytes(fileId);
        const zip = await JSZip.loadAsync(buf);
        const order = await getSlideOrder(zip);
        if (position < 0 || position > order.length) {
          return `Error: position ${position} out of range. Presentation has ${order.length} slide(s) (valid insert positions: 0 to ${order.length}).`;
        }

        // Pick a slide layout to link to. Default to slideLayout2 (typically
        // "Title and Content"). If not present, fall back to slideLayout1.
        const layoutTarget = zip.file('ppt/slideLayouts/slideLayout2.xml')
          ? '../slideLayouts/slideLayout2.xml'
          : '../slideLayouts/slideLayout1.xml';

        // Find next available slide file number + relationship id.
        const usedNumbers = new Set<number>();
        for (const { file } of order) {
          const m = file.match(/slide(\d+)\.xml$/);
          if (m) usedNumbers.add(parseInt(m[1], 10));
        }
        let newNum = 1;
        while (usedNumbers.has(newNum)) newNum++;
        const newSlideFile = `ppt/slides/slide${newNum}.xml`;
        const newSlideRelsFile = `ppt/slides/_rels/slide${newNum}.xml.rels`;

        // Generate a new relationship id not in use.
        const relsFile = zip.file('ppt/_rels/presentation.xml.rels');
        if (!relsFile) return 'Error: missing ppt/_rels/presentation.xml.rels';
        let relsXml = await relsFile.async('string');
        const existingIds = new Set<string>();
        const idRe = /Id="([^"]+)"/g;
        let mm: RegExpExecArray | null;
        while ((mm = idRe.exec(relsXml)) !== null) existingIds.add(mm[1]);
        let newRId = '';
        for (let i = 100; i < 10000; i++) {
          const candidate = `rId${i}`;
          if (!existingIds.has(candidate)) { newRId = candidate; break; }
        }
        if (!newRId) return 'Error: could not allocate a new relationship id';

        // 1. Write the new slide XML.
        const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xmlEscape(title)}</a:t></a:r></a:p></p:txBody>
      </p:sp>${body ? `
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xmlEscape(body)}</a:t></a:r></a:p></p:txBody>
      </p:sp>` : ''}
    </p:spTree>
  </p:cSld>
</p:sld>`;
        zip.file(newSlideFile, slideXml);

        // 2. Write the new slide's rels file pointing at the layout.
        const slideRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="${layoutTarget}"/>
</Relationships>`;
        zip.file(newSlideRelsFile, slideRelsXml);

        // 3. Add the new relationship to presentation.xml.rels.
        const newRel = `<Relationship Id="${newRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${newNum}.xml"/>`;
        relsXml = relsXml.replace('</Relationships>', `  ${newRel}\n</Relationships>`);
        zip.file('ppt/_rels/presentation.xml.rels', relsXml);

        // 4. Insert <p:sldId> into the slide ID list at the right position.
        const presFile = zip.file('ppt/presentation.xml');
        if (!presFile) return 'Error: missing ppt/presentation.xml';
        let presXml = await presFile.async('string');
        // Allocate a slide-instance ID > 255 not currently used.
        const existingSldIds = new Set<number>();
        const sldIdNumRe = /<p:sldId\s+id="(\d+)"/g;
        let sm: RegExpExecArray | null;
        while ((sm = sldIdNumRe.exec(presXml)) !== null) existingSldIds.add(parseInt(sm[1], 10));
        let newSldId = 256;
        while (existingSldIds.has(newSldId)) newSldId++;
        const newSldIdEntry = `<p:sldId id="${newSldId}" r:id="${newRId}"/>`;

        // Parse the existing <p:sldId> list and rebuild with the new entry inserted at `position`.
        const sldIdsList = [...presXml.matchAll(/<p:sldId[^>]*\/?>/g)].map((mm2) => mm2[0]);
        if (sldIdsList.length === 0) {
          // No existing list — insert one inside <p:sldIdLst>
          presXml = presXml.replace(/<p:sldIdLst\s*\/?>/, `<p:sldIdLst>${newSldIdEntry}</p:sldIdLst>`);
        } else {
          const newList = [...sldIdsList];
          newList.splice(position, 0, newSldIdEntry);
          // Replace the existing sldIdLst content with the new list.
          presXml = presXml.replace(/(<p:sldIdLst[^>]*>)[\s\S]*?(<\/p:sldIdLst>)/, `$1${newList.join('')}$2`);
        }
        zip.file('ppt/presentation.xml', presXml);

        // 5. Add the slide's content-type override.
        const ctFile = zip.file('[Content_Types].xml');
        if (ctFile) {
          let ctXml = await ctFile.async('string');
          const ctEntry = `<Override PartName="/${newSlideFile}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
          ctXml = ctXml.replace('</Types>', `  ${ctEntry}\n</Types>`);
          zip.file('[Content_Types].xml', ctXml);
        }

        const updatedBuffer = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
        const meta = await getFileMeta(fileId);
        const result = await uploadToOneDrive(updatedBuffer, meta.name, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', meta.parentId);
        logMicrosoftActivity({ agentId, agentName, action: 'office_insert_slide', actionType: 'write', details: JSON.stringify({ fileId, position }), apiEndpoint: 'drive/upload', success: true });
        return `Inserted slide at position ${position} in "${result.name}". ${order.length + 1} slide(s) total.\nFile ID: ${result.id}\nOpen: ${result.webUrl}`;
      } catch (err) {
        return `Error inserting slide: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_create_presentation': {
      try {
        let filename = args.filename as string;
        if (!filename.endsWith('.pptx')) filename += '.pptx';
        const slides = args.slides as PptxSlide[];
        const folderId = args.folder_id as string | undefined;
        const pptxOptions: PptxOptions = { theme: args.theme as PptxTheme | undefined };

        const buffer = await generatePptxBuffer(slides, pptxOptions);
        const summary = await saveOfficeBuffer(buffer, filename, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', agentId, folderId, 'powerpoint');
        logMicrosoftActivity({ agentId, agentName, action: 'office_create_presentation', actionType: 'write', details: JSON.stringify({ filename, slideCount: slides.length }), apiEndpoint: 'drive/upload', success: true });
        return summary;
      } catch (err) {
        return `Error creating presentation: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    default:
      return `Unknown Office tool: ${name}`;
  }
}
