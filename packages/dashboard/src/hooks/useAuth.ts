import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import React from 'react';
import * as api from '../lib/api';

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  isWaiting: boolean;   // the Dojo has not answered yet
  login: (password: string) => Promise<string | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isWaiting, setIsWaiting] = useState(false);

  // A dead network or the 503 while the Dojo starts is waited out; only a real 401 ends the sign-in.
  useEffect(() => {
    let live = true;
    void (async () => {
      let result = api.getToken() ? await api.checkAuth() : null;
      while (live && result && !result.ok && result.error !== 'Unauthorized') {
        setIsWaiting(true);
        await new Promise((r) => setTimeout(r, 1500));
        result = await api.checkAuth();
      }
      if (!live) return;
      if (!result?.ok) api.clearToken();
      setIsAuthenticated(!!result?.ok);
      setIsLoading(false);
    })();
    return () => { live = false; };
  }, []);

  const login = useCallback(async (password: string): Promise<string | null> => {
    const result = await api.login(password);
    if (result.ok) {
      setIsAuthenticated(true);
      return null;
    }
    return result.error;
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    api.clearToken();
    setIsAuthenticated(false);
  }, []);

  return React.createElement(
    AuthContext.Provider,
    { value: { isAuthenticated, isLoading, isWaiting, login, logout } },
    children,
  );
};

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
