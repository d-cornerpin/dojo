import type * as api from '../lib/api';

// The signed-out / login-expired part of the Plaud card (moved out of PlaudSettings.tsx unchanged).
export const PlaudDisconnectedPanel = ({ status, onConnect }: { status: api.PlaudStatus; onConnect: () => void }) => (
    <>
      {status.reauthRequired && (
        <div className="alert-banner alert-warning text-xs">
          <p className="font-medium mb-1">
            Your Plaud login has expired{status.email ? ` (${status.email})` : ''}.
          </p>
          <p className="text-ui/55">
            Your agents can&apos;t reach your recordings until you reconnect. Nothing else is
            affected.
          </p>
        </div>
      )}
      <button
        onClick={onConnect}
        className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
      >
        {status.reauthRequired ? 'Reconnect Plaud' : 'Connect Plaud'}
      </button>
      <p className="text-xs text-ui/55">
        Signing in happens <span className="font-medium">on the Mac that runs Dojo</span> — a
        browser window opens there, and the sign-in has to be completed on that machine. If
        you&apos;re reading this from your phone or another computer, use the link that appears
        below once you click, or go over to the Mac.
      </p>
      <p className="text-[11px] text-ui/40">
        No Plaud account?{' '}
        <a
          href="https://www.plaud.ai/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-cp-teal hover:text-cp-teal/80 underline"
        >
          Sign up at plaud.ai ↗
        </a>
      </p>
    </>
);
