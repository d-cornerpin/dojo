import { useState } from 'react';
import { useRightDock, isMediaDock, type DockSpec } from './RightDockProvider';
import { CanvasView } from './CanvasView';
import { ScreenShareViewer } from './ScreenShareViewer';

function RefreshIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" />
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

/* The right-dock contents. Media docks (canvas/iframe) carry a refresh+close
   bar; a 'panel' dock renders its own chrome. The refresh remounts the frame
   (re-fetches the url / re-renders the html). */
export function RightDock({ dock }: { dock: DockSpec }) {
  const { close } = useRightDock();
  const [refreshKey, setRefreshKey] = useState(0);

  // The canvas is content-aware (renders HTML / Markdown / text / images, with
  // a download button + auto-refresh) — it owns its own header + body.
  if (dock.kind === 'canvas') {
    return <CanvasView dock={dock} />;
  }

  const media = isMediaDock(dock);
  const title = dock.title ?? (
    dock.kind === 'iframe' || dock.kind === 'screenshot' ? 'Browser'
    : dock.kind === 'screen' ? 'Screen'
    : 'Panel'
  );

  let frame: React.ReactNode = null;
  if (dock.kind === 'iframe') {
    frame = <iframe key={refreshKey} src={dock.url} title={title} className="dojo3-dock__frame" />;
  } else if (dock.kind === 'screenshot') {
    // This site blocks iframe embedding, so we show a full-page screenshot
    // captured server-side. The overlay button opens the real, interactive
    // site in a new browser tab.
    frame = (
      <div className="dojo3-dock__shot-wrap">
        <div key={refreshKey} className="dojo3-dock__shot">
          <img src={dock.url} alt={title} className="dojo3-dock__shot-img" />
        </div>
        <button
          type="button"
          className="dojo3-dock__shot-open"
          onClick={() => window.open(dock.sourceUrl, '_blank', 'noopener,noreferrer')}
          title="Open the live site in a new browser window"
        >
          Open in new window ↗
        </button>
      </div>
    );
  } else if (dock.kind === 'screen') {
    frame = <ScreenShareViewer />;
  }

  return (
    <div className="dojo3-dock__inner">
      {media && (
        <header className="dojo3-dock__bar">
          <span className="dojo3-dock__title">{title}</span>
          <div className="dojo3-dock__actions">
            <button
              type="button"
              className="dojo3-dock__btn"
              onClick={() => setRefreshKey((k) => k + 1)}
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshIcon />
            </button>
            <button
              type="button"
              className="dojo3-dock__btn"
              onClick={close}
              title="Close"
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          </div>
        </header>
      )}
      <div className="dojo3-dock__body">
        {dock.kind === 'panel' ? dock.content : frame}
      </div>
    </div>
  );
}
