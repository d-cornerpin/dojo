import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { ThemeContext, THEMES, DEFAULT_THEME } from './index';
import * as api from '../lib/api';

const THEME_LINK_ID = 'dojo-feng-shui-theme';
const SETTING_KEY = 'feng_shui_theme';

/**
 * Loads a theme CSS file by injecting/swapping a <link> element in <head>.
 */
function loadThemeCSS(themeId: string): void {
  const theme = THEMES.find(t => t.id === themeId);
  if (!theme) return;

  // Remove existing theme link if any
  const existing = document.getElementById(THEME_LINK_ID);
  if (existing) existing.remove();

  // Miyagi is the default — its values are already in index.css :root,
  // so we don't need to load an additional CSS file for it.
  if (themeId === DEFAULT_THEME) return;

  // For non-default themes, inject a <link> that overrides :root variables
  const link = document.createElement('link');
  link.id = THEME_LINK_ID;
  link.rel = 'stylesheet';
  link.href = theme.cssPath;
  document.head.appendChild(link);
}

interface ThemeProviderProps {
  children: ReactNode;
}

export const ThemeProvider = ({ children }: ThemeProviderProps) => {
  const [themeId, setThemeId] = useState(DEFAULT_THEME);

  // Load saved theme on mount — but only if we have an auth token.
  // Without this check, the API call returns 401 on the login page,
  // the API client's 401 handler does window.location.href = '/login',
  // and the page reloads in an infinite loop.
  useEffect(() => {
    const token = localStorage.getItem('dojo_token');
    if (!token) return;

    api.getSetting(SETTING_KEY).then(res => {
      if (res.ok && res.data.value) {
        const savedId = res.data.value;
        if (THEMES.some(t => t.id === savedId)) {
          setThemeId(savedId);
          loadThemeCSS(savedId);
        }
      }
    }).catch(() => {
      // Network error — use default theme
    });
  }, []);

  const setTheme = useCallback((id: string) => {
    if (!THEMES.some(t => t.id === id)) return;
    setThemeId(id);
    loadThemeCSS(id);
    // Persist to server
    api.setSetting(SETTING_KEY, id).catch(() => {});
  }, []);

  // Render children immediately with the default theme.
  // If a different theme is saved, it loads asynchronously and the
  // CSS variables update in place — no flash because the default
  // values in index.css :root are always present.
  return (
    <ThemeContext.Provider value={{ themeId, setTheme, themes: THEMES }}>
      {children}
    </ThemeContext.Provider>
  );
};
