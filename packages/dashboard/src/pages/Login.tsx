import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import * as api from '../lib/api';
import { OrbProvider, useDojoOrb } from '../components/orb/OrbProvider';
import { DojoOrb } from '../components/orb/DojoOrb';
import type { OrbEmotionName } from '../components/orb/dojoOrbEngine';

/* Expressive, transient moods the idle orb drifts through while it waits at
   the gate (each eases back to rest after a few seconds). */
const IDLE_MOODS: OrbEmotionName[] = [
  'calm', 'curious', 'excited', 'joyous', 'mad', 'sympathetic', 'confused', 'success', 'sheepish',
];

/* The login gate: the living orb bobs excitedly above a single password
   field, with a clean "DOJO" label that matches the in-app wordmark. The orb
   needs the OrbProvider proxy to drive its emotion, and Login renders outside
   the authenticated chrome, so it brings its own provider. */
export const Login = () => (
  <OrbProvider>
    <LoginStage />
  </OrbProvider>
);

function LoginStage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null);
  const { login } = useAuth();
  const navigate = useNavigate();
  const dojoOrb = useDojoOrb();
  const stageRef = useRef<HTMLDivElement>(null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const check = async () => {
      const result = await api.getSetupStatus();
      setIsFirstRun(result.ok ? result.data.isFirstRun : false);
    };
    check();
  }, []);

  /* Re-run the orb layout once after mount. The engine reads --dojo3-orb-top /
     --dojo3-orb-size at create time, but those custom props can still resolve
     to their fallback on the first synchronous read (notably on WebKit), which
     parks the orb at the top of the stage. A post-paint resize() re-reads them
     once settled, so the orb lands above the form on every engine. */
  useEffect(() => {
    const id = requestAnimationFrame(() => dojoOrb.resize());
    return () => cancelAnimationFrame(id);
  }, [dojoOrb]);

  /* Orb life at the gate: it greets you excited, then ~5s in it calms down and
     idly drifts through a random mood every 15s (calm, curious, mad, joyous,
     and so on). The "settled" flag eases the bob too.

     The engine only blends ONE emotion at a time, starting from zero, so
     setting a new emotion over one that's still at full weight hard-cuts. To
     transition smoothly we RELEASE the current emotion first (it eases back to
     rest), then ease the next one in. */
  useEffect(() => {
    const timers = new Set<number>();
    const after = (ms: number, fn: () => void) => {
      const id = window.setTimeout(() => { timers.delete(id); fn(); }, ms);
      timers.add(id);
      return id;
    };

    dojoOrb.setEmotion('excited');

    let last: OrbEmotionName = 'excited';
    const pickMood = (): OrbEmotionName => {
      let next = last;
      while (next === last) next = IDLE_MOODS[Math.floor(Math.random() * IDLE_MOODS.length)];
      last = next;
      return next;
    };
    /* release whatever's showing (eases to rest), then ease the next mood in */
    const transitionTo = (name: OrbEmotionName) => {
      dojoOrb.setEmotion(null);
      after(620, () => dojoOrb.setEmotion(name));
      last = name;
    };

    let drift: number | undefined;
    after(5000, () => {
      setSettled(true);
      transitionTo('calm');
      drift = window.setInterval(() => transitionTo(pickMood()), 15000);
    });

    return () => {
      for (const id of timers) window.clearTimeout(id);
      if (drift) window.clearInterval(drift);
    };
  }, [dojoOrb]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;

    setIsSubmitting(true);
    setError(null);

    const loginError = await login(password);
    if (loginError) {
      setError(loginError);
      setIsSubmitting(false);
      dojoOrb.setEmotion('mad');
      return;
    }

    const setupResult = await api.getSetupStatus();
    navigate(setupResult.ok && setupResult.data.isFirstRun ? '/setup' : '/');
  };

  return (
    <div ref={stageRef} className={`dojo3-stage dojo3-login ${settled ? 'is-settled' : ''}`}>
      <div className="dojo3-stage__main">
        <div className="dojo3-backdrop" aria-hidden="true" />
        {/* Force the full/heavy orb and skip the per-user orb_quality fetch:
            pre-auth that authed fetch 401s → /login reload loop. */}
        <DojoOrb stageRef={stageRef} quality="full" />

        <div className="dojo3-login__center">
          <span className="dojo3-login__wordmark">DOJO</span>
          <form onSubmit={handleSubmit} className="dojo3-login__card">
            <div className="dojo3-login__group">
              <label className="dojo3-login__label" htmlFor="password">
                {isFirstRun ? 'Create Password' : 'Password'}
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-label={isFirstRun ? 'Create a password' : 'Password'}
                autoFocus
                autoComplete={isFirstRun ? 'new-password' : 'current-password'}
                className="dojo3-login__input"
              />
            </div>
            {error && (
              <p className="dojo3-login__error" role="alert">{error}</p>
            )}
            <button
              type="submit"
              disabled={isSubmitting || !password.trim()}
              className="btn btn--primary dojo3-login__submit"
            >
              {isSubmitting ? 'Signing in…' : isFirstRun ? 'Set Password' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
