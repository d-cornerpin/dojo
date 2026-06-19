import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createOrbEngine, type OrbEngine } from './dojoOrbEngine';
import { useOrbRegistration } from './OrbProvider';

interface DojoOrbProps {
  /* Optional explicit stage element to host the ProgressLine DOM node and
     supply the orb CSS vars. If omitted, we walk up from the canvas to the
     nearest .dojo3-stage ancestor. */
  stageRef?: React.RefObject<HTMLElement | null>;
  className?: string;
}

/* DojoOrb renders the WebGL canvas, the refraction backdrop <img>, and a
   pearl fallback for the no-WebGL case. It owns the engine lifecycle and
   forwards the engine API upward through the ref. */
export const DojoOrb = forwardRef<OrbEngine | null, DojoOrbProps>(function DojoOrb(
  { stageRef, className },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<OrbEngine | null>(null);
  const register = useOrbRegistration();

  useImperativeHandle<OrbEngine | null, OrbEngine | null>(ref, () => engineRef.current, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const bgImg = imgRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !bgImg || !wrap) return;

    /* resolve the stage: explicit prop wins, else nearest .dojo3-stage */
    const stageEl =
      stageRef?.current ??
      (wrap.closest('.dojo3-stage') as HTMLElement | null) ??
      (canvas.closest('.dojo3-stage') as HTMLElement | null);

    if (!stageEl) {
      wrap.classList.add('no-webgl');
      return;
    }

    /* Create the engine directly on the real canvas. If WebGL is genuinely
       unavailable the engine throws; we catch and show the pearl fallback.
       We do NOT pre-probe with a throwaway context: that extra context can
       exhaust the per-page WebGL limit under StrictMode's double mount and
       wrongly trip the fallback. */
    let engine: OrbEngine | null = null;
    try {
      engine = createOrbEngine({ canvas, bgImg, stageEl });
    } catch {
      wrap.classList.add('no-webgl');
      return;
    }
    wrap.classList.remove('no-webgl');
    engineRef.current = engine;
    register(engine);

    return () => {
      engine?.destroy();
      engineRef.current = null;
      register(null);
    };
  }, [stageRef, register]);

  return (
    <div ref={wrapRef} className={`dojo3-orb-glass-wrap ${className ?? ''}`.trim()}>
      <img ref={imgRef} className="dojo3-orb-bg" aria-hidden="true" alt="" />
      <canvas ref={canvasRef} className="dojo3-orb__glass orb-canvas" aria-hidden="true" />
      <div className="orb-fallback dojo3-orb-fallback" aria-hidden="true" />
    </div>
  );
});
