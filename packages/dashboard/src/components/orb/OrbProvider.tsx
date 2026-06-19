import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import type {
  OrbEngine,
  OrbEmotionName,
  OrbStateName,
  OrbSystemName,
  OrbTaskName,
  OrbTaskOpts,
} from './dojoOrbEngine';

/* The stable, mount-safe API callers consume. Every method forwards to the
   live engine and no-ops if no engine is registered yet, so consumers never
   crash before the orb mounts (or after it unmounts). */
export interface DojoOrbApi {
  setState: (name: OrbStateName) => void;
  setEmotion: (name: OrbEmotionName | null | 'none') => void;
  setSystem: (name: OrbSystemName | null | 'none' | 'wake') => void;
  pulse: () => void;
  startTask: (name: OrbTaskName, opts?: OrbTaskOpts) => void;
  updateTask: (progress: number) => void;
  endTask: (name?: OrbTaskName) => void;
  /** Re-run the orb's layout (e.g. after the stage width changes). */
  resize: () => void;
  /** Tint the orb toward an agent's hue (degrees 0..360; null = champagne). */
  setHue: (deg: number | null) => void;
  /** Drive the orb's pulse from a live audio level (0..1); null = simulated. */
  setEnv: (level: number | null) => void;
  /** Held alert tint: 0 none, 0.5 warning (amber), 1 error (red). */
  setAlert: (level: number) => void;
  /** Static glyph inside the glass for a notification ('alert' | 'check'), or null. */
  setNoteGlyph: (name: string | null) => void;
}

interface OrbContextValue {
  dojoOrb: DojoOrbApi;
  /* DojoOrb registers its engine on mount, and null on unmount. */
  _registerEngine: (engine: OrbEngine | null) => void;
}

const OrbContext = createContext<OrbContextValue | null>(null);

export function OrbProvider({ children }: { children: ReactNode }) {
  const engineRef = useRef<OrbEngine | null>(null);

  const _registerEngine = useCallback((engine: OrbEngine | null) => {
    engineRef.current = engine;
  }, []);

  /* a stable proxy: identity never changes, calls dispatch to the live engine */
  const dojoOrb = useMemo<DojoOrbApi>(
    () => ({
      setState: (name) => engineRef.current?.setState(name),
      setEmotion: (name) => engineRef.current?.setEmotion(name),
      setSystem: (name) => engineRef.current?.setSystem(name),
      pulse: () => engineRef.current?.pulse(),
      startTask: (name, opts) => engineRef.current?.startTask(name, opts),
      updateTask: (progress) => engineRef.current?.updateTask(progress),
      endTask: (name) => engineRef.current?.endTask(name),
      resize: () => engineRef.current?.resize(),
      setHue: (deg) => engineRef.current?.setHue(deg),
      setEnv: (level) => engineRef.current?.setEnv(level),
      setAlert: (level) => engineRef.current?.setAlert(level),
      setNoteGlyph: (name) => engineRef.current?.setNoteGlyph(name),
    }),
    [],
  );

  const value = useMemo<OrbContextValue>(
    () => ({ dojoOrb, _registerEngine }),
    [dojoOrb, _registerEngine],
  );

  return <OrbContext.Provider value={value}>{children}</OrbContext.Provider>;
}

/* internal: DojoOrb uses this to register/unregister its engine */
export function useOrbRegistration(): (engine: OrbEngine | null) => void {
  const ctx = useContext(OrbContext);
  return ctx?._registerEngine ?? (() => {});
}

/* public: stable proxy that forwards to the live engine (no-op if unmounted) */
export function useDojoOrb(): DojoOrbApi {
  const ctx = useContext(OrbContext);
  if (ctx) return ctx.dojoOrb;
  /* outside a provider: a safe no-op proxy so callers never crash */
  return NOOP_ORB;
}

const NOOP_ORB: DojoOrbApi = {
  setState: () => {},
  setEmotion: () => {},
  setSystem: () => {},
  pulse: () => {},
  startTask: () => {},
  updateTask: () => {},
  endTask: () => {},
  resize: () => {},
  setHue: () => {},
  setEnv: () => {},
  setAlert: () => {},
  setNoteGlyph: () => {},
};
