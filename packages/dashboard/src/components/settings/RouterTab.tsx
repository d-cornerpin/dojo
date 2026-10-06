// ── Settings → The Router tab: tier models, dimensions and the live router test.
//
// Lifted OUT of `pages/Settings.tsx` by t111-E1. The moved lines are VERBATIM; the only new
// bytes are this header, the imports below and the `export` keyword(s).

import { useState, useEffect } from 'react';
import * as api from '../../lib/api';
import { RouterConfig } from '../RouterConfig';
import { RouterTest } from '../RouterTest';


// ── Router Tab ──

interface RouterConfigData {
  tiers: Array<{
    id: string;
    name: string;
    description: string;
    models: Array<{ modelId: string; modelName: string; providerName?: string; priority: number }>;
  }>;
  dimensions: Array<{
    id: string;
    name: string;
    weight: number;
    isEnabled: boolean;
  }>;
}

export const RouterTab = () => {
  const [config, setConfig] = useState<RouterConfigData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadConfig = async () => {
    const result = await api.getRouterConfig();
    if (result.ok) {
      // Map displayName -> name for frontend components
      const data = result.data as Record<string, unknown>;
      const tiers = (data.tiers as Array<Record<string, unknown>>).map((t) => ({
        id: t.id as string,
        name: (t.displayName ?? t.name) as string,
        description: (t.description ?? '') as string,
        models: (t.models ?? []) as Array<{ modelId: string; modelName: string; providerName?: string; priority: number }>,
      }));
      const dimensions = (data.dimensions as Array<Record<string, unknown>>).map((d) => ({
        id: d.id as string,
        name: (d.displayName ?? d.name) as string,
        weight: d.weight as number,
        isEnabled: d.isEnabled as boolean,
      }));
      setConfig({ tiers, dimensions });
    }
    setLoading(false);
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const handleUpdateTierModels = async (
    tierId: string,
    models: Array<{ modelId: string; priority: number }>,
  ) => {
    await api.updateTierModels(tierId, models);
    await loadConfig();
  };

  const handleUpdateDimension = async (
    dimensionId: string,
    updates: { weight?: number; isEnabled?: boolean },
  ) => {
    await api.updateDimension(dimensionId, updates);
    await loadConfig();
  };

  const handleTest = async (prompt: string) => {
    const result = await api.testRouter(prompt);
    if (result.ok) return result.data;
    return null;
  };

  if (loading) return <div className="loading-state">Loading...</div>;
  if (!config) return <p className="text-ui/40">Unable to load router config.</p>;

  return (
    <div className="space-y-6 max-w-4xl">
      <RouterConfig
        config={config}
        onUpdateTierModels={handleUpdateTierModels}
        onUpdateDimension={handleUpdateDimension}
      />
      <RouterTest onTest={handleTest} />
    </div>
  );
};
