// ════════════════════════════════════════
// Orb quality preference (power saver)
// ════════════════════════════════════════
//
// A single user-facing knob for how much the orb costs to render:
//   'full'   — the rich glass look (default)
//   'lite'   — lower idle frame rate + skip the expensive outer atmosphere
//              effects (flare / caustics / reflection). Easy on weak / integrated
//              GPUs (e.g. a Surface) without losing the orb.
//   'static' — the FULL orb look, frozen: no ambient motion, idles at ~1fps.
//              Looks identical to the live orb, costs almost nothing. (The grey
//              CSS pearl only appears now if WebGL is genuinely unavailable.)
//
// Persisted server-side via the generic settings endpoint (so it follows the
// dojo), and mirrored to localStorage for a synchronous read at mount (so we
// can decide create-vs-fallback before the async fetch resolves — no flash).

import * as api from '../../lib/api';
import type { OrbQuality } from './dojoOrbEngine';

export type OrbQualityPref = 'full' | 'lite' | 'static';

const SERVER_KEY = 'orb_quality';
const LS_KEY = 'dojo_orb_quality';

function coerce(v: unknown): OrbQualityPref | null {
  // Back-compat: an earlier build stored 'off' for the no-WebGL pearl; it now
  // maps to the frozen full orb.
  if (v === 'off') return 'static';
  return v === 'full' || v === 'lite' || v === 'static' ? v : null;
}

type Listener = (q: OrbQualityPref) => void;
const listeners = new Set<Listener>();

/** Synchronous best-guess from localStorage (defaults to 'full'). */
export function getOrbQualityCached(): OrbQualityPref {
  try {
    return coerce(localStorage.getItem(LS_KEY)) ?? 'full';
  } catch {
    return 'full';
  }
}

/** Authoritative value from the server; updates the localStorage mirror. */
export async function refreshOrbQualityFromServer(): Promise<OrbQualityPref> {
  try {
    const r = await api.getSetting(SERVER_KEY);
    if (r.ok) {
      const v = coerce(r.data.value);
      if (v) {
        try { localStorage.setItem(LS_KEY, v); } catch { /* ignore */ }
        return v;
      }
    }
  } catch {
    /* network error — fall back to the cached value */
  }
  return getOrbQualityCached();
}

/** Persist a new preference and notify any mounted orbs to apply it live. */
export function setOrbQuality(q: OrbQualityPref): void {
  try { localStorage.setItem(LS_KEY, q); } catch { /* ignore */ }
  api.setSetting(SERVER_KEY, q).catch(() => { /* best effort */ });
  listeners.forEach((l) => l(q));
}

export function subscribeOrbQuality(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The preference maps 1:1 onto the engine's quality flag (all three are real
 *  WebGL render modes now). */
export function engineQuality(pref: OrbQualityPref): OrbQuality {
  return pref;
}
