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
 * All available themes. To add a new theme:
 * 1. Create a folder under src/themes/<id>/
 * 2. Add a theme.css with :root variable overrides
 * 3. Add an entry here
 */
export const THEMES: ThemeMeta[] = [
  {
    id: 'miyagi',
    name: 'Miyagi',
    description: 'Deep space glassmorphism with warm amber accents',
    cssPath: '/themes/miyagi/theme.css',
  },
];

export const DEFAULT_THEME = 'miyagi';

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
