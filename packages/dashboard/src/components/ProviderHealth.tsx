// Provider health cards, rebuilt onto the dojo3 panel primitives
// (.cards / .tile.tile--ok / .tile.tile--down + .tech__head + .rows).
// Healthy and degraded providers render as .tile--ok with an OK pill;
// down providers render as .tile--down with a Down pill. The error
// count and last-success timestamp carry through unchanged.

import { parseUtc } from '../lib/dates';

interface ProviderStatus {
  id: string;
  name: string;
  healthy: boolean;
  lastSuccess: string | null;
  errorCount: number;
}

interface ProviderHealthProps {
  providers: ProviderStatus[];
}

const formatTimestamp = (ts: string | null): string => {
  if (!ts) return 'Never';
  const d = parseUtc(ts);
  if (!d) return 'Never';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return d.toLocaleDateString();
};

const getStatusInfo = (provider: ProviderStatus): { label: string; down: boolean } => {
  if (provider.healthy && provider.errorCount === 0) return { label: 'Healthy', down: false };
  if (provider.healthy && provider.errorCount > 0) return { label: 'Degraded', down: false };
  return { label: 'Down', down: true };
};

export const ProviderHealth = ({ providers }: ProviderHealthProps) => {
  if (providers.length === 0) {
    return <div className="stub"><p className="stub__line">No providers configured.</p></div>;
  }

  return (
    <div className="cards" style={{ marginTop: 14 }}>
      {providers.map((provider, i) => {
        const status = getStatusInfo(provider);
        return (
          <article
            key={provider.id}
            className={`tile ${status.down ? 'tile--down' : 'tile--ok'} anim`}
            style={{ ['--ci' as string]: `${120 + i * 30}ms` }}
          >
            <div className="tech__head">
              <div className="tech__title">{provider.name}</div>
              <span className={`pill ${status.down ? 'pill--down' : 'pill--ok'}`}>
                <i className="dot" />
                {status.label}
              </span>
            </div>
            <div className="rows">
              <div>
                <span className="k">Last success</span>
                <span className="v">{formatTimestamp(provider.lastSuccess)}</span>
              </div>
              <div>
                <span className="k">Errors</span>
                <span className="v">{provider.errorCount}</span>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
};
