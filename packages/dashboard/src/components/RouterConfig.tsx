import { useState, useEffect } from 'react';
import * as api from '../lib/api';

interface TierModel {
  modelId: string;
  modelName: string;
  providerName?: string;
  priority: number;
}

interface Tier {
  id: string;
  name: string;
  description: string;
  models: TierModel[];
}

interface Dimension {
  id: string;
  name: string;
  weight: number;
  isEnabled: boolean;
}

interface RouterConfigData {
  tiers: Tier[];
  dimensions: Dimension[];
}

interface AvailableModel {
  id: string;
  name: string;
  api_model_id: string;
  provider_name: string;
  provider_type: string;
}

interface RouterConfigProps {
  config: RouterConfigData;
  onUpdateTierModels: (tierId: string, models: Array<{ modelId: string; priority: number }>) => Promise<void>;
  onUpdateDimension: (dimensionId: string, updates: { weight?: number; isEnabled?: boolean }) => Promise<void>;
}

export const RouterConfig = ({ config, onUpdateTierModels, onUpdateDimension }: RouterConfigProps) => {
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);

  const loadAvailableModels = async () => {
    const result = await api.getAvailableRouterModels();
    if (result.ok) {
      setAvailableModels(result.data);
    }
  };

  useEffect(() => {
    loadAvailableModels();
  }, []);

  const handleTierUpdate = async (tierId: string, models: Array<{ modelId: string; priority: number }>) => {
    await onUpdateTierModels(tierId, models);
    // Refresh available models since assignment changed
    await loadAvailableModels();
  };

  return (
    <div className="space-y-6">
      {/* Tier panels */}
      <div>
        <h3 className="card-header mb-3">Tier Configuration</h3>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* The 'system' tier is not router-related (it runs the classifier +
              watchdog); its model picker lives in Settings -> Dojo instead. */}
          {config.tiers.filter((tier) => tier.id !== 'system').map((tier) => (
            <TierPanel
              key={tier.id}
              tier={tier}
              availableModels={availableModels}
              onUpdate={(models) => handleTierUpdate(tier.id, models)}
            />
          ))}
        </div>
      </div>

      {/* Dimension weights */}
      <div>
        <h3 className="card-header mb-3">Dimension Weights</h3>
        <div className="glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ui/40 text-xs uppercase tracking-wider border-b border-ui/[0.06]">
                <th className="px-4 py-3">Dimension</th>
                <th className="px-4 py-3 w-32">Weight</th>
                <th className="px-4 py-3 w-24 text-center">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {config.dimensions.map((dim) => (
                <DimensionRow
                  key={dim.id}
                  dimension={dim}
                  onUpdate={(updates) => onUpdateDimension(dim.id, updates)}
                />
              ))}
              {config.dimensions.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-ui/25 text-sm">
                    No dimensions configured
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const TierPanel = ({
  tier,
  availableModels,
  onUpdate,
  bare = false,
}: {
  tier: Tier;
  availableModels: AvailableModel[];
  onUpdate: (models: Array<{ modelId: string; priority: number }>) => Promise<void>;
  /** Render only the model list + add control, no card wrapper or title (the
      host card supplies those). Used by the System Model card in the Dojo tab. */
  bare?: boolean;
}) => {
  const [saving, setSaving] = useState(false);
  const [showAddDropdown, setShowAddDropdown] = useState(false);

  const sortedModels = [...tier.models].sort((a, b) => a.priority - b.priority);

  // The 'system' tier is local-only: its model runs the multi-step classifier
  // and the watchdog's smart alerts, and the watchdog must keep working with no
  // network/cloud. So only offer local (Ollama) models there. Enforced server-
  // side too — this is just to keep cloud models out of the picker.
  const isSystemTier = tier.id === 'system';
  const selectableModels = availableModels
    .filter((m) => !tier.models.some((tm: { modelId: string }) => tm.modelId === m.id))
    .filter((m) => !isSystemTier || m.provider_type === 'ollama');

  const handleMoveUp = async (index: number) => {
    if (index === 0) return;
    const models = [...sortedModels];
    [models[index - 1], models[index]] = [models[index], models[index - 1]];
    const updated = models.map((m, i) => ({ modelId: m.modelId, priority: i }));
    setSaving(true);
    await onUpdate(updated);
    setSaving(false);
  };

  const handleMoveDown = async (index: number) => {
    if (index === sortedModels.length - 1) return;
    const models = [...sortedModels];
    [models[index], models[index + 1]] = [models[index + 1], models[index]];
    const updated = models.map((m, i) => ({ modelId: m.modelId, priority: i }));
    setSaving(true);
    await onUpdate(updated);
    setSaving(false);
  };

  const handleRemove = async (index: number) => {
    const models = sortedModels.filter((_, i) => i !== index);
    const updated = models.map((m, i) => ({ modelId: m.modelId, priority: i }));
    setSaving(true);
    await onUpdate(updated);
    setSaving(false);
  };

  const handleAdd = async (modelId: string) => {
    const newPriority = sortedModels.length;
    const updated = [
      ...sortedModels.map((m, i) => ({ modelId: m.modelId, priority: i })),
      { modelId, priority: newPriority },
    ];
    setSaving(true);
    setShowAddDropdown(false);
    await onUpdate(updated);
    setSaving(false);
  };

  const tierColors: Record<string, string> = {
    tier1: 'border-cp-purple/30',
    tier2: 'border-cp-blue/30',
    tier3: 'border-cp-teal/30',
  };

  const inner = (
    <>
      {sortedModels.length === 0 ? (
        <p className="text-xs text-ui/25 mb-3">No models assigned</p>
      ) : (
        <div className="space-y-1 mb-3">
          {sortedModels.map((model, index) => (
            <div
              key={model.modelId}
              className="flex items-center gap-2 py-1.5 px-2 text-ui/25 rounded"
            >
              <span className="text-xs text-ui/40 w-4 text-center font-mono">
                {index + 1}
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-xs text-ui/70 truncate block">
                  {model.modelName}
                  {model.providerName && (
                    <span className="text-ui/40"> ({model.providerName})</span>
                  )}
                </span>
              </div>
              <button
                onClick={() => handleMoveUp(index)}
                disabled={index === 0 || saving}
                className="text-ui/40 hover:text-ui/70 disabled:text-gray-700 text-xs px-1"
                title="Move up"
              >
                &#9650;
              </button>
              <button
                onClick={() => handleMoveDown(index)}
                disabled={index === sortedModels.length - 1 || saving}
                className="text-ui/40 hover:text-ui/70 disabled:text-gray-700 text-xs px-1"
                title="Move down"
              >
                &#9660;
              </button>
              <button
                onClick={() => handleRemove(index)}
                disabled={saving}
                className="text-ui/40 hover:text-cp-coral disabled:text-ui/25 text-xs px-1"
                title="Remove from tier"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add Model */}
      {showAddDropdown ? (
        <div className="space-y-1">
          {selectableModels.length === 0 ? (
            <p className="text-xs text-ui/25">
              {isSystemTier
                ? 'No local (Ollama) models available. The System tier accepts local models only — add one in the Models tab.'
                : 'No available models. Enable models in the Models tab first.'}
            </p>
          ) : (
            <select
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) handleAdd(e.target.value);
              }}
              disabled={saving}
              className="glass-select w-full"
            >
              <option value="" disabled>Select a model...</option>
              {selectableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.provider_name})
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => setShowAddDropdown(false)}
            className="text-xs text-ui/40 hover:text-ui/70 transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowAddDropdown(true)}
          disabled={saving}
          className="flex items-center gap-1 text-xs text-cp-blue hover:text-cp-blue-light disabled:text-ui/25 transition-colors"
        >
          <span className="text-lg leading-none">+</span> Add Model
        </button>
      )}
    </>
  );

  if (bare) return inner;
  return (
    <div className={`glass-card rounded-xl p-4 ${tierColors[tier.id] || 'text-ui/25'}`}>
      <div className="mb-3">
        <h4 className="text-sm font-medium text-ui">{tier.name}</h4>
        <p className="text-xs text-ui/40 mt-0.5">{tier.description}</p>
      </div>
      {inner}
    </div>
  );
};

const DimensionRow = ({
  dimension,
  onUpdate,
}: {
  dimension: Dimension;
  onUpdate: (updates: { weight?: number; isEnabled?: boolean }) => Promise<void>;
}) => {
  const [weight, setWeight] = useState(dimension.weight.toString());
  const [saving, setSaving] = useState(false);

  const handleWeightSave = async () => {
    const val = parseFloat(weight);
    if (isNaN(val) || val < 0 || val > 1) return;
    setSaving(true);
    await onUpdate({ weight: val });
    setSaving(false);
  };

  const handleToggle = async () => {
    setSaving(true);
    await onUpdate({ isEnabled: !dimension.isEnabled });
    setSaving(false);
  };

  return (
    <tr className="border-t border-ui/[0.06]">
      <td className="px-4 py-2.5">
        <span className={`text-sm ${dimension.isEnabled ? 'text-ui/70' : 'text-ui/25'}`}>
          {dimension.name}
        </span>
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-1">
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            onBlur={handleWeightSave}
            disabled={!dimension.isEnabled || saving}
            className="glass-input w-16 disabled:text-ui/25"
          />
        </div>
      </td>
      <td className="px-4 py-2.5 text-center">
        <button
          onClick={handleToggle}
          disabled={saving}
          className={`toggle-switch ${dimension.isEnabled ? 'toggle-on' : ''}`}
        >
          <span className="toggle-knob" />
        </button>
      </td>
    </tr>
  );
};

// ── System Model (relocated from the Router tab to Settings -> Dojo) ──
// The 'system' tier is not router-related: its (local-only) model runs the
// multi-step classifier and the watchdog's smart alerts. Self-contained: loads
// the router config + available models itself and saves via updateTierModels.
export const SystemModelConfig = () => {
  const [tier, setTier] = useState<Tier | null>(null);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const [cfgRes, modelsRes] = await Promise.all([
      api.getRouterConfig(),
      api.getAvailableRouterModels(),
    ]);
    if (cfgRes.ok) {
      const data = cfgRes.data as Record<string, unknown>;
      const raw = (data.tiers as Array<Record<string, unknown>>).find((t) => t.id === 'system');
      setTier(
        raw
          ? {
              id: raw.id as string,
              name: (raw.displayName ?? raw.name) as string,
              description: (raw.description ?? '') as string,
              models: (raw.models ?? []) as TierModel[],
            }
          : null,
      );
    }
    if (modelsRes.ok) setAvailableModels(modelsRes.data);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUpdate = async (models: Array<{ modelId: string; priority: number }>) => {
    await api.updateTierModels('system', models);
    await load();
  };

  if (loading) return <div className="tile loading-state">Loading...</div>;
  if (!tier) return null;

  return (
    <div className="tile">
      <div className="scard__title">System Model</div>
      <div className="scard__desc">
        The local model that runs the multi-step classifier and the watchdog's smart alerts.
        Local-only (Ollama) so it keeps working with no network. This is a system function, not
        part of the model router.
      </div>
      <TierPanel tier={tier} availableModels={availableModels} onUpdate={handleUpdate} bare />
    </div>
  );
};
