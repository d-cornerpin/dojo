import { useState } from 'react';

/** The bare chevron glyph: up when expanded, down when collapsed. Pair it with your own clickable header. */
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

/** A small chevron button for collapsing or expanding a settings panel. */
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

// Per-key collapsed state for a group of panels, persisted to localStorage.
// `defaultCollapsed` lives here because `toggle` must flip an untouched key
// away from the DEFAULT, which `!prev[k]` cannot do: ask only via `isCollapsed`.
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
