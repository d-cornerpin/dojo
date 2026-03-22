import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import React from 'react';
import * as api from '../lib/api';

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (password: string) => Promise<string | null>;
  logout: () => void;
  checkAuth: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const checkAuth = useCallback(async (): Promise<boolean> => {
    const token = api.getToken();
    if (!token) {
      setIsAuthenticated(false);
      setIsLoading(false);
      return false;
    }

    // Retry a few times in case the server is still starting up
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await api.checkAuth();
      if (result.ok && result.data.authenticated) {
        setIsAuthenticated(true);
        setIsLoading(false);
        return true;
      }
      // If we got a real 401, don't retry
      if (!result.ok && (result.error === 'Unauthorized' || result.error === 'Invalid or expired token')) {
        break;
      }
      // Server might not be up yet — wait and retry
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    api.clearToken();
    setIsAuthenticated(false);
    setIsLoading(false);
    return false;
  }, []);

  const login = useCallback(async (password: string): Promise<string | null> => {
    const result = await api.login(password);
    if (result.ok) {
      setIsAuthenticated(true);
      return null;
    }
    return result.error;
  }, []);

  const logout = useCallback(() => {
    api.clearToken();
    setIsAuthenticated(false);
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return React.createElement(
    AuthContext.Provider,
    { value: { isAuthenticated, isLoading, login, logout, checkAuth } },
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
