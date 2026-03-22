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
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return d.toLocaleDateString();
};

const getStatusInfo = (provider: ProviderStatus): { label: string; color: string; bgColor: string; borderColor: string } => {
  if (provider.healthy && provider.errorCount === 0) {
    return {
      label: 'Healthy',
      color: 'text-green-400',
      bgColor: 'bg-green-500/10',
      borderColor: 'border-green-500/30',
    };
  }
  if (provider.healthy && provider.errorCount > 0) {
    return {
      label: 'Degraded',
      color: 'text-yellow-400',
      bgColor: 'bg-yellow-500/10',
      borderColor: 'border-yellow-500/30',
    };
  }
  return {
    label: 'Down',
    color: 'text-red-400',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/30',
  };
};

export const ProviderHealth = ({ providers }: ProviderHealthProps) => {
  if (providers.length === 0) {
    return <p className="text-sm white/30">No providers configured.</p>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {providers.map((provider) => {
        const status = getStatusInfo(provider);
        return (
          <div
            key={provider.id}
            className={`border rounded-xl p-4 ${status.bgColor} ${status.borderColor}`}
          >
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium text-white">{provider.name}</h4>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${status.color} ${status.bgColor}`}>
                {status.label}
              </span>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs white/40">Last success</span>
                <span className="text-xs white/55">{formatTimestamp(provider.lastSuccess)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs white/40">Errors</span>
                <span className={`text-xs font-mono ${provider.errorCount > 0 ? 'text-red-400' : 'white/55'}`}>
                  {provider.errorCount}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
