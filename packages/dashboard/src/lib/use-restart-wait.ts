// The shared "wait for the restarted server" step of Update Now and Rollback: keeps the plain
// status for the screen, reloads the page once the expected version is running, hands back the
// server's failure message (or null), and cancels the wait if the component goes away.
import { useEffect, useRef, useState } from 'react';
import { waitForRestart } from './wait-for-restart';

export function useRestartWait() {
  const [status, setStatus] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const follow = async (expectedVersion: string | null, previousVersion: string | null, kind?: 'update' | 'rollback'): Promise<string | null> => {
    const ac = new AbortController();
    abort.current = ac;
    const outcome = await waitForRestart({ expectedVersion, previousVersion, kind, signal: ac.signal, onStatus: setStatus });
    if (outcome.state === 'ready') { window.location.reload(); return null; }
    setStatus(null);
    return outcome.state === 'failed' ? outcome.message : null;
  };
  return { status, follow };
}
