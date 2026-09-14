import { useState } from 'react';

/** The bare chevron glyph — points up when expanded (collapsed=false), down
 *  when collapsed. Use this inside an existing clickable header; use
 *  CollapseToggle when you need the standalone button. */
export function CollapseChevron({ collapsed, className = '' }: { collapsed: boolean; className?: string }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={`transition-transform ${collapsed ? '' : 'rotate-180'} ${className}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** A small chevron button for collapsing/expanding a settings panel. Points up
 *  when expanded (click to collapse), down when collapsed (click to expand). */
export function CollapseToggle({ collapsed, onClick, label }: { collapsed: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={!collapsed}
      aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      title={collapsed ? 'Expand' : 'Collapse'}
      className="shrink-0 p-1 -m-1 rounded text-ui/35 hover:text-ui/70 transition-colors"
    >
      <CollapseChevron collapsed={collapsed} />
    </button>
  );
}

/**
 * Per-key collapsed state for a group of panels, persisted to localStorage so a
 * tab stays tidy across reloads.
 *
 * `defaultCollapsed` is what a key answers before anybody has touched it. It
 * lives in the hook rather than at the call site (where the three channel panels
 * each wrote their own `?? true`) because `toggle` has to agree with it: flipping
 * an untouched key has to flip it away from the DEFAULT, and a call site cannot
 * teach that to a `!prev[k]`. `isCollapsed` is therefore the only way to ask.
 *
 * UX-ACCESS A5 added the parameter for the Access panel, which opens collapsed.
 */
export function usePanelCollapse(storageKey: string, defaultCollapsed = false) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; }
  });
  const isCollapsed = (k: string): boolean => collapsed[k] ?? defaultCollapsed;
  const toggle = (k: string) => setCollapsed(prev => {
    const next = { ...prev, [k]: !(prev[k] ?? defaultCollapsed) };
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });
  return { isCollapsed, toggle };
}
