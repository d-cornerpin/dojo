import { createContext, useContext } from 'react';

// ── Theme Registry ──

export interface ThemeMeta {
  id: string;
  name: string;
  description: string;
  /** Path to the theme CSS module (relative import) */
  cssPath: string;
}

/**
 * v3 ships a SINGLE theme: the readable light look baked into index.css :root.
 * There is intentionally only one entry, and it IS the default — so the theme
 * loader never injects an override stylesheet (it early-returns for the default
 * theme), and nothing can ever swap --ui-on-base-ch back to white. The theme
 * picker in Settings is hidden for the same reason. Re-introduce a dark theme
 * here only once it has been fully built and verified.
 */
export const THEMES: ThemeMeta[] = [
  {
    id: 'sumi',
    name: 'Sumi',
    description: 'Dark ink on washi paper — the readable v3 light look',
    cssPath: '/themes/sumi/theme.css',
  },
];

export const DEFAULT_THEME = 'sumi';

// ── Theme Context ──

export interface ThemeContextValue {
  themeId: string;
  setTheme: (id: string) => void;
  themes: ThemeMeta[];
}

export const ThemeContext = createContext<ThemeContextValue>({
  themeId: DEFAULT_THEME,
  setTheme: () => {},
  themes: THEMES,
});

export const useTheme = () => useContext(ThemeContext);
