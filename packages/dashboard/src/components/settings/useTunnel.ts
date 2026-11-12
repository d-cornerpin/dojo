// ── State and actions for the Remote Access card; a refused action is reported to the user.

import { useState, useEffect } from 'react';
import * as api from '../../lib/api';

// ── Remote Access (Cloudflare Tunnel) ──

export type TunnelStatus = {
  enabled: boolean;
  mode: 'quick' | 'named';
  status: string;
  url: string | null;
  error: string | null;
  startedAt: number | null;
  cloudflaredInstalled: boolean;
};

export const useTunnel = () => {
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<'quick' | 'named'>('quick');
  const [token, setToken] = useState('');
  const [namedUrl, setNamedUrl] = useState('');
  const [acting, setActing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = async () => {
    const result = await api.request<TunnelStatus>('/system/tunnel');
    setLoading(false);
    if (!result.ok) {
      // A failed request must set an error: `status` stays null otherwise, which this card
      // draws as "cloudflared is not installed" and offers an install button.
      setLoadError(result.error);
      return;
    }
    setLoadError(null);
    setStatus(result.data);
    setMode(result.data.mode);
    // Pre-fill the named URL field from the saved value (when in named mode)
    // so the user can see what's stored without re-typing it.
    if (result.data.mode === 'named' && result.data.url && !namedUrl) {
      setNamedUrl(result.data.url);
    }
  };

  useEffect(() => { load(); }, []);

  // Poll while tunnel is starting
  useEffect(() => {
    if (status?.status !== 'starting') return;
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [status?.status]);

  const handleSaveNamedUrl = async () => {
    setActing(true);
    setActionError(null);
    try {
      const result = await api.request('/system/tunnel/named-url', {
        method: 'POST',
        body: JSON.stringify({ url: namedUrl.trim() || null }),
      });
      if (!result.ok) setActionError(result.error);
    } finally {
      await load();
      setActing(false);
    }
  };

  const handleEnable = async () => {
    setActing(true);
    setActionError(null);
    try {
      if (mode === 'named' && token.trim()) {
        const saved = await api.request('/system/tunnel/token', {
          method: 'POST',
          body: JSON.stringify({
            token: token.trim(),
            // Send the URL alongside the token so it's persisted in the same call
            url: namedUrl.trim() || null,
          }),
        });
        if (!saved.ok) {
          setActionError(saved.error);
          return;
        }
      }
      const result = await api.request('/system/tunnel/enable', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      if (!result.ok) setActionError(result.error);
    } finally {
      await load();
      setActing(false);
    }
  };

  const handleDisable = async () => {
    setActing(true);
    setActionError(null);
    try {
      const result = await api.request('/system/tunnel/disable', { method: 'POST' });
      if (!result.ok) setActionError(result.error);
    } finally {
      await load();
      setActing(false);
    }
  };

  const handleInstall = async () => {
    setInstalling(true);
    setActionError(null);
    try {
      const result = await api.request('/system/tunnel/install-cloudflared', { method: 'POST' });
      if (!result.ok) setActionError(result.error);
    } finally {
      await load();
      setInstalling(false);
    }
  };

  return {
    status, loading, loadError, mode, setMode, token, setToken, namedUrl, setNamedUrl,
    acting, installing, actionError, load,
    handleSaveNamedUrl, handleEnable, handleDisable, handleInstall,
  };
};
