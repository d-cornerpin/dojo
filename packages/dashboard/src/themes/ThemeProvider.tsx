import { type ReactNode } from 'react';
import { ThemeContext, THEMES, DEFAULT_THEME } from './index';

interface ThemeProviderProps {
  children: ReactNode;
}

/**
 * v3 ships a SINGLE baked-in theme — the readable light look defined in
 * index.css :root. There is intentionally no per-install theme switching:
 * nothing fetches the old `feng_shui_theme` setting and nothing ever injects
 * an override stylesheet, so the readable defaults in :root are always
 * authoritative and no code path can flip --ui-on-base-ch back to white.
 *
 * The context API is kept (setTheme is a no-op) so the now-hidden Settings
 * theme picker still compiles. Restore real switching here only once a second,
 * fully-built theme exists.
 */
export const ThemeProvider = ({ children }: ThemeProviderProps) => {
  return (
    <ThemeContext.Provider value={{ themeId: DEFAULT_THEME, setTheme: () => {}, themes: THEMES }}>
      {children}
    </ThemeContext.Provider>
  );
};
