// ════════════════════════════════════════
// renderOfficeToHtml — convert Office documents to canvas-renderable HTML.
//
// The right-dock canvas (and view_canvas) render HTML in an iframe, but Word /
// Excel files are binary OOXML the browser can't display. This converts them
// to a clean, self-contained HTML page:
//   .docx              -> mammoth (semantic HTML)
//   .xlsx/.xls/.xlsm   -> SheetJS (one HTML table per sheet)
// Used by BOTH the /upload/render endpoint (dashboard canvas) and view_canvas
// (the agent), so what the agent sees matches what the user sees.
//
// Not handled: legacy .doc (binary Word) and .pptx — there is no bundled
// converter; callers fall back to a "download to view" message.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';

const RENDERABLE = new Set(['.docx', '.xlsx', '.xls', '.xlsm', '.xlsb', '.csv']);

export function isOfficeRenderable(ext: string): boolean {
  return RENDERABLE.has(ext.toLowerCase());
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c
  ));
}

// Clean, neutral document styling that sits comfortably on the canvas's light
// background (a plain white sheet for Word, tidy bordered tables for Excel).
const PAGE_STYLE = `
  *{box-sizing:border-box}
  html,body{margin:0}
  body{font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#2b2620;background:#fff;padding:30px 34px}
  .doc{max-width:760px;margin:0 auto}
  .doc h1{font-size:1.8em;margin:.8em 0 .4em} .doc h2{font-size:1.4em;margin:.8em 0 .4em} .doc h3{font-size:1.15em;margin:.8em 0 .4em}
  .doc p{margin:.6em 0} .doc img{max-width:100%;height:auto}
  .doc table{border-collapse:collapse;margin:1em 0}
  .doc td,.doc th{border:1px solid #ddd;padding:6px 10px}
  .sheet{margin:0 0 30px}
  .sheet__name{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:#9a7a52;margin:0 0 9px}
  .xtable{border-collapse:collapse;font-size:13px}
  .xtable td,.xtable th{border:1px solid #e6dfd1;padding:5px 10px;text-align:left;white-space:nowrap;max-width:340px;overflow:hidden;text-overflow:ellipsis}
  .xtable tr:first-child td{background:#f7f1e6;font-weight:600}
`;

function wrap(title: string, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<style>${PAGE_STYLE}</style></head><body>${inner}</body></html>`;
}

export async function renderOfficeToHtml(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  try {
    if (ext === '.docx') {
      const { value } = await mammoth.convertToHtml({ path: filePath });
      return wrap(base, `<article class="doc">${value || '<p><em>(empty document)</em></p>'}</article>`);
    }
    if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm' || ext === '.xlsb' || ext === '.csv') {
      // Read bytes ourselves — XLSX.readFile can't reach Node fs under ESM.
      const wb = ext === '.csv'
        ? XLSX.read(fs.readFileSync(filePath, 'utf-8'), { type: 'string' })
        : XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });
      const multi = wb.SheetNames.length > 1;
      const sheets = wb.SheetNames.map((name) => {
        const ws = wb.Sheets[name];
        const full = XLSX.utils.sheet_to_html(ws, { id: 'sheetjs' });
        // sheet_to_html may wrap the table in a full document; extract just the
        // <table> and give it our class.
        const m = full.match(/<table[\s\S]*?<\/table>/i);
        const table = (m ? m[0] : full).replace(/<table/i, '<table class="xtable"');
        // Only label sheets when there's more than one (a single sheet's name,
        // e.g. CSV's "Sheet1", is just noise).
        const label = multi ? `<div class="sheet__name">${escapeHtml(name)}</div>` : '';
        return `<section class="sheet">${label}${table}</section>`;
      }).join('\n');
      return wrap(base, sheets || '<p><em>(empty workbook)</em></p>');
    }
    return null;
  } catch {
    return null;
  }
}
