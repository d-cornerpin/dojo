// ════════════════════════════════════════
// PDF Text Extraction
// ════════════════════════════════════════
//
// Takes a base64-encoded PDF and returns the concatenated text content so
// local models (Ollama) that don't have a native document type can still
// consume PDF attachments. Uses pdfjs-dist's legacy build which works in
// plain Node without a DOM.
//
// Cloud providers with native PDF support (Anthropic Claude via the
// `document` content block) should NOT go through this path — they receive
// the raw PDF and handle extraction + vision internally, which is higher
// fidelity. This module is strictly the local-model fallback.

import { createLogger } from '../logger.js';

const logger = createLogger('pdf-extract');

// Cap on characters we'll pass to the model per PDF. Rough conversion: 200k
// chars ≈ 50k tokens. Beyond this we truncate and flag so the caller can
// warn the user — sending megabytes of text to a local 8k-context model is
// worse than useless.
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

// Lazy-load pdfjs-dist so we don't pay the import cost on cold starts where
// no PDFs are in play. pdfjs's legacy build targets Node via a dynamic
// import — keeping this lazy also avoids pulling the worker file into the
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
      // Keep pdfjs out of font-face / eval territory — none of that is
      // needed for text extraction and it can pull in DOM-only code paths.
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      // Suppress the noisy warnings pdfjs emits for unusual but
      // non-fatal encodings.
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

      // Each `item` has a `str` field; join with spaces within a page and
      // preserve page breaks between pages so the model can reason about
      // which page a quote came from.
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
    // pdfjs holds a worker reference internally; release it so we don't
    // accumulate open documents in long-lived agent runtimes.
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
