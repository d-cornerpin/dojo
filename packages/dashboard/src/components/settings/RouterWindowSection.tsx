// ── Settings → The Router tab: the one window every automatic pick runs at (v3.5 N42, GitHub #25).
//
// The owner's design: ONE slider for the whole router. Its top is the smallest window among the
// router's light, standard and heavy models (the server measures it: `router/router-window.ts`), so
// every model the router picks runs at the same window and a switch between tiers never shrinks what
// an agent remembers. Its low end is measured too: below it, the named automatic agent's instructions
// and tools alone would not fit. Saved on release through the existing settings door, like the voice
// sliders (`VoiceTab.tsx`).

import { useEffect, useState } from 'react';
import * as api from '../../lib/api';

export interface RouterWindowData {
  tokens: number;
  floorTokens: number;
  floorModelName: string;
  minTokens: number;
  minAgentName: string | null;
  /** Agents whose measurement failed on the server (left out of the low end). */
  unmeasuredAgentNames?: string[];
}

const k = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

export const RouterWindowSection = ({ routerWindow }: { routerWindow: RouterWindowData | null }) => {
  const [value, setValue] = useState(routerWindow?.tokens ?? 0);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setValue(routerWindow?.tokens ?? 0); }, [routerWindow?.tokens]);

  const save = async (): Promise<void> => {
    setError(null); setSaved(false);
    const res = await api.setSetting('router.context_window', String(value));
    if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
    else { setError(res.error); setValue(routerWindow?.tokens ?? 0); }
  };

  return (
    <div className="tile space-y-3">
      <h3 className="scard__title">Context window for automatic choice</h3>
      {routerWindow === null ? (
        <p className="text-xs text-ui/40">No models are on the light, standard or heavy tier yet, so there is no window to set. Add a model to a tier below.</p>
      ) : (
        <>
          <p className="text-xs text-ui/40">
            Every model the router picks runs at this one window, so moving between light, standard and heavy never
            shrinks what an agent remembers. It can go no higher than the smallest model on the router.
          </p>
          <div className="flex items-center gap-3">
            <input
              type="range"
              aria-label="Context window for automatic choice"
              min={Math.min(routerWindow.minTokens, routerWindow.floorTokens)} max={routerWindow.floorTokens}
              value={value}
              onChange={(e) => { setValue(Number(e.target.value)); setError(null); }}
              onMouseUp={() => void save()}
              onTouchEnd={() => void save()}
              onKeyUp={() => void save()}
              className="flex-1 accent-cp-teal"
            />
            {saved && <span className="text-xs text-cp-teal">Saved!</span>}
          </div>
          {error && <p className="text-xs text-cp-coral">{error}</p>}
          <p className="text-sm font-mono text-ui">{k(value)} — the smallest model on the router is {routerWindow.floorModelName} ({k(routerWindow.floorTokens)})</p>
          {routerWindow.minAgentName && routerWindow.minTokens > routerWindow.floorTokens && (
            <p className="text-xs text-cp-coral">
              {routerWindow.minAgentName} needs more room than {routerWindow.floorModelName} has; it cannot run on automatic until that model is raised or taken off the router.
            </p>
          )}
          {routerWindow.minAgentName && routerWindow.minTokens <= routerWindow.floorTokens && (
            <p className="text-xs text-ui/40">
              The lowest setting, {k(routerWindow.minTokens)}, is the least {routerWindow.minAgentName} can run in: its instructions, its tools and room to answer.
            </p>
          )}
          {(routerWindow.unmeasuredAgentNames ?? []).length > 0 && (
            <p className="text-xs text-ui/40">
              Could not measure {(routerWindow.unmeasuredAgentNames ?? []).join(', ')}; the lowest setting leaves {(routerWindow.unmeasuredAgentNames ?? []).length === 1 ? 'it' : 'them'} out.
            </p>
          )}
        </>
      )}
    </div>
  );
};
