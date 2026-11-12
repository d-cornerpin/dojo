// PDF text extraction for local models (Ollama) with no native document type, using pdfjs-dist's legacy
// build (works in plain Node without a DOM). Cloud providers with native PDF support get the raw PDF
// instead, so this is strictly the local-model fallback.

import { createLogger } from '../logger.js';

const logger = createLogger('pdf-extract');

// Cap on characters passed to the model per PDF (200k chars is about 50k tokens); beyond it the text is
// truncated and flagged so the caller can warn the user.
const MAX_CHARS = 200_000;

export interface PdfExtractResult {
  text: string;
  pageCount: number;
  pagesExtracted: number;
  charCount: number;
  truncated: boolean;
}

export class PdfExtractError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PdfExtractError';
  }
}

// Lazy-load pdfjs-dist: no import cost on cold starts without PDFs, and its worker file stays out of the
// main module graph.
let pdfjsModulePromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;
async function getPdfjs() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsModulePromise;
}

export async function extractPdfText(base64Data: string): Promise<PdfExtractResult> {
  if (!base64Data || typeof base64Data !== 'string') {
    throw new PdfExtractError('Empty or invalid base64 PDF data');
  }

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(base64Data, 'base64'));
  } catch (err) {
    throw new PdfExtractError('Failed to decode base64 PDF data', err);
  }

  if (bytes.length === 0) {
    throw new PdfExtractError('Decoded PDF is zero bytes');
  }

  const pdfjs = await getPdfjs();

  let pdf: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  try {
    pdf = await pdfjs.getDocument({
      data: bytes,
      // Keep pdfjs out of font-face and eval paths: text extraction does not need them and they pull in DOM-only code.
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      // Suppress the noisy warnings pdfjs emits for unusual but non-fatal encodings.
      verbosity: 0,
    }).promise;
  } catch (err) {
    throw new PdfExtractError(
      `pdfjs failed to open PDF: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const pageCount = pdf.numPages;
  const parts: string[] = [];
  let charCount = 0;
  let pagesExtracted = 0;
  let truncated = false;

  try {
    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();

      // Join items with spaces within a page and keep page breaks, so the model can tell which page a quote is from.
      const pageText = content.items
        .map(item => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .filter(s => s.length > 0)
        .join(' ');

      const labeled = `--- Page ${pageNum} ---\n${pageText}\n`;

      if (charCount + labeled.length > MAX_CHARS) {
        // Include as much of this page as fits, then stop.
        const remaining = Math.max(0, MAX_CHARS - charCount);
        if (remaining > 0) {
          parts.push(labeled.slice(0, remaining));
          charCount += remaining;
          pagesExtracted++;
        }
        truncated = true;
        break;
      }

      parts.push(labeled);
      charCount += labeled.length;
      pagesExtracted++;
    }
  } finally {
    // pdfjs holds a worker reference internally; release it so long-lived runtimes do not accumulate open documents.
    try { await pdf.destroy(); } catch { /* best-effort cleanup */ }
  }

  const text = parts.join('\n').trim();

  logger.info('Extracted PDF text', {
    pageCount,
    pagesExtracted,
    charCount: text.length,
    truncated,
  });

  return {
    text,
    pageCount,
    pagesExtracted,
    charCount: text.length,
    truncated,
  };
}
