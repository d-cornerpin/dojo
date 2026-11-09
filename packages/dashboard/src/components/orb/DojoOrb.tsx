import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createOrbEngine, type OrbEngine } from './dojoOrbEngine';
import { useOrbRegistration } from './OrbProvider';
import {
  getOrbQualityCached,
  refreshOrbQualityFromServer,
  subscribeOrbQuality,
  engineQuality,
  type OrbQualityPref,
} from './orbQuality';

interface DojoOrbProps {
  /* Stage that hosts the ProgressLine node and supplies the orb CSS vars. */
  stageRef?: React.RefObject<HTMLElement | null>;
  className?: string;
  /* Force a fixed quality instead of reading the per-user orb_quality setting. */
  quality?: OrbQualityPref;
}

/* Renders the WebGL canvas, the refraction backdrop <img> and the pearl fallback. */
export const DojoOrb = forwardRef<OrbEngine | null, DojoOrbProps>(function DojoOrb(
  { stageRef, className, quality },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<OrbEngine | null>(null);
  const register = useOrbRegistration();

  /* Power-saver pref: localStorage mirror now, server value once it lands. */
  const [pref, setPref] = useState<OrbQualityPref>(() => quality ?? getOrbQualityCached());
  useEffect(() => {
    // Forced quality (e.g. login) never reads the per-user setting: pre-auth
    // that fetch 401s and the 401 handler reloads /login in a loop.
    if (quality) return;
    let cancelled = false;
    void refreshOrbQualityFromServer().then((v) => { if (!cancelled) setPref(v); });
    const unsub = subscribeOrbQuality(setPref);
    return () => { cancelled = true; unsub(); };
  }, [quality]);

  useImperativeHandle<OrbEngine | null, OrbEngine | null>(ref, () => engineRef.current, []);

  /* Create the engine once. All three modes are real WebGL render modes, so
     the pearl fallback below means genuine WebGL failure, not a power choice. */
  useEffect(() => {
    const canvas = canvasRef.current;
    const bgImg = imgRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !bgImg || !wrap) return;

    const stageEl =
      stageRef?.current ??
      (wrap.closest('.dojo3-stage') as HTMLElement | null) ??
      (canvas.closest('.dojo3-stage') as HTMLElement | null);

    if (!stageEl) {
      wrap.classList.add('no-webgl');
      return;
    }

    /* Create on the real canvas; a throwaway probe context can exhaust the
       per-page WebGL limit under StrictMode's double mount and trip the pearl. */
    let engine: OrbEngine | null = null;
    try {
      engine = createOrbEngine({ canvas, bgImg, stageEl });
    } catch {
      wrap.classList.add('no-webgl');
      return;
    }
    engine.setQuality(engineQuality(getOrbQualityCached()));
    wrap.classList.remove('no-webgl');
    engineRef.current = engine;
    register(engine);

    return () => {
      engine?.destroy();
      engineRef.current = null;
      register(null);
    };
  }, [stageRef, register]);

  /* Quality changes apply live; no context recreation. */
  useEffect(() => {
    engineRef.current?.setQuality(engineQuality(pref));
  }, [pref]);

  return (
    <div ref={wrapRef} className={`dojo3-orb-glass-wrap ${className ?? ''}`.trim()}>
      <img ref={imgRef} className="dojo3-orb-bg" aria-hidden="true" alt="" />
      <canvas ref={canvasRef} className="dojo3-orb__glass orb-canvas" aria-hidden="true" />
      <div className="orb-fallback dojo3-orb-fallback" aria-hidden="true" />
    </div>
  );
});
