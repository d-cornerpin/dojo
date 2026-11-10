import { type ReactNode } from 'react';
import { ThemeContext, THEMES, DEFAULT_THEME } from './index';

interface ThemeProviderProps {
  children: ReactNode;
}

// No per-install switching: one always-active theme in index.css :root, and
// setTheme stays a no-op so the hidden Settings theme picker still compiles.
export const ThemeProvider = ({ children }: ThemeProviderProps) => {
  return (
    <ThemeContext.Provider value={{ themeId: DEFAULT_THEME, setTheme: () => {}, themes: THEMES }}>
      {children}
    </ThemeContext.Provider>
  );
};
