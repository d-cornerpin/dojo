import type { CanvasPersisted } from '../lib/api';
import type { DockSpec } from './RightDockProvider';

// A persisted canvas only ever stores media kinds; map it back to a DockSpec.
export function persistedToDockSpec(s: CanvasPersisted['state']): DockSpec {
  if (s.kind === 'iframe' && s.url) return { kind: 'iframe', title: s.title, url: s.url };
  if (s.kind === 'screenshot' && s.url && s.sourceUrl) return { kind: 'screenshot', title: s.title, url: s.url, sourceUrl: s.sourceUrl };
  return { kind: 'canvas', title: s.title, html: s.html, url: s.url, path: s.path };
}

/** The plain "could not load" state shown in the dock when a canvas read failed, with a Retry. */
export function loadFailedDock(onRetry: () => void): DockSpec {
  return {
    kind: 'panel',
    title: 'Canvas',
    content: (
      <div className="dojo3-canvas__state dojo3-canvas__state--err">
        Could not load this canvas.{' '}
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>Retry</button>
      </div>
    ),
  };
}
