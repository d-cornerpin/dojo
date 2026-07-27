// PHASE-0 T12b (P421): the PUBLIC download route must never hand out something
// a browser will execute as a document on our origin.
//
// `/api/upload/download/` is in ALWAYS_PUBLIC_PREFIXES (the unguessable UUID is
// the credential), it serves MODEL-AUTHORED bytes (every file_write registers
// itself there), and in production the dashboard is served from that same
// origin. Before this task, `?inline=1` on an .html file answered
// `text/html` + `Content-Disposition: inline`, so opening the link in a tab ran
// model-written script with the owner's session cookie attached — and tools.ts
// appended `?inline=1` automatically on every canvas open, so those URLs were
// real, not hypothetical.
//
// The rule under test: a response may render as a document ONLY if its type
// cannot carry script. The canvas is unaffected because it FETCHES the HTML and
// renders it in a sandboxed srcDoc iframe (CanvasView.tsx) — fetch() ignores
// Content-Disposition entirely.

import { describe, it, expect } from 'vitest';
import { safeDownloadHeaders, sanitizeFilenameForHeader } from '../routes/upload.js';

/** Every way an attacker-supplied file can ask to be treated as a document. */
const SCRIPTABLE = [
  { mime: 'text/html', ext: '.html' },
  { mime: 'text/html; charset=utf-8', ext: '.htm' },
  { mime: 'application/xhtml+xml', ext: '.xhtml' },
  { mime: 'text/xml', ext: '.xml' },
  { mime: 'application/xml', ext: '.xml' },
  { mime: 'text/javascript', ext: '.js' },
  { mime: 'application/javascript', ext: '.mjs' },
  // Mislabelled on one side or the other — the extension and the mime are each
  // enough on their own, because both are attacker-chosen.
  { mime: 'image/png', ext: '.html' },
  { mime: 'text/html', ext: '.png' },
  { mime: 'text/plain', ext: '.js' },
];

describe('PHASE-0 T12b — public download disposition + content-type', () => {
  it('never renders a script-capable document, inline requested or not', () => {
    for (const { mime, ext } of SCRIPTABLE) {
      for (const inline of [true, false]) {
        const h = safeDownloadHeaders(mime, ext, inline);
        expect(h.disposition, `${mime} ${ext} inline=${inline}`).toBe('attachment');
        expect(h.contentType, `${mime} ${ext} inline=${inline}`).toBe('application/octet-stream');
      }
    }
  });

  it('keeps inline rendering for types that cannot execute script', () => {
    const safe = [
      { mime: 'image/png', ext: '.png' },
      { mime: 'image/jpeg', ext: '.jpg' },
      { mime: 'image/gif', ext: '.gif' },
      { mime: 'image/webp', ext: '.webp' },
      { mime: 'application/pdf', ext: '.pdf' },
      { mime: 'audio/mpeg', ext: '.mp3' },
      { mime: 'video/mp4', ext: '.mp4' },
      { mime: 'text/plain', ext: '.txt' },
    ];
    for (const { mime, ext } of safe) {
      expect(safeDownloadHeaders(mime, ext, true), `${mime} ${ext}`).toEqual({
        contentType: mime,
        disposition: 'inline',
      });
    }
  });

  it('defaults to attachment when inline was not asked for', () => {
    expect(safeDownloadHeaders('image/png', '.png', false).disposition).toBe('attachment');
    expect(safeDownloadHeaders('application/pdf', '.pdf', false).disposition).toBe('attachment');
  });

  it('forces SVG to attachment but keeps its mime so <img> still renders it', () => {
    // An SVG is a scripted document at top level and an inert picture inside
    // <img>. Content-Disposition does not affect subresource loads, so
    // attachment costs the canvas nothing and closes the navigation.
    const h = safeDownloadHeaders('image/svg+xml', '.svg', true);
    expect(h.disposition).toBe('attachment');
    expect(h.contentType).toBe('image/svg+xml');
  });

  it('falls back to octet-stream for an unknown or missing type', () => {
    expect(safeDownloadHeaders('', '.weirdext', true)).toEqual({
      contentType: 'application/octet-stream', disposition: 'attachment',
    });
    expect(safeDownloadHeaders(null, '', true)).toEqual({
      contentType: 'application/octet-stream', disposition: 'attachment',
    });
    // An unknown type is never rendered, even when inline is requested.
    expect(safeDownloadHeaders('application/x-msdownload', '.exe', true).disposition).toBe('attachment');
  });

  it('is case-insensitive on both the extension and the mime', () => {
    expect(safeDownloadHeaders('TEXT/HTML', '.HTML', true).contentType).toBe('application/octet-stream');
    expect(safeDownloadHeaders('IMAGE/PNG', '.PNG', true).disposition).toBe('inline');
  });

  it('strips CR/LF and quotes from the filename so no second header can be injected', () => {
    expect(sanitizeFilenameForHeader('a.txt\r\nX-Evil: 1')).toBe('a.txt__X-Evil: 1');
    expect(sanitizeFilenameForHeader('a".html')).toBe('a_.html');
    expect(sanitizeFilenameForHeader('normal-name.pdf')).toBe('normal-name.pdf');
  });
});
