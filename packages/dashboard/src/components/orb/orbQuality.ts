// One knob for how much the orb costs to render. The server holds the value;
// the localStorage mirror exists so mount can pick a mode before the fetch.

import * as api from '../../lib/api';
import type { OrbQuality } from './dojoOrbEngine';

export type OrbQualityPref = 'full' | 'lite' | 'static';

const SERVER_KEY = 'orb_quality';
const LS_KEY = 'dojo_orb_quality';

function coerce(v: unknown): OrbQualityPref | null {
  // Old stored values can say 'off'; that means the frozen orb.
  if (v === 'off') return 'static';
  return v === 'full' || v === 'lite' || v === 'static' ? v : null;
}

type Listener = (q: OrbQualityPref) => void;
const listeners = new Set<Listener>();

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
    /* network error: fall back to the cached value */
  }
  return getOrbQualityCached();
}

export function setOrbQuality(q: OrbQualityPref): void {
  try { localStorage.setItem(LS_KEY, q); } catch { /* ignore */ }
  api.setSetting(SERVER_KEY, q).catch(() => { /* best effort */ });
  listeners.forEach((l) => l(q));
}

export function subscribeOrbQuality(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 1:1 onto the engine flag; all three prefs are real WebGL render modes. */
export function engineQuality(pref: OrbQualityPref): OrbQuality {
  return pref;
}
