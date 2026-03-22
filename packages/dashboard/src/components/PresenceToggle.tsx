import { useState, useEffect } from 'react';

interface PresenceData {
  status: 'in_dojo' | 'away';
  imessageConfigured: boolean;
}

function getToken(): string | null {
  return localStorage.getItem('dojo_token');
}

function getCsrf(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m ? m[1] : null;
}

export const PresenceToggle = ({ collapsed }: { collapsed: boolean }) => {
  const [presence, setPresence] = useState<PresenceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    const token = getToken();
    fetch('/api/system/presence', {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
      .then(r => r.json())
      .then(data => {
        if (data.ok) setPresence(data.data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const toggle = async () => {
    if (!presence || toggling) return;
    setToggling(true);
    const newStatus = presence.status === 'in_dojo' ? 'away' : 'in_dojo';
    const token = getToken();
    const csrf = getCsrf();
    await fetch('/api/system/presence', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      body: JSON.stringify({ status: newStatus }),
    });
    setPresence({ ...presence, status: newStatus });
    setToggling(false);
  };

  // Don't show if iMessage isn't configured or still loading
  if (loading || !presence?.imessageConfigured) return null;

  const isAway = presence.status === 'away';

  if (collapsed) {
    return (
      <div className="px-2 py-1.5 flex justify-center">
        <button
          onClick={toggle}
          disabled={toggling}
          className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm transition-colors ${
            isAway ? 'bg-cp-amber/20 text-cp-amber' : 'bg-cp-teal/20 text-cp-teal'
          }`}
          title={isAway ? 'Away from the Dojo' : 'In the Dojo'}
        >
          {isAway ? '\u{1F4F1}' : '\u{1F3EF}'}
        </button>
      </div>
    );
  }

  return (
    <div className="px-3 py-2">
      <button
        onClick={toggle}
        disabled={toggling}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl transition-all text-xs ${
          isAway
            ? 'bg-cp-amber/10 border border-cp-amber/20'
            : 'bg-cp-teal/10 border border-cp-teal/20'
        }`}
      >
        {/* Toggle switch */}
        <div className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${
          isAway ? 'bg-cp-amber/40' : 'bg-cp-teal/40'
        }`}>
          <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
            isAway ? 'translate-x-4' : 'translate-x-0.5'
          }`} />
        </div>

        <span className={`font-medium ${isAway ? 'text-cp-amber' : 'text-cp-teal'}`}>
          {isAway ? 'Away from the Dojo' : 'In the Dojo'}
        </span>
      </button>
      {isAway && (
        <p className="text-[9px] text-cp-amber/50 mt-1 px-1">
          Messages forwarded via iMessage
        </p>
      )}
    </div>
  );
};
