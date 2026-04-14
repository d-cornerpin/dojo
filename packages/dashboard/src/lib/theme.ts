/**
 * Read a CSS custom property value from :root.
 * Themes override these variables, so JS code that needs colors
 * (charts, dynamic backgrounds) stays in sync automatically.
 */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Agent avatar accent palette — returns 7 colors cycled by hash. */
export function getAgentColors(): string[] {
  return [
    cssVar('--agent-color-1') || '#F5A623',
    cssVar('--agent-color-2') || '#00D4AA',
    cssVar('--agent-color-3') || '#5B8DEF',
    cssVar('--agent-color-4') || '#A78BFA',
    cssVar('--agent-color-5') || '#FF6B8A',
    cssVar('--agent-color-6') || '#4AEDC4',
    cssVar('--agent-color-7') || '#7BA4F7',
  ];
}

/** Threshold colors for health/budget charts. */
export function getThresholdColor(pct: number): string {
  if (pct > 90) return cssVar('--threshold-critical') || '#ef4444';
  if (pct > 75) return cssVar('--threshold-high') || '#f97316';
  if (pct > 50) return cssVar('--threshold-warn') || '#eab308';
  return cssVar('--threshold-ok') || '#22c55e';
}
