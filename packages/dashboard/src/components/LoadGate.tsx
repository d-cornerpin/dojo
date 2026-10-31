import type { ReactNode } from 'react';
import type { GuardedLoad } from '../lib/load-guard';

// The one "could not load, try again" state for an editor (lib/load-guard.ts). While the value is
// loading it shows the existing loading line; when the read failed it says so plainly with a Retry
// and renders NO editor, so nothing can be saved on top of a value that was never read.
export const LoadGate = <T,>({ load, what, children }: { load: GuardedLoad<T>; what: string; children: ReactNode }) => {
  if (load.status === 'loading') return <div className="tile loading-state">Loading...</div>;
  if (load.status === 'failed') {
    return (
      <div className="tile">
        <div className="fhelp" style={{ color: 'var(--cp-coral, inherit)' }}>
          Could not load {what}, so it can&apos;t be changed right now. Nothing has been changed.
        </div>
        <div className="srow" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn--sm" onClick={load.reload}>Retry</button>
        </div>
      </div>
    );
  }
  return <>{children}</>;
};
