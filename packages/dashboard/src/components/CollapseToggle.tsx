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

/** Per-key collapsed state for a group of panels, persisted to localStorage so
 *  the channels tab stays tidy across reloads. */
export function usePanelCollapse(storageKey: string) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; }
  });
  const toggle = (k: string) => setCollapsed(prev => {
    const next = { ...prev, [k]: !prev[k] };
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });
  return { collapsed, toggle };
}
