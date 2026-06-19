import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WsEvent } from '@dojo/shared';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useRightDock, type DockSpec } from './RightDockProvider';
import { CanvasMarkdown } from './CanvasMarkdown';
import { CanvasCode } from './CanvasCode';

/*
 * The canvas: a content-aware view in the right dock. It renders three ways:
 *   - inline HTML (dock.html)        -> sandboxed iframe (srcDoc)
 *   - a file on disk (dock.url is a /api/upload/download/<id> URL, or dock.path)
 *        -> fetched + rendered by type: HTML iframe, Markdown formatted,
 *           text/code monospaced, images/PDF inline. Gets a download button.
 *   - an external URL                -> plain iframe
 *
 * File-backed canvases auto-refresh: when the agent edits the backing file
 * (file_write / file_patch / file_append) the server emits `canvas:updated`
 * with the path, and we re-fetch — no manual refresh, no re-issued tool call.
 */

interface DescribeData {
  fileId: string;
  filename: string;
  mime: string;
  ext: string;
  size: number;
  path: string;
  text?: string;
  inlineUrl: string;
  downloadUrl: string;
  /** For Word/Excel: a /render URL that serves an HTML preview. null otherwise. */
  renderUrl?: string | null;
}

function RefreshIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
const MARKDOWN_EXTS = new Set(['.md', '.markdown']);
const HTML_EXTS = new Set(['.html', '.htm']);
// Plain text shown as-is (no highlighting); everything else text-like is treated
// as code and syntax-highlighted.
const PLAIN_TEXT_EXTS = new Set(['.txt', '.text', '.log', '']);

/** Pull the fileId out of one of our own download URLs, else null. */
function fileIdFromUrl(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/\/api\/upload\/download\/([^/?#]+)/);
  return m ? m[1] : null;
}

/**
 * Copy text robustly. The async Clipboard API only works in a secure context
 * (https / localhost) with focus + permission — over a tunnel, a LAN IP, or
 * when the page isn't focused it throws. So we try it, then fall back to the
 * legacy execCommand('copy') via a hidden textarea, which works on plain http
 * and older setups. Returns whether anything actually landed on the clipboard.
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CanvasView({ dock }: { dock: Extract<DockSpec, { kind: 'canvas' }> }) {
  const { close } = useRightDock();
  const { subscribe } = useWebSocket();
  const [nonce, setNonce] = useState(0);

  const htmlInline = dock.html != null;
  const fileId = useMemo(() => fileIdFromUrl(dock.url), [dock.url]);
  const fileBacked = !htmlInline && !!fileId;
  const externalUrl = !htmlInline && !fileBacked && !!dock.url;

  const [meta, setMeta] = useState<DescribeData | null>(null);
  const [loading, setLoading] = useState(fileBacked);
  const [error, setError] = useState<string | null>(null);
  // For HTML canvases: toggle between the rendered page and its source.
  const [htmlView, setHtmlView] = useState<'rendered' | 'code'>('rendered');
  useEffect(() => { setHtmlView('rendered'); }, [dock.html, dock.url, dock.path]);

  // Fetch file metadata + (for text) content. Re-runs on refresh / auto-refresh.
  useEffect(() => {
    if (!fileBacked || !fileId) { setMeta(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.request<DescribeData>(`/upload/describe/${fileId}`).then((res) => {
      if (cancelled) return;
      if (res.ok) setMeta(res.data);
      else setError(res.error || 'Could not load file');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [fileBacked, fileId, nonce]);

  // Auto-refresh when the backing file is edited on disk.
  const watchedPath = dock.path ?? meta?.path ?? null;
  useEffect(() => {
    if (!fileBacked || !watchedPath) return;
    const unsub = subscribe('canvas:updated', (e: WsEvent) => {
      if (e.type !== 'canvas:updated') return;
      if (e.data.path === watchedPath) setNonce((n) => n + 1);
    });
    return unsub;
  }, [fileBacked, watchedPath, subscribe]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const title = dock.title ?? meta?.filename ?? 'Canvas';
  const canDownload = fileBacked && !!meta;

  // Type flags (meta-dependent ones are false until metadata loads).
  const ext = meta?.ext ?? '';
  const isImage = !!meta && (meta.mime.startsWith('image/') || IMAGE_EXTS.has(ext));
  const isPdf = !!meta && (meta.mime === 'application/pdf' || ext === '.pdf');
  const isHtmlFile = !!meta && (HTML_EXTS.has(ext) || meta.mime === 'text/html');
  // An HTML canvas (inline markup OR an .html file) gets the Rendered / Code tab.
  const isHtmlCanvas = htmlInline || (fileBacked && isHtmlFile);
  const htmlSource = htmlInline ? dock.html ?? '' : isHtmlFile ? meta?.text ?? '' : '';

  // ── Copy contents to clipboard ──
  // What gets copied depends on the type: the HTML source for an HTML canvas,
  // the raw text for code/markdown/json/csv, and the document's text for
  // Word/Excel (pulled from the rendered same-origin iframe). Images/PDF/
  // external pages have no useful text, so the button is hidden for them.
  const [copied, setCopied] = useState(false);
  const canCopy =
    (isHtmlCanvas && !!htmlSource) ||
    (!!meta && typeof meta.text === 'string' && meta.text.length > 0) ||
    !!meta?.renderUrl;
  const handleCopy = useCallback(async () => {
    let text = '';
    if (isHtmlCanvas && htmlSource) {
      text = htmlSource;
    } else if (meta && typeof meta.text === 'string' && meta.text) {
      text = meta.text;
      if (ext === '.json') { try { text = JSON.stringify(JSON.parse(meta.text), null, 2); } catch { /* keep raw */ } }
    } else if (meta?.renderUrl) {
      // Word/Excel: read the rendered (same-origin) iframe's text; if that comes
      // back empty (not loaded yet, or blocked), fetch the render HTML and parse.
      const frame = document.querySelector('.dojo3-dock__frame') as HTMLIFrameElement | null;
      text = frame?.contentDocument?.body?.innerText?.trim() ?? '';
      if (!text) {
        try {
          const tok = localStorage.getItem('dojo_token');
          const res = await fetch(meta.renderUrl, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
          const html = await res.text();
          const parsed = new DOMParser().parseFromString(html, 'text/html');
          text = (parsed.body?.innerText || parsed.body?.textContent || '').trim();
        } catch { /* leave empty */ }
      }
    }
    if (!text) return;
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }, [isHtmlCanvas, htmlSource, meta, ext]);

  // ── Body ──
  let body: React.ReactNode = null;
  if (externalUrl) {
    body = <iframe key={nonce} src={dock.url} title={title} className="dojo3-dock__frame" />;
  } else if (isHtmlCanvas && (htmlInline || meta)) {
    if (htmlView === 'code') {
      body = htmlSource ? (
        <div className="dojo3-canvas__doc">
          <CanvasCode content={htmlSource} ext=".html" />
        </div>
      ) : (
        <div className="dojo3-canvas__state">Source isn’t available for this page (too large to load inline).</div>
      );
    } else if (htmlInline) {
      body = (
        <iframe
          key={nonce}
          srcDoc={dock.html}
          title={title}
          className="dojo3-dock__frame"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      );
    } else {
      body = <iframe key={nonce} src={meta!.inlineUrl} title={title} className="dojo3-dock__frame" />;
    }
  } else if (fileBacked) {
    if (loading && !meta) {
      body = <div className="dojo3-canvas__state">Loading…</div>;
    } else if (error) {
      body = <div className="dojo3-canvas__state dojo3-canvas__state--err">{error}</div>;
    } else if (meta) {
      if (isImage) {
        body = (
          <div className="dojo3-canvas__media">
            <img key={nonce} src={meta.inlineUrl} alt={meta.filename} />
          </div>
        );
      } else if (isPdf) {
        body = <iframe key={nonce} src={meta.inlineUrl} title={title} className="dojo3-dock__frame" />;
      } else if (meta.renderUrl) {
        // Word / Excel / CSV — rendered to HTML (a table/document) by the server.
        body = <iframe key={nonce} src={meta.renderUrl} title={title} className="dojo3-dock__frame" />;
      } else if (typeof meta.text === 'string') {
        if (MARKDOWN_EXTS.has(ext)) {
          body = (
            <div className="dojo3-canvas__doc dojo3-canvas__doc--md">
              <CanvasMarkdown content={meta.text} />
            </div>
          );
        } else if (ext === '.json') {
          // Pretty-print valid JSON; fall back to the raw text otherwise.
          let src = meta.text;
          try { src = JSON.stringify(JSON.parse(meta.text), null, 2); } catch { /* keep raw */ }
          body = <div className="dojo3-canvas__doc"><CanvasCode content={src} ext=".json" /></div>;
        } else if (PLAIN_TEXT_EXTS.has(ext)) {
          body = <div className="dojo3-canvas__doc"><pre className="dojo3-canvas__code">{meta.text}</pre></div>;
        } else {
          body = <div className="dojo3-canvas__doc"><CanvasCode content={meta.text} ext={ext} /></div>;
        }
      } else {
        // Binary / unpreviewable type (e.g. .doc, .pptx, a zip) — offer the download.
        body = (
          <div className="dojo3-canvas__state">
            Preview isn’t available for {ext || 'this file type'}. Use the download button above to open it.
          </div>
        );
      }
    }
  }

  return (
    <div className="dojo3-dock__inner">
      <header className="dojo3-dock__bar">
        <span className="dojo3-dock__title">{title}</span>
        {isHtmlCanvas && (
          <div className="dojo3-dock__tabs" role="tablist" aria-label="Canvas view">
            <button
              type="button"
              role="tab"
              aria-selected={htmlView === 'rendered'}
              className={`dojo3-dock__tab ${htmlView === 'rendered' ? 'is-active' : ''}`}
              onClick={() => setHtmlView('rendered')}
            >
              Rendered
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={htmlView === 'code'}
              className={`dojo3-dock__tab ${htmlView === 'code' ? 'is-active' : ''}`}
              onClick={() => setHtmlView('code')}
            >
              Code
            </button>
          </div>
        )}
        <div className="dojo3-dock__actions">
          {canCopy && (
            <button
              type="button"
              className={`dojo3-dock__btn ${copied ? 'is-copied' : ''}`}
              onClick={handleCopy}
              title={copied ? 'Copied!' : 'Copy contents'}
              aria-label="Copy contents"
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
          )}
          {canDownload && (
            <a
              className="dojo3-dock__btn"
              href={meta!.downloadUrl}
              download={meta!.filename}
              title="Download"
              aria-label="Download"
            >
              <DownloadIcon />
            </a>
          )}
          <button type="button" className="dojo3-dock__btn" onClick={refresh} title="Refresh" aria-label="Refresh">
            <RefreshIcon />
          </button>
          <button type="button" className="dojo3-dock__btn" onClick={close} title="Close" aria-label="Close">
            <CloseIcon />
          </button>
        </div>
      </header>
      <div className="dojo3-dock__body">{body}</div>
    </div>
  );
}
