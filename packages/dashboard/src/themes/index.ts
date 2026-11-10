import { createContext, useContext } from 'react';


export interface ThemeMeta {
  id: string;
  name: string;
  description: string;
  cssPath: string;
}

/**
 * One theme, and it is the default: the loader early-returns for the default,
 * so no override stylesheet is ever injected. Add an entry once fully built.
 */
export const THEMES: ThemeMeta[] = [
  {
    id: 'sumi',
    name: 'Sumi',
    description: 'Dark ink on washi paper, the readable v3 light look',
    cssPath: '/themes/sumi/theme.css',
  },
];

export const DEFAULT_THEME = 'sumi';


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
