import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WsEvent } from '@dojo/shared';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useRightDock, type DockSpec } from './RightDockProvider';
import { CanvasMarkdown } from './CanvasMarkdown';

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

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
const MARKDOWN_EXTS = new Set(['.md', '.markdown']);
const HTML_EXTS = new Set(['.html', '.htm']);

/** Pull the fileId out of one of our own download URLs, else null. */
function fileIdFromUrl(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/\/api\/upload\/download\/([^/?#]+)/);
  return m ? m[1] : null;
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

  // ── Body ──
  let body: React.ReactNode = null;
  if (htmlInline) {
    body = (
      <iframe
        key={nonce}
        srcDoc={dock.html}
        title={title}
        className="dojo3-dock__frame"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      />
    );
  } else if (externalUrl) {
    body = <iframe key={nonce} src={dock.url} title={title} className="dojo3-dock__frame" />;
  } else if (fileBacked) {
    if (loading && !meta) {
      body = <div className="dojo3-canvas__state">Loading…</div>;
    } else if (error) {
      body = <div className="dojo3-canvas__state dojo3-canvas__state--err">{error}</div>;
    } else if (meta) {
      const ext = meta.ext;
      const isImage = meta.mime.startsWith('image/') || IMAGE_EXTS.has(ext);
      const isPdf = meta.mime === 'application/pdf' || ext === '.pdf';
      const isHtml = HTML_EXTS.has(ext) || meta.mime === 'text/html';
      if (isHtml) {
        body = <iframe key={nonce} src={meta.inlineUrl} title={title} className="dojo3-dock__frame" />;
      } else if (isImage) {
        body = (
          <div className="dojo3-canvas__media">
            <img key={nonce} src={meta.inlineUrl} alt={meta.filename} />
          </div>
        );
      } else if (isPdf) {
        body = <iframe key={nonce} src={meta.inlineUrl} title={title} className="dojo3-dock__frame" />;
      } else if (typeof meta.text === 'string') {
        body = MARKDOWN_EXTS.has(ext) ? (
          <div className="dojo3-canvas__doc dojo3-canvas__doc--md">
            <CanvasMarkdown content={meta.text} />
          </div>
        ) : (
          <div className="dojo3-canvas__doc">
            <pre className="dojo3-canvas__code">{meta.text}</pre>
          </div>
        );
      } else {
        // Too large to inline, or unknown text type — let the browser try.
        body = <iframe key={nonce} src={meta.inlineUrl} title={title} className="dojo3-dock__frame" />;
      }
    }
  }

  return (
    <div className="dojo3-dock__inner">
      <header className="dojo3-dock__bar">
        <span className="dojo3-dock__title">{title}</span>
        <div className="dojo3-dock__actions">
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
