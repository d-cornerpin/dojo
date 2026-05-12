// ════════════════════════════════════════
// Microsoft Office Document Generation Tools
// Creates Word, Excel, PowerPoint files and uploads to OneDrive
// ════════════════════════════════════════

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
    description: 'Create a Word document (.docx) with formatted content and upload to OneDrive. Returns file ID and shareable link.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name (e.g., "Project Report.docx")' },
        folder_id: { type: 'string', description: 'OneDrive folder ID (omit for root)' },
        content: {
          type: 'array',
          description: 'Array of content blocks: heading, paragraph, table, bullet_list, page_break',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['heading', 'paragraph', 'table', 'bullet_list', 'page_break'] },
              text: { type: 'string', description: 'Text content (for heading, paragraph)' },
              level: { type: 'number', description: 'Heading level 1-3 (for heading type)' },
              bold: { type: 'boolean', description: 'Bold text (for paragraph)' },
              italic: { type: 'boolean', description: 'Italic text (for paragraph)' },
              align: { type: 'string', enum: ['left', 'center', 'right'], description: 'Text alignment (for paragraph)' },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: '2D array of cell values, first row is header (for table)' },
              items: { type: 'array', items: { type: 'string' }, description: 'List items (for bullet_list)' },
            },
          },
        },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'office_append_to_word_document',
    description: 'Append content to the END of an existing Word document in OneDrive. The original content is preserved (the file_id and any existing share links stay alive). For inserting at a specific position, use office_insert_in_word_document instead.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the existing .docx' },
        content: {
          type: 'array',
          description: 'Content blocks to append (same schema as office_create_word_document)',
          items: { type: 'object' },
        },
      },
      required: ['file_id', 'content'],
    },
  },
  {
    name: 'office_get_word_document_outline',
    description: 'Read the structure of an existing Word document: a list of blocks (paragraphs, headings, tables) with zero-based index numbers and a short text preview of each. Use this BEFORE office_insert_in_word_document or office_delete_block_in_word_document to know which index to target. For the actual content of the document, use office_read_word_document instead.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .docx to inspect' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'office_read_word_document',
    description: 'Read the FULL text content of a Word document (.docx) on OneDrive. Returns headings, paragraphs, and table contents in document order — this is the read-equivalent of file_read for .docx files. Supports pagination via offset+limit (block-indexed) for large documents. Use this when the user asks you to read, summarize, quote, or extract content from a Word doc; use office_get_word_document_outline only when you need to know block indexes for an edit operation.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .docx to read' },
        offset: { type: 'number', description: 'Zero-based block index to start reading from. Default 0.' },
        limit: { type: 'number', description: 'Maximum number of blocks to return. Default 200, max 500. Combined with a per-call response cap; very large blocks may produce fewer.' },
        format: { type: 'string', enum: ['text', 'json'], description: 'Output format: "text" (default — clean, readable transcript with markdown-style headings) or "json" (structured array of {index, type, text, rows?} objects, useful before edits).' },
      },
      required: ['file_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 8000,
  },
  {
    name: 'office_replace_in_word_document',
    description: 'Find and replace text throughout an existing Word document. Preserves formatting and file ID. Limitation: the find string must be contained within a single formatted run — works for unformatted text or text in one consistent style; cannot match text that spans bold/italic boundaries.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .docx to edit' },
        find: { type: 'string', description: 'Text to search for (exact match, case-sensitive)' },
        replace: { type: 'string', description: 'Replacement text. Use empty string to delete the find text.' },
      },
      required: ['file_id', 'find', 'replace'],
    },
  },
  {
    name: 'office_insert_in_word_document',
    description: 'Insert content blocks at a specific position in an existing Word document. The position is a zero-based index — call office_get_word_document_outline first to know which index to target. To insert at the very beginning use position 0; to insert before the third block use position 2.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .docx to edit' },
        position: { type: 'number', description: 'Zero-based index where the new content goes. Existing block at this index shifts down.' },
        content: {
          type: 'array',
          description: 'Content blocks to insert (same schema as office_create_word_document)',
          items: { type: 'object' },
        },
      },
      required: ['file_id', 'position', 'content'],
    },
  },
  {
    name: 'office_delete_block_in_word_document',
    description: 'Delete one or more blocks from an existing Word document by zero-based index. Use office_get_word_document_outline first to know which indexes to target. Can delete a single block or a range. Indexes refer to the document BEFORE the delete — to delete blocks 5, 6, and 7, pass start=5, count=3.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .docx to edit' },
        start: { type: 'number', description: 'Zero-based index of the first block to delete' },
        count: { type: 'number', description: 'Number of consecutive blocks to delete (default 1)' },
      },
      required: ['file_id', 'start'],
    },
  },
  {
    name: 'office_get_spreadsheet_range',
    description: 'Read a range of cells from an existing Excel spreadsheet using the Microsoft Graph Workbook API (true in-place read, no download needed). Returns the cell values as a 2D array. Use this to inspect data before editing.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .xlsx' },
        sheet_name: { type: 'string', description: 'Worksheet name (e.g. "Sheet1"). If omitted, reads from the first sheet.' },
        range: { type: 'string', description: 'A1-style range (e.g. "A1:D10"). If omitted, returns the used range of the sheet.' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'office_write_spreadsheet_range',
    description: 'Write values to a specific range in an existing Excel spreadsheet using the Microsoft Graph Workbook API. True in-place edit — preserves the file_id and any existing share links.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .xlsx' },
        sheet_name: { type: 'string', description: 'Worksheet name (e.g. "Sheet1"). If omitted, writes to the first sheet.' },
        range: { type: 'string', description: 'A1-style range to write (e.g. "A1:C3"). The values array dimensions must match this range exactly.' },
        values: { type: 'array', description: '2D array of cell values. Outer array = rows, inner array = columns. Values are strings or numbers.', items: { type: 'array', items: {} } },
      },
      required: ['file_id', 'range', 'values'],
    },
  },
  {
    name: 'office_append_spreadsheet_rows',
    description: 'Append rows to the end of an existing worksheet (after the last used row). True in-place edit via the Graph Workbook API.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .xlsx' },
        sheet_name: { type: 'string', description: 'Worksheet name. If omitted, appends to the first sheet.' },
        rows: { type: 'array', description: '2D array of row values to append', items: { type: 'array', items: {} } },
      },
      required: ['file_id', 'rows'],
    },
  },
  {
    name: 'office_add_sheet',
    description: 'Add a new worksheet to an existing Excel workbook. True in-place edit via the Graph Workbook API.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .xlsx' },
        sheet_name: { type: 'string', description: 'Name for the new worksheet' },
      },
      required: ['file_id', 'sheet_name'],
    },
  },
  {
    name: 'office_delete_sheet',
    description: 'Delete a worksheet from an existing Excel workbook. Cannot delete the only sheet in a workbook.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the .xlsx' },
        sheet_name: { type: 'string', description: 'Worksheet name to delete' },
      },
      required: ['file_id', 'sheet_name'],
    },
  },
  {
    name: 'office_create_spreadsheet',
    description: 'Create an Excel spreadsheet (.xlsx) with data and upload to OneDrive.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name (e.g., "Budget.xlsx")' },
        folder_id: { type: 'string', description: 'OneDrive folder ID (omit for root)' },
        sheets: {
          type: 'array',
          description: 'Array of sheet objects',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Sheet name' },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: '2D array of cell values' },
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
    description: 'Create a PowerPoint presentation (.pptx) with slides and upload to OneDrive.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name (e.g., "Pitch Deck.pptx")' },
        folder_id: { type: 'string', description: 'OneDrive folder ID (omit for root)' },
        slides: {
          type: 'array',
          description: 'Array of slide objects',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Slide title' },
              body: { type: 'string', description: 'Slide body text' },
            },
            required: ['title'],
          },
        },
      },
      required: ['filename', 'slides'],
    },
  },
];

// ── Helpers ──

interface ContentBlock {
  type: 'heading' | 'paragraph' | 'table' | 'bullet_list' | 'page_break';
  text?: string;
  level?: number;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  rows?: string[][];
  items?: string[];
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

async function generateWordBuffer(blocks: ContentBlock[]): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docx: any = await (Function('return import("docx")')());

  const children: unknown[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const headingMap: Record<number, unknown> = {
          1: docx.HeadingLevel.HEADING_1,
          2: docx.HeadingLevel.HEADING_2,
          3: docx.HeadingLevel.HEADING_3,
        };
        children.push(new docx.Paragraph({
          text: block.text ?? '',
          heading: headingMap[block.level ?? 1] ?? docx.HeadingLevel.HEADING_1,
        }));
        break;
      }
      case 'paragraph': {
        const alignMap: Record<string, unknown> = {
          left: docx.AlignmentType.LEFT,
          center: docx.AlignmentType.CENTER,
          right: docx.AlignmentType.RIGHT,
        };
        children.push(new docx.Paragraph({
          alignment: alignMap[block.align ?? 'left'] ?? docx.AlignmentType.LEFT,
          children: [new docx.TextRun({
            text: block.text ?? '',
            bold: block.bold ?? false,
            italics: block.italic ?? false,
          })],
        }));
        break;
      }
      case 'table': {
        if (block.rows && block.rows.length > 0) {
          const tableRows = block.rows.map((row: string[], rowIdx: number) =>
            new docx.TableRow({
              children: row.map((cell: string) =>
                new docx.TableCell({
                  children: [new docx.Paragraph({
                    children: [new docx.TextRun({
                      text: cell,
                      bold: rowIdx === 0,
                    })],
                  })],
                }),
              ),
            }),
          );
          children.push(new docx.Table({ rows: tableRows }));
        }
        break;
      }
      case 'bullet_list': {
        if (block.items) {
          for (const item of block.items) {
            children.push(new docx.Paragraph({
              text: item,
              bullet: { level: 0 },
            }));
          }
        }
        break;
      }
      case 'page_break': {
        children.push(new docx.Paragraph({
          children: [new docx.PageBreak()],
        }));
        break;
      }
    }
  }

  const doc = new docx.Document({
    sections: [{ children }],
  });

  return Buffer.from(await docx.Packer.toBuffer(doc));
}

// ── Excel Generation ──

async function generateExcelBuffer(sheets: Array<{ name: string; rows: string[][] }>): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const XLSX: any = await (Function('return import("xlsx")')());
  const wb = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.from(buf);
}

// ── PowerPoint Generation ──

async function generatePptxBuffer(slides: Array<{ title: string; body?: string }>): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pptxMod: any = await (Function('return import("pptxgenjs")')());
  const PptxGenJS: any = pptxMod.default;
  const pptx = new PptxGenJS();

  for (const slide of slides) {
    const s = pptx.addSlide();
    s.addText(slide.title, { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 28, bold: true });
    if (slide.body) {
      s.addText(slide.body, { x: 0.5, y: 1.75, w: 9, h: 4.5, fontSize: 16 });
    }
  }

  const arrayBuffer = await pptx.write({ outputType: 'arraybuffer' }) as ArrayBuffer;
  return Buffer.from(arrayBuffer);
}

// ── Tool Execution ──

const officeToolDefByName = new Map(officeToolDefinitions.map(t => [t.name, t]));

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

        const buffer = await generateWordBuffer(blocks);
        const result = await uploadToOneDrive(buffer, filename, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', folderId);

        logMicrosoftActivity({ agentId, agentName, action: 'office_create_word_document', actionType: 'write', details: JSON.stringify({ filename }), apiEndpoint: 'drive/upload', success: true });

        return `Word document "${result.name}" created.\nFile ID: ${result.id}\nOpen: ${result.webUrl}${result.shareLink ? `\nShare link: ${result.shareLink}` : ''}`;
      } catch (err) {
        return `Error creating Word document: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_append_to_word_document': {
      try {
        const fileId = args.file_id as string;
        const blocks = args.content as ContentBlock[];

        // v2.5.10 — actually append now. Previously this re-generated the
        // doc from scratch and overwrote the original (despite the name).
        const existingBuffer = await downloadFileBytes(fileId);
        const zip = await JSZip.loadAsync(existingBuffer);
        const docFile = zip.file('word/document.xml');
        if (!docFile) return 'Error: existing file is missing word/document.xml — not a valid Word doc?';
        const documentXml = await docFile.async('string');
        const { prefix, bodyInner, suffix } = splitDocumentXml(documentXml);

        const newInner = await blocksToBodyInnerXml(blocks);
        const updatedDocXml = prefix + bodyInner + newInner + suffix;
        const updatedBuffer = await rewriteDocumentXml(existingBuffer, updatedDocXml);

        const meta = await getFileMeta(fileId);
        const result = await uploadToOneDrive(updatedBuffer, meta.name, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', meta.parentId);
        logMicrosoftActivity({ agentId, agentName, action: 'office_append_to_word_document', actionType: 'write', details: JSON.stringify({ fileId, blocksAppended: blocks.length }), apiEndpoint: 'drive/upload', success: true });
        return `Word document "${result.name}" updated (${blocks.length} block(s) appended).\nFile ID: ${result.id}\nOpen: ${result.webUrl}`;
      } catch (err) {
        return `Error appending to document: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_get_word_document_outline': {
      try {
        const fileId = args.file_id as string;
        const buf = await downloadFileBytes(fileId);
        const zip = await JSZip.loadAsync(buf);
        const docFile = zip.file('word/document.xml');
        if (!docFile) return 'Error: file is missing word/document.xml — not a valid Word doc?';
        const xml = await docFile.async('string');
        const { bodyInner } = splitDocumentXml(xml);
        const blocks = parseBodyBlocks(bodyInner);
        const meta = await getFileMeta(fileId);
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
        logMicrosoftActivity({ agentId, agentName, action: 'office_get_word_document_outline', actionType: 'read', details: JSON.stringify({ fileId, blockCount: outline.length }), apiEndpoint: 'drive/download', success: true });
        return JSON.stringify({ file: meta.name, file_id: fileId, blocks: outline });
      } catch (err) {
        return `Error reading document outline: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_read_word_document': {
      try {
        const fileId = args.file_id as string;
        const offset = Math.max(0, Math.floor((args.offset as number | undefined) ?? 0));
        const limit = Math.min(500, Math.max(1, Math.floor((args.limit as number | undefined) ?? 200)));
        const format = (args.format as string | undefined) === 'json' ? 'json' : 'text';
        const buf = await downloadFileBytes(fileId);
        const zip = await JSZip.loadAsync(buf);
        const docFile = zip.file('word/document.xml');
        if (!docFile) return 'Error: file is missing word/document.xml — not a valid Word doc?';
        const xml = await docFile.async('string');
        const { bodyInner } = splitDocumentXml(xml);
        const blocks = parseBodyBlocks(bodyInner);
        const meta = await getFileMeta(fileId);
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

        logMicrosoftActivity({ agentId, agentName, action: 'office_read_word_document', actionType: 'read', details: JSON.stringify({ fileId, offset, returned: parsed.length, totalBlocks }), apiEndpoint: 'drive/download', success: true });

        if (format === 'json') {
          return JSON.stringify({
            file: meta.name,
            file_id: fileId,
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
          lines.push(`[truncated — ${totalBlocks - offset - parsed.length} more blocks. Call office_read_word_document(file_id="${fileId}", offset=${offset + parsed.length}) for the next slice.]`);
        }
        return lines.join('\n').trim();
      } catch (err) {
        return `Error reading document: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_replace_in_word_document': {
      try {
        const fileId = args.file_id as string;
        const find = args.find as string;
        const replace = args.replace as string;
        if (!find) return 'Error: find cannot be empty';

        const existingBuffer = await downloadFileBytes(fileId);
        const zip = await JSZip.loadAsync(existingBuffer);
        const docFile = zip.file('word/document.xml');
        if (!docFile) return 'Error: file is missing word/document.xml — not a valid Word doc?';
        const documentXml = await docFile.async('string');
        const { newXml, replacements } = replaceTextInDocumentXml(documentXml, find, replace);
        if (replacements === 0) {
          return `No matches for "${find}" found in the document. Note: find/replace only matches text within a single formatted run — text spanning bold/italic boundaries can't be matched this way.`;
        }
        const updatedBuffer = await rewriteDocumentXml(existingBuffer, newXml);
        const meta = await getFileMeta(fileId);
        const result = await uploadToOneDrive(updatedBuffer, meta.name, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', meta.parentId);
        logMicrosoftActivity({ agentId, agentName, action: 'office_replace_in_word_document', actionType: 'write', details: JSON.stringify({ fileId, replacements }), apiEndpoint: 'drive/upload', success: true });
        return `Replaced ${replacements} occurrence(s) of "${find}" in "${result.name}".\nFile ID: ${result.id}\nOpen: ${result.webUrl}`;
      } catch (err) {
        return `Error replacing text: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_insert_in_word_document': {
      try {
        const fileId = args.file_id as string;
        const position = args.position as number;
        const blocks = args.content as ContentBlock[];

        const existingBuffer = await downloadFileBytes(fileId);
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
        const meta = await getFileMeta(fileId);
        const result = await uploadToOneDrive(updatedBuffer, meta.name, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', meta.parentId);
        logMicrosoftActivity({ agentId, agentName, action: 'office_insert_in_word_document', actionType: 'write', details: JSON.stringify({ fileId, position, blocksInserted: blocks.length }), apiEndpoint: 'drive/upload', success: true });
        return `Inserted ${blocks.length} block(s) at position ${position} in "${result.name}".\nFile ID: ${result.id}\nOpen: ${result.webUrl}`;
      } catch (err) {
        return `Error inserting blocks: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_delete_block_in_word_document': {
      try {
        const fileId = args.file_id as string;
        const start = args.start as number;
        const count = (args.count as number | undefined) ?? 1;
        if (count < 1) return 'Error: count must be at least 1';

        const existingBuffer = await downloadFileBytes(fileId);
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
        const meta = await getFileMeta(fileId);
        const result = await uploadToOneDrive(updatedBuffer, meta.name, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', meta.parentId);
        logMicrosoftActivity({ agentId, agentName, action: 'office_delete_block_in_word_document', actionType: 'write', details: JSON.stringify({ fileId, start, count: actualCount }), apiEndpoint: 'drive/upload', success: true });
        return `Deleted ${actualCount} block(s) starting at position ${start} in "${result.name}".\nFile ID: ${result.id}\nOpen: ${result.webUrl}`;
      } catch (err) {
        return `Error deleting blocks: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_get_spreadsheet_range': {
      try {
        const fileId = args.file_id as string;
        const sheetName = args.sheet_name as string | undefined;
        const range = args.range as string | undefined;
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
        const fileId = args.file_id as string;
        const sheetName = args.sheet_name as string | undefined;
        const range = args.range as string;
        const values = args.values as unknown[][];
        if (!range) return 'Error: range is required';
        if (!Array.isArray(values) || !Array.isArray(values[0])) return 'Error: values must be a 2D array';
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
        const fileId = args.file_id as string;
        const sheetName = args.sheet_name as string | undefined;
        const rows = args.rows as unknown[][];
        if (!Array.isArray(rows) || rows.length === 0) return 'Error: rows must be a non-empty 2D array';
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
        const fileId = args.file_id as string;
        const sheetName = args.sheet_name as string;
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
        const fileId = args.file_id as string;
        const sheetName = args.sheet_name as string;
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
        const sheets = args.sheets as Array<{ name: string; rows: string[][] }>;
        const folderId = args.folder_id as string | undefined;

        const buffer = await generateExcelBuffer(sheets);
        const result = await uploadToOneDrive(buffer, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', folderId);

        logMicrosoftActivity({ agentId, agentName, action: 'office_create_spreadsheet', actionType: 'write', details: JSON.stringify({ filename, sheetCount: sheets.length }), apiEndpoint: 'drive/upload', success: true });

        return `Spreadsheet "${result.name}" created.\nFile ID: ${result.id}\nOpen: ${result.webUrl}${result.shareLink ? `\nShare link: ${result.shareLink}` : ''}`;
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
        const slides = args.slides as Array<{ title: string; body?: string }>;
        const folderId = args.folder_id as string | undefined;

        const buffer = await generatePptxBuffer(slides);
        const result = await uploadToOneDrive(buffer, filename, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', folderId);

        logMicrosoftActivity({ agentId, agentName, action: 'office_create_presentation', actionType: 'write', details: JSON.stringify({ filename, slideCount: slides.length }), apiEndpoint: 'drive/upload', success: true });

        return `Presentation "${result.name}" created.\nFile ID: ${result.id}\nOpen: ${result.webUrl}${result.shareLink ? `\nShare link: ${result.shareLink}` : ''}`;
      } catch (err) {
        return `Error creating presentation: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    default:
      return `Unknown Office tool: ${name}`;
  }
}
