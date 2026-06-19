// ════════════════════════════════════════
// agent/pdf-tools.ts — PDF creation and manipulation
//
// We had PDF *reading* (file_read returns vision blocks or pdf-extract
// inlined text) but no creation or editing. This module fills that gap
// with pdf-lib (pure JS, no system dependencies). Every tool accepts
// local file paths for inputs and writes outputs to
// ~/.dojo/uploads/<agentId>/<filename>, matching the pattern used by
// other tools that produce files.
//
// Surface:
//   pdf_create               — Generate a new PDF from a content-blocks schema
//   pdf_get_info             — Page count, dimensions, metadata, form fields
//   pdf_merge                — Combine multiple PDFs into one
//   pdf_extract_pages        — Pull a page range into a new file (also covers split)
//   pdf_rotate_pages         — Rotate specific pages
//   pdf_reorder_pages        — Rearrange pages
//   pdf_delete_pages         — Remove pages
//   pdf_watermark            — Stamp text across all (or selected) pages
//   pdf_fill_form            — Set AcroForm field values, optionally flatten
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { createLogger } from '../logger.js';
import type { ToolDefinition } from './tools.js';

const logger = createLogger('pdf-tools');

const UPLOADS_DIR = path.join(os.homedir(), '.dojo', 'uploads');

function ensureAgentUploadDir(agentId: string): string {
  const dir = path.join(UPLOADS_DIR, agentId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveOutputPath(agentId: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const withExt = safe.toLowerCase().endsWith('.pdf') ? safe : `${safe}.pdf`;
  return path.join(ensureAgentUploadDir(agentId), withExt);
}

// ── Content schema ──
//
// Mirrors the docx tool's vocabulary where possible so an agent that
// just produced a Word doc can produce the same outline as a PDF
// without re-learning everything.

type Align = 'left' | 'center' | 'right';

interface PdfHeadingBlock {
  type: 'heading';
  text: string;
  level?: 1 | 2 | 3;
  align?: Align;
}

interface PdfParagraphBlock {
  type: 'paragraph';
  text: string;
  bold?: boolean;
  italic?: boolean;
  align?: Align;
  size_pt?: number;
  /** Hex color without '#'. */
  color?: string;
}

interface PdfBulletListBlock {
  type: 'bullet_list';
  items: string[];
}

interface PdfNumberedListBlock {
  type: 'numbered_list';
  items: string[];
}

interface PdfTableBlock {
  type: 'table';
  /** First row is treated as the header. */
  rows: string[][];
  /** Per-column width fractions summing to ~1.0. Omitted = equal split. */
  column_widths_pct?: number[];
  /** Header row shading hex. Default 'D5E8F0'. Empty string disables. */
  header_shading_hex?: string;
  /** Border color hex. Default '999999'. Empty string disables borders. */
  border_color_hex?: string;
  /** First-row gets bold text (default true). */
  first_row_bold?: boolean;
}

interface PdfImageBlock {
  type: 'image';
  /** Absolute path to a PNG/JPG. */
  path: string;
  /** Width in inches. Default 3. */
  width_in?: number;
  /** Height in inches. Default 3. */
  height_in?: number;
  align?: Align;
}

interface PdfHorizontalRuleBlock {
  type: 'horizontal_rule';
  color?: string;
}

interface PdfPageBreakBlock {
  type: 'page_break';
}

type PdfBlock =
  | PdfHeadingBlock
  | PdfParagraphBlock
  | PdfBulletListBlock
  | PdfNumberedListBlock
  | PdfTableBlock
  | PdfImageBlock
  | PdfHorizontalRuleBlock
  | PdfPageBreakBlock;

interface PdfDocOptions {
  page_size?: 'letter' | 'a4' | 'legal';
  orientation?: 'portrait' | 'landscape';
  margin_in?: number;
  default_font_size_pt?: number;
  /** Text to render in the top header on every page. */
  header_text?: string;
  /** Text to render in the bottom footer on every page. */
  footer_text?: string;
  /** When true, appends "Page X of Y" to the footer (right-aligned). */
  footer_includes_page_number?: boolean;
}

// ── Helpers ──

interface PageSize { width: number; height: number; }

const PAGE_SIZES_PT: Record<string, PageSize> = {
  // 1 inch = 72 PDF points. PDF coordinates start at the bottom-left.
  letter: { width: 612, height: 792 },
  a4:     { width: 595, height: 842 },
  legal:  { width: 612, height: 1008 },
};

function hexToRgb01(hex: string | undefined): [number, number, number] {
  if (!hex) return [0, 0, 0];
  const clean = hex.replace(/^#/, '');
  if (clean.length !== 6) return [0, 0, 0];
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

/**
 * Wrap one logical paragraph into rendered lines that fit `maxWidth`.
 * pdf-lib has no built-in text-wrapping helper; we measure each word
 * and break on whitespace. Falls back to per-character break for long
 * URL-like tokens that don't contain spaces.
 */
function wrapText(
  text: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  font: any,
  size: number,
  maxWidth: number,
): string[] {
  if (!text) return [''];
  const lines: string[] = [];
  const paragraphs = text.split('\n');
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) { lines.push(''); continue; }
    let current = '';
    for (const word of words) {
      const tryLine = current ? `${current} ${word}` : word;
      const width = font.widthOfTextAtSize(tryLine, size);
      if (width <= maxWidth) {
        current = tryLine;
      } else {
        if (current) lines.push(current);
        // If the single word itself is wider than maxWidth, break it
        // character-by-character so it doesn't overflow silently.
        if (font.widthOfTextAtSize(word, size) > maxWidth) {
          let buffer = '';
          for (const ch of word) {
            const next = buffer + ch;
            if (font.widthOfTextAtSize(next, size) > maxWidth) {
              if (buffer) lines.push(buffer);
              buffer = ch;
            } else {
              buffer = next;
            }
          }
          current = buffer;
        } else {
          current = word;
        }
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

interface RenderCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfDoc: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  font: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fontBold: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fontItalic: any;
  pageW: number;
  pageH: number;
  marginPt: number;
  defaultSize: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pages: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  currentPage: any;
  cursorY: number;
  options: PdfDocOptions;
}

function newPage(ctx: RenderCtx): void {
  const page = ctx.pdfDoc.addPage([ctx.pageW, ctx.pageH]);
  ctx.pages.push(page);
  ctx.currentPage = page;
  ctx.cursorY = ctx.pageH - ctx.marginPt;
}

function ensureSpace(ctx: RenderCtx, neededPt: number): void {
  if (ctx.cursorY - neededPt < ctx.marginPt) newPage(ctx);
}

function pickFont(ctx: RenderCtx, bold?: boolean, italic?: boolean): unknown {
  if (bold && italic) return ctx.fontBold;
  if (bold) return ctx.fontBold;
  if (italic) return ctx.fontItalic;
  return ctx.font;
}

function alignX(align: Align | undefined, lineWidth: number, contentLeft: number, contentWidth: number): number {
  switch (align) {
    case 'center': return contentLeft + (contentWidth - lineWidth) / 2;
    case 'right':  return contentLeft + contentWidth - lineWidth;
    case 'left':
    default:       return contentLeft;
  }
}

function renderTextLines(
  ctx: RenderCtx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  font: any,
  size: number,
  lines: string[],
  color: [number, number, number],
  align: Align | undefined,
): void {
  const lineHeight = size * 1.4;
  const contentLeft = ctx.marginPt;
  const contentWidth = ctx.pageW - 2 * ctx.marginPt;
  for (const line of lines) {
    ensureSpace(ctx, lineHeight);
    const lineWidth = font.widthOfTextAtSize(line, size);
    const x = alignX(align, lineWidth, contentLeft, contentWidth);
    ctx.currentPage.drawText(line, {
      x,
      y: ctx.cursorY - size,
      size,
      font,
      color: rgb(color[0], color[1], color[2]),
    });
    ctx.cursorY -= lineHeight;
  }
}

function renderHeading(ctx: RenderCtx, block: PdfHeadingBlock): void {
  const size = block.level === 3 ? 14 : block.level === 2 ? 16 : 20;
  ctx.cursorY -= 6; // breathing room above the heading
  const lines = wrapText(block.text, ctx.fontBold, size, ctx.pageW - 2 * ctx.marginPt);
  renderTextLines(ctx, ctx.fontBold, size, lines, [0, 0, 0], block.align);
  ctx.cursorY -= 4;
}

function renderParagraph(ctx: RenderCtx, block: PdfParagraphBlock): void {
  const size = block.size_pt ?? ctx.defaultSize;
  const font = pickFont(ctx, block.bold, block.italic);
  const lines = wrapText(block.text, font, size, ctx.pageW - 2 * ctx.marginPt);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderTextLines(ctx, font as any, size, lines, hexToRgb01(block.color), block.align);
  ctx.cursorY -= 4;
}

function renderList(ctx: RenderCtx, items: string[], style: 'bullet' | 'numbered'): void {
  const size = ctx.defaultSize;
  const indent = 18;
  const bulletGap = 8;
  const lineHeight = size * 1.4;
  const contentLeft = ctx.marginPt + indent;
  const contentWidth = ctx.pageW - 2 * ctx.marginPt - indent;
  items.forEach((item, i) => {
    const lines = wrapText(item, ctx.font, size, contentWidth);
    lines.forEach((line, lineIdx) => {
      ensureSpace(ctx, lineHeight);
      if (lineIdx === 0) {
        const prefix = style === 'bullet' ? '•' : `${i + 1}.`;
        ctx.currentPage.drawText(prefix, {
          x: ctx.marginPt + (style === 'bullet' ? 4 : 0),
          y: ctx.cursorY - size,
          size,
          font: ctx.font,
          color: rgb(0, 0, 0),
        });
      }
      ctx.currentPage.drawText(line, {
        x: contentLeft + bulletGap,
        y: ctx.cursorY - size,
        size,
        font: ctx.font,
        color: rgb(0, 0, 0),
      });
      ctx.cursorY -= lineHeight;
    });
  });
  ctx.cursorY -= 4;
}

function renderHorizontalRule(ctx: RenderCtx, block: PdfHorizontalRuleBlock): void {
  const color = hexToRgb01(block.color ?? '999999');
  ensureSpace(ctx, 12);
  ctx.cursorY -= 6;
  ctx.currentPage.drawLine({
    start: { x: ctx.marginPt, y: ctx.cursorY },
    end:   { x: ctx.pageW - ctx.marginPt, y: ctx.cursorY },
    thickness: 0.75,
    color: rgb(color[0], color[1], color[2]),
  });
  ctx.cursorY -= 6;
}

function renderTable(ctx: RenderCtx, block: PdfTableBlock): void {
  const rows = block.rows ?? [];
  if (rows.length === 0) return;
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols === 0) return;
  const totalWidth = ctx.pageW - 2 * ctx.marginPt;
  const widths = block.column_widths_pct && block.column_widths_pct.length === cols
    ? block.column_widths_pct.map((p) => p * totalWidth)
    : new Array(cols).fill(totalWidth / cols);
  const padH = 6;
  const padV = 4;
  const size = ctx.defaultSize;
  const borderColor = block.border_color_hex === '' ? null : hexToRgb01(block.border_color_hex ?? '999999');
  const headerShading = block.header_shading_hex === '' ? null : hexToRgb01(block.header_shading_hex ?? 'D5E8F0');
  const firstRowBold = block.first_row_bold ?? true;

  rows.forEach((row, rowIdx) => {
    // Pre-compute wrapped lines per cell to know the row height.
    const cellLines = row.map((cell, cIdx) => {
      const f = rowIdx === 0 && firstRowBold ? ctx.fontBold : ctx.font;
      return wrapText(cell ?? '', f, size, (widths[cIdx] ?? widths[0]) - 2 * padH);
    });
    const rowHeight = Math.max(
      ...cellLines.map((ls) => ls.length * size * 1.4),
    ) + 2 * padV;
    ensureSpace(ctx, rowHeight);
    let x = ctx.marginPt;
    const yTop = ctx.cursorY;
    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const w = widths[cIdx];
      // Header shading for row 0.
      if (rowIdx === 0 && headerShading) {
        ctx.currentPage.drawRectangle({
          x, y: yTop - rowHeight, width: w, height: rowHeight,
          color: rgb(headerShading[0], headerShading[1], headerShading[2]),
        });
      }
      // Border.
      if (borderColor) {
        ctx.currentPage.drawRectangle({
          x, y: yTop - rowHeight, width: w, height: rowHeight,
          borderColor: rgb(borderColor[0], borderColor[1], borderColor[2]),
          borderWidth: 0.5,
        });
      }
      // Text.
      const f = rowIdx === 0 && firstRowBold ? ctx.fontBold : ctx.font;
      const lines = cellLines[cIdx];
      let yLine = yTop - padV - size;
      for (const line of lines) {
        ctx.currentPage.drawText(line, { x: x + padH, y: yLine, size, font: f, color: rgb(0, 0, 0) });
        yLine -= size * 1.4;
      }
      x += w;
    }
    ctx.cursorY -= rowHeight;
  });
  ctx.cursorY -= 4;
}

async function renderImage(ctx: RenderCtx, block: PdfImageBlock): Promise<void> {
  if (!block.path || !fs.existsSync(block.path)) {
    logger.warn('PDF image block: file not found, skipping', { path: block.path });
    return;
  }
  const data = fs.readFileSync(block.path);
  const ext = path.extname(block.path).toLowerCase();
  let img: unknown;
  if (ext === '.png') {
    img = await ctx.pdfDoc.embedPng(data);
  } else if (ext === '.jpg' || ext === '.jpeg') {
    img = await ctx.pdfDoc.embedJpg(data);
  } else {
    logger.warn('PDF image block: only PNG/JPG supported', { ext });
    return;
  }
  const w = (block.width_in ?? 3) * 72;
  const h = (block.height_in ?? 3) * 72;
  ensureSpace(ctx, h + 4);
  const contentLeft = ctx.marginPt;
  const contentWidth = ctx.pageW - 2 * ctx.marginPt;
  const x = alignX(block.align, w, contentLeft, contentWidth);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.currentPage.drawImage(img as any, { x, y: ctx.cursorY - h, width: w, height: h });
  ctx.cursorY -= h + 4;
}

function drawHeaderFooter(ctx: RenderCtx): void {
  const total = ctx.pages.length;
  ctx.pages.forEach((page, idx) => {
    if (ctx.options.header_text) {
      const w = ctx.font.widthOfTextAtSize(ctx.options.header_text, 10);
      page.drawText(ctx.options.header_text, {
        x: (ctx.pageW - w) / 2,
        y: ctx.pageH - ctx.marginPt / 2 - 10,
        size: 10,
        font: ctx.font,
        color: rgb(0.3, 0.3, 0.3),
      });
    }
    if (ctx.options.footer_text) {
      page.drawText(ctx.options.footer_text, {
        x: ctx.marginPt,
        y: ctx.marginPt / 2,
        size: 10,
        font: ctx.font,
        color: rgb(0.3, 0.3, 0.3),
      });
    }
    if (ctx.options.footer_includes_page_number) {
      const text = `Page ${idx + 1} of ${total}`;
      const w = ctx.font.widthOfTextAtSize(text, 10);
      page.drawText(text, {
        x: ctx.pageW - ctx.marginPt - w,
        y: ctx.marginPt / 2,
        size: 10,
        font: ctx.font,
        color: rgb(0.3, 0.3, 0.3),
      });
    }
  });
}

async function generatePdfBuffer(blocks: PdfBlock[], options: PdfDocOptions = {}): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const sizeKey = options.page_size ?? 'letter';
  const baseSize = PAGE_SIZES_PT[sizeKey] ?? PAGE_SIZES_PT.letter;
  const orientation = options.orientation ?? 'portrait';
  const pageW = orientation === 'landscape' ? baseSize.height : baseSize.width;
  const pageH = orientation === 'landscape' ? baseSize.width  : baseSize.height;
  const marginPt = (options.margin_in ?? 1) * 72;

  const ctx: RenderCtx = {
    pdfDoc, font, fontBold, fontItalic,
    pageW, pageH, marginPt,
    defaultSize: options.default_font_size_pt ?? 11,
    pages: [],
    currentPage: null,
    cursorY: 0,
    options,
  };
  newPage(ctx);

  for (const block of blocks) {
    switch (block.type) {
      case 'heading':         renderHeading(ctx, block); break;
      case 'paragraph':       renderParagraph(ctx, block); break;
      case 'bullet_list':     renderList(ctx, block.items, 'bullet'); break;
      case 'numbered_list':   renderList(ctx, block.items, 'numbered'); break;
      case 'table':           renderTable(ctx, block); break;
      case 'image':           await renderImage(ctx, block); break;
      case 'horizontal_rule': renderHorizontalRule(ctx, block); break;
      case 'page_break':      newPage(ctx); break;
    }
  }

  drawHeaderFooter(ctx);
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

// ── Per-operation helpers (merge, extract, rotate, etc.) ──

async function loadPdf(filePath: string): Promise<unknown> {
  const bytes = fs.readFileSync(filePath);
  return await PDFDocument.load(bytes);
}

function normalizePageList(input: number[] | undefined, total: number): number[] {
  if (!input || input.length === 0) return [];
  // Accept either 0-based or 1-based — if any index is >= total, assume
  // the agent passed 1-based. Both forms are common in tool callers.
  const oneBased = input.some((p) => p === total);
  return input.map((p) => oneBased ? p - 1 : p).filter((p) => p >= 0 && p < total);
}

async function mergePdfs(inputPaths: string[], outputPath: string): Promise<{ pageCount: number }> {
  const merged = await PDFDocument.create();
  let totalPages = 0;
  for (const p of inputPaths) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = await loadPdf(p) as any;
    const indices = src.getPageIndices();
    const copied = await merged.copyPages(src, indices);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const page of copied) {
      merged.addPage(page);
      totalPages++;
    }
  }
  fs.writeFileSync(outputPath, await merged.save());
  return { pageCount: totalPages };
}

async function extractPages(inputPath: string, pageIndices: number[], outputPath: string): Promise<{ pageCount: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const src = await loadPdf(inputPath) as any;
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pageIndices);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const page of copied) out.addPage(page);
  fs.writeFileSync(outputPath, await out.save());
  return { pageCount: pageIndices.length };
}

async function rotatePages(inputPath: string, rotations: Array<{ page: number; degrees: number }>, outputPath: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const src = await loadPdf(inputPath) as any;
  const total = src.getPageCount();
  for (const r of rotations) {
    const idx = r.page >= total ? r.page - 1 : r.page; // tolerate 1-based
    if (idx < 0 || idx >= total) continue;
    src.getPage(idx).setRotation(degrees(r.degrees));
  }
  fs.writeFileSync(outputPath, await src.save());
}

async function reorderPages(inputPath: string, newOrder: number[], outputPath: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const src = await loadPdf(inputPath) as any;
  const total = src.getPageCount();
  const order = normalizePageList(newOrder, total);
  if (order.length !== total) throw new Error(`Reorder list must include all ${total} pages exactly once; got ${order.length}.`);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, order);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const page of copied) out.addPage(page);
  fs.writeFileSync(outputPath, await out.save());
}

async function deletePages(inputPath: string, removeIndices: number[], outputPath: string): Promise<{ pageCount: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const src = await loadPdf(inputPath) as any;
  const total = src.getPageCount();
  const toRemove = new Set(normalizePageList(removeIndices, total));
  const keep: number[] = [];
  for (let i = 0; i < total; i++) if (!toRemove.has(i)) keep.push(i);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, keep);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const page of copied) out.addPage(page);
  fs.writeFileSync(outputPath, await out.save());
  return { pageCount: keep.length };
}

async function watermarkPdf(
  inputPath: string,
  outputPath: string,
  opts: { text: string; opacity?: number; size_pt?: number; color?: string; rotation_deg?: number; pages?: number[] },
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const src = await loadPdf(inputPath) as any;
  const font = await src.embedFont(StandardFonts.HelveticaBold);
  const total = src.getPageCount();
  const targetPages = opts.pages && opts.pages.length > 0
    ? new Set(normalizePageList(opts.pages, total))
    : new Set<number>(Array.from({ length: total }, (_, i) => i));
  const size = opts.size_pt ?? 60;
  const color = hexToRgb01(opts.color ?? '888888');
  const opacity = Math.min(1, Math.max(0, opts.opacity ?? 0.18));
  const rotation = opts.rotation_deg ?? 45;
  for (let i = 0; i < total; i++) {
    if (!targetPages.has(i)) continue;
    const page = src.getPage(i);
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(opts.text, size);
    page.drawText(opts.text, {
      x: width / 2 - textWidth / 2,
      y: height / 2 - size / 2,
      size,
      font,
      color: rgb(color[0], color[1], color[2]),
      opacity,
      rotate: degrees(rotation),
    });
  }
  fs.writeFileSync(outputPath, await src.save());
}

async function fillForm(
  inputPath: string,
  outputPath: string,
  values: Record<string, string | boolean | number>,
  flatten: boolean,
): Promise<{ filledFields: number; unmatchedKeys: string[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const src = await loadPdf(inputPath) as any;
  const form = src.getForm();
  let filled = 0;
  const unmatched: string[] = [];
  for (const [key, val] of Object.entries(values)) {
    try {
      const field = form.getField(key);
      const type = field.constructor.name;
      if (type === 'PDFCheckBox') {
        if (val) field.check(); else field.uncheck();
      } else if (type === 'PDFTextField') {
        field.setText(String(val));
      } else if (type === 'PDFDropdown' || type === 'PDFRadioGroup' || type === 'PDFOptionList') {
        field.select(String(val));
      } else {
        // Best-effort: try setText.
        field.setText(String(val));
      }
      filled++;
    } catch {
      unmatched.push(key);
    }
  }
  if (flatten) form.flatten();
  fs.writeFileSync(outputPath, await src.save());
  return { filledFields: filled, unmatchedKeys: unmatched };
}

async function getPdfInfo(filePath: string): Promise<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const src = await loadPdf(filePath) as any;
  const total = src.getPageCount();
  const pageSizes = Array.from({ length: total }, (_, i) => {
    const p = src.getPage(i);
    const { width, height } = p.getSize();
    return { index: i, width_pt: width, height_pt: height, width_in: width / 72, height_in: height / 72 };
  });
  let fields: string[] = [];
  try {
    const form = src.getForm();
    fields = form.getFields().map((f: { getName: () => string }) => f.getName());
  } catch { /* form may not exist */ }
  return {
    page_count: total,
    title: src.getTitle() ?? null,
    author: src.getAuthor() ?? null,
    subject: src.getSubject() ?? null,
    creator: src.getCreator() ?? null,
    producer: src.getProducer() ?? null,
    creation_date: src.getCreationDate()?.toISOString() ?? null,
    modification_date: src.getModificationDate()?.toISOString() ?? null,
    page_sizes: pageSizes,
    form_fields: fields,
  };
}

// ── Tool definitions ──

export const pdfToolDefinitions: ToolDefinition[] = [
  {
    name: 'pdf_create',
    description: 'Create a new PDF (.pdf) from a content-blocks schema and save it under your agent uploads dir. Returns the absolute output path. Mirrors the docx schema where possible — paragraph / heading / table / bullet_list / numbered_list / image / page_break / horizontal_rule — so an outline that worked for a Word doc can be re-used here.\n\nKey defaults applied automatically: US Letter, 1" margins, Helvetica 11pt, tables get borders + light-blue header shading, page numbers in the footer only when explicitly requested.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Output filename. ".pdf" extension is added if missing.' },
        page_size: { type: 'string', enum: ['letter', 'a4', 'legal'], description: 'Page size. Default "letter".' },
        orientation: { type: 'string', enum: ['portrait', 'landscape'], description: 'Default "portrait".' },
        margin_in: { type: 'number', description: 'Page margin in inches (uniform). Default 1.' },
        default_font_size_pt: { type: 'number', description: 'Default body font size. Default 11.' },
        header_text: { type: 'string', description: 'Rendered centered at the top of every page.' },
        footer_text: { type: 'string', description: 'Rendered at the bottom-left of every page.' },
        footer_includes_page_number: { type: 'boolean', description: 'When true, appends "Page X of Y" to the bottom-right of every page.' },
        content: {
          type: 'array',
          description: 'Ordered content blocks. Types: heading {text, level 1-3, align}, paragraph {text, bold, italic, align, size_pt, color}, bullet_list {items}, numbered_list {items}, table {rows: string[][], column_widths_pct, header_shading_hex, border_color_hex, first_row_bold}, image {path, width_in, height_in, align}, horizontal_rule {color}, page_break.',
          items: { type: 'object' },
        },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'pdf_get_info',
    description: 'Read structural and metadata info from a PDF on disk — page count, per-page dimensions (in points and inches), title/author/subject/creator/producer/dates, and AcroForm field names. Use this before pdf_extract_pages / pdf_reorder_pages / pdf_fill_form to know what you have.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the PDF.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'pdf_read',
    description: 'Extract and return the TEXT CONTENT of a PDF on disk. This is the tool for actually READING what a PDF says — e.g. an attached document the user wants you to look at. (pdf_get_info returns only metadata like page count and title, not the words.) Returns the text with per-page markers; very large PDFs are truncated. If the PDF is scanned / image-only with no text layer, little or no text comes back — say so rather than guessing. When a PDF is attached and your model already shows you its contents inline, you do not need this; reach for it when the inline contents are absent or you want the raw text on demand.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the PDF (e.g. the Path shown in an attachment notice).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'pdf_merge',
    description: 'Combine multiple PDFs (in the given order) into a single new PDF. Returns the absolute output path. Original files are not modified.',
    input_schema: {
      type: 'object',
      properties: {
        input_paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the source PDFs in the order they should appear in the output.' },
        output_filename: { type: 'string', description: 'Output filename (saved under your agent uploads dir). ".pdf" added if missing.' },
      },
      required: ['input_paths', 'output_filename'],
    },
  },
  {
    name: 'pdf_extract_pages',
    description: 'Pull a list of pages from an existing PDF into a new file (useful for splits, single-page extracts, or "give me just the first chapter"). Returns the absolute output path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the source PDF.' },
        pages: { type: 'array', items: { type: 'number' }, description: 'Pages to keep (zero-based; if you pass 1-based indices the tool detects and adjusts).' },
        output_filename: { type: 'string', description: 'Output filename. ".pdf" added if missing.' },
      },
      required: ['path', 'pages', 'output_filename'],
    },
  },
  {
    name: 'pdf_rotate_pages',
    description: 'Rotate specific pages of an existing PDF and save the result. Returns the output path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the source PDF.' },
        rotations: {
          type: 'array',
          description: 'Array of {page, degrees} objects. Degrees must be a multiple of 90 (typically 90, 180, or 270).',
          items: {
            type: 'object',
            properties: {
              page: { type: 'number', description: 'Zero-based page index.' },
              degrees: { type: 'number', description: 'Rotation in degrees (90, 180, 270).' },
            },
            required: ['page', 'degrees'],
          },
        },
        output_filename: { type: 'string' },
      },
      required: ['path', 'rotations', 'output_filename'],
    },
  },
  {
    name: 'pdf_reorder_pages',
    description: 'Rearrange the pages of an existing PDF. Returns the output path. The `new_order` list must include every page exactly once.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the source PDF.' },
        new_order: { type: 'array', items: { type: 'number' }, description: 'New ordering of zero-based page indices. Length must equal the source page count.' },
        output_filename: { type: 'string' },
      },
      required: ['path', 'new_order', 'output_filename'],
    },
  },
  {
    name: 'pdf_delete_pages',
    description: 'Remove pages from an existing PDF and save the result. Returns the output path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the source PDF.' },
        pages: { type: 'array', items: { type: 'number' }, description: 'Zero-based page indices to remove.' },
        output_filename: { type: 'string' },
      },
      required: ['path', 'pages', 'output_filename'],
    },
  },
  {
    name: 'pdf_watermark',
    description: 'Stamp a text watermark diagonally across pages of an existing PDF. Returns the output path. Useful for "DRAFT", "CONFIDENTIAL", or per-recipient marks.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the source PDF.' },
        text: { type: 'string', description: 'Watermark text.' },
        opacity: { type: 'number', description: '0-1. Default 0.18 — visible but not obstructive.' },
        size_pt: { type: 'number', description: 'Font size in points. Default 60.' },
        color: { type: 'string', description: 'Hex color without "#". Default "888888".' },
        rotation_deg: { type: 'number', description: 'Rotation in degrees. Default 45.' },
        pages: { type: 'array', items: { type: 'number' }, description: 'Zero-based page indices to stamp. Omit to stamp every page.' },
        output_filename: { type: 'string' },
      },
      required: ['path', 'text', 'output_filename'],
    },
  },
  {
    name: 'pdf_fill_form',
    description: 'Fill AcroForm fields in an existing PDF and save the result. Use pdf_get_info first to discover field names. Returns the output path and counts of filled vs unmatched fields. Pass `flatten: true` to make the filled fields non-editable.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the source PDF.' },
        values: {
          type: 'object',
          description: 'Map of field name → value. Text fields take strings, checkboxes take booleans, dropdowns take the option string.',
        },
        flatten: { type: 'boolean', description: 'When true, the filled form is flattened — fields become non-editable on the output. Default false (keeps fields editable).' },
        output_filename: { type: 'string' },
      },
      required: ['path', 'values', 'output_filename'],
    },
  },
];

export const pdfToolNames = pdfToolDefinitions.map((t) => t.name);

// ── Dispatcher ──

export async function executePdfTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
): Promise<string> {
  try {
    switch (name) {
      case 'pdf_create': {
        const filename = args.filename as string;
        if (!filename) return 'Error: filename is required.';
        const blocks = (args.content as PdfBlock[] | undefined) ?? [];
        if (blocks.length === 0) return 'Error: content is empty.';
        const opts: PdfDocOptions = {
          page_size: args.page_size as PdfDocOptions['page_size'],
          orientation: args.orientation as PdfDocOptions['orientation'],
          margin_in: args.margin_in as number | undefined,
          default_font_size_pt: args.default_font_size_pt as number | undefined,
          header_text: args.header_text as string | undefined,
          footer_text: args.footer_text as string | undefined,
          footer_includes_page_number: args.footer_includes_page_number as boolean | undefined,
        };
        const buf = await generatePdfBuffer(blocks, opts);
        const out = resolveOutputPath(agentId, filename);
        fs.writeFileSync(out, buf);
        return (
          `PDF created at ${out} (${buf.length} bytes, ${blocks.length} block(s) rendered). ` +
          `To give the user a downloadable URL for this file, call share_file with path="${out}" — do NOT invent or guess a URL.`
        );
      }
      case 'pdf_get_info': {
        const p = args.path as string;
        if (!p) return 'Error: path is required.';
        if (!fs.existsSync(p)) return `Error: file not found: ${p}`;
        const info = await getPdfInfo(p);
        return JSON.stringify(info, null, 2);
      }
      case 'pdf_read': {
        const p = args.path as string;
        if (!p) return 'Error: path is required.';
        if (!fs.existsSync(p)) return `Error: file not found: ${p}`;
        const { extractPdfText, PdfExtractError } = await import('../services/pdf-extract.js');
        try {
          const data = fs.readFileSync(p).toString('base64');
          const extracted = await extractPdfText(data);
          const trimmed = extracted.text.trim();
          if (!trimmed) {
            return `This PDF (${extracted.pageCount} page${extracted.pageCount === 1 ? '' : 's'}) has no extractable text layer — it is almost certainly scanned or image-only. There is nothing to read as text; tell the user it looks image-based.`;
          }
          const header = `[PDF text — ${extracted.pageCount} page${extracted.pageCount === 1 ? '' : 's'}, ${extracted.charCount} chars${extracted.truncated ? `, truncated to the first ${extracted.pagesExtracted} page(s)` : ''}]`;
          return `${header}\n${trimmed}`;
        } catch (err) {
          const reason = err instanceof PdfExtractError ? err.message : (err instanceof Error ? err.message : String(err));
          return `Error reading PDF text: ${reason}`;
        }
      }
      case 'pdf_merge': {
        const inputs = args.input_paths as string[] | undefined;
        if (!inputs || inputs.length < 2) return 'Error: input_paths must have at least 2 files.';
        for (const p of inputs) if (!fs.existsSync(p)) return `Error: file not found: ${p}`;
        const outFile = args.output_filename as string;
        const out = resolveOutputPath(agentId, outFile);
        const { pageCount } = await mergePdfs(inputs, out);
        return `Merged ${inputs.length} PDFs (${pageCount} total pages) → ${out}.`;
      }
      case 'pdf_extract_pages': {
        const p = args.path as string;
        const pages = args.pages as number[] | undefined;
        const outFile = args.output_filename as string;
        if (!p || !pages || pages.length === 0 || !outFile) return 'Error: path, pages, and output_filename are required.';
        if (!fs.existsSync(p)) return `Error: file not found: ${p}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const src = await loadPdf(p) as any;
        const total = src.getPageCount();
        const indices = normalizePageList(pages, total);
        if (indices.length === 0) return 'Error: no valid page indices after normalization.';
        const out = resolveOutputPath(agentId, outFile);
        const { pageCount } = await extractPages(p, indices, out);
        return `Extracted ${pageCount} page(s) → ${out}.`;
      }
      case 'pdf_rotate_pages': {
        const p = args.path as string;
        const rotations = args.rotations as Array<{ page: number; degrees: number }> | undefined;
        const outFile = args.output_filename as string;
        if (!p || !rotations || !outFile) return 'Error: path, rotations, and output_filename are required.';
        if (!fs.existsSync(p)) return `Error: file not found: ${p}`;
        for (const r of rotations) {
          if (r.degrees % 90 !== 0) return `Error: rotation must be a multiple of 90; got ${r.degrees}.`;
        }
        const out = resolveOutputPath(agentId, outFile);
        await rotatePages(p, rotations, out);
        return `Rotated ${rotations.length} page(s) → ${out}.`;
      }
      case 'pdf_reorder_pages': {
        const p = args.path as string;
        const order = args.new_order as number[] | undefined;
        const outFile = args.output_filename as string;
        if (!p || !order || !outFile) return 'Error: path, new_order, and output_filename are required.';
        if (!fs.existsSync(p)) return `Error: file not found: ${p}`;
        const out = resolveOutputPath(agentId, outFile);
        await reorderPages(p, order, out);
        return `Reordered pages → ${out}.`;
      }
      case 'pdf_delete_pages': {
        const p = args.path as string;
        const pages = args.pages as number[] | undefined;
        const outFile = args.output_filename as string;
        if (!p || !pages || pages.length === 0 || !outFile) return 'Error: path, pages, and output_filename are required.';
        if (!fs.existsSync(p)) return `Error: file not found: ${p}`;
        const out = resolveOutputPath(agentId, outFile);
        const { pageCount } = await deletePages(p, pages, out);
        return `Deleted ${pages.length} page(s); ${pageCount} remain → ${out}.`;
      }
      case 'pdf_watermark': {
        const p = args.path as string;
        const text = args.text as string;
        const outFile = args.output_filename as string;
        if (!p || !text || !outFile) return 'Error: path, text, and output_filename are required.';
        if (!fs.existsSync(p)) return `Error: file not found: ${p}`;
        const out = resolveOutputPath(agentId, outFile);
        await watermarkPdf(p, out, {
          text,
          opacity: args.opacity as number | undefined,
          size_pt: args.size_pt as number | undefined,
          color: args.color as string | undefined,
          rotation_deg: args.rotation_deg as number | undefined,
          pages: args.pages as number[] | undefined,
        });
        return `Watermarked PDF saved → ${out}.`;
      }
      case 'pdf_fill_form': {
        const p = args.path as string;
        const values = args.values as Record<string, string | boolean | number> | undefined;
        const outFile = args.output_filename as string;
        if (!p || !values || !outFile) return 'Error: path, values, and output_filename are required.';
        if (!fs.existsSync(p)) return `Error: file not found: ${p}`;
        const out = resolveOutputPath(agentId, outFile);
        const result = await fillForm(p, out, values, (args.flatten as boolean) ?? false);
        return `Filled ${result.filledFields} field(s) → ${out}. ${result.unmatchedKeys.length > 0 ? `Unmatched keys: ${result.unmatchedKeys.join(', ')}.` : ''}`.trim();
      }
      default:
        return `Error: unknown PDF tool: ${name}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('PDF tool failed', { name, error: msg });
    return `Error in ${name}: ${msg}`;
  }
}
