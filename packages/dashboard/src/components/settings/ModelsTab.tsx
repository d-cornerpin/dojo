// ── Settings → The Models tab: the browse/add flows and the per-provider model list.

import { useState, useEffect, useRef } from 'react';
import type { Provider, Model } from '@dojo/shared';
import * as api from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { parseUtc } from '../../lib/dates';
import { formatCost } from '../../lib/model-cost';
import { isEnterNotComposing } from '../../lib/enter-key';
import { ProviderModelGroup } from './ModelRows';
import {
  FallbackVisionModelCard, ImageGenModelCard, VideoGenModelCard, AudioGenModelCard,
  MusicGenModelCard, TranscriptionModelCard,
} from './CapabilityModelCards';
import { ModalShell } from '../ModalShell';
import { AgentModelOption } from '../AgentModelOption';
import { isListedAgentModel } from '../../lib/role-models';


export const BrowseModels = ({ providerId, providerName, onModelAdded }: { providerId: string; providerName: string; onModelAdded: () => void }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<api.BrowseModelResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // The model the user clicked "Add" on; drives the pricing modal. Adding
  // is confirmed from inside the modal so the user can pull/enter a price.
  const [pricingModalModel, setPricingModalModel] = useState<api.BrowseModelResult | null>(null);
  const latestSearch = useRef(0);
  const inFlightQuery = useRef('');

  const handleSearch = async () => {
    // Same words already on their way: ignore Enter. Different words: the newer search takes over.
    if (!query.trim() || (searching && inFlightQuery.current === query.trim())) return;
    inFlightQuery.current = query.trim();
    const mine = ++latestSearch.current;
    setSearching(true);
    setSearched(true);
    setSearchError(null);
    try {
      const result = await api.browseProviderModels(providerId, query.trim());
      if (mine !== latestSearch.current) return;
      if (result.ok) setResults(result.data);
      else setSearchError(result.error ?? 'The search did not work.');
    } finally {
      if (mine === latestSearch.current) setSearching(false);
    }
  };

  const handleAdded = (apiModelId: string) => {
    setResults(prev => prev.filter(r => r.apiModelId !== apiModelId));
    setPricingModalModel(null);
    onModelAdded();
  };

  return (
    <div className="tile space-y-3">
      <h3 className="scard__title">Browse {providerName} Models</h3>
      <p className="text-xs text-ui/40">Search the model catalog and add models you want to use.</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => isEnterNotComposing(e) && handleSearch()}
          placeholder="Search models... (e.g., claude, llama, gpt)"
          className="glass-input flex-1"
        />
        <button
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors shrink-0"
        >
          {searching ? 'Searching...' : 'Search'}
        </button>
      </div>

      {searchError && <p className="text-xs text-cp-coral">{searchError}</p>}

      {results.length > 0 && (
        <div className="space-y-1.5 max-h-[400px] overflow-y-auto">
          {results.map((model) => (
            <div key={model.apiModelId} className="flex items-center justify-between glass-nested p-2.5 rounded-lg">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ui/90 truncate">{model.name}</div>
                <div className="text-[10px] text-ui/40 flex items-center gap-2 mt-0.5">
                  <span className="truncate">{model.apiModelId}</span>
                  {model.contextWindow && <span>{(model.contextWindow / 1000).toFixed(0)}k ctx</span>}
                  {model.maxOutputTokens && <span>{(model.maxOutputTokens / 1000).toFixed(0)}k out</span>}
                  {model.priceAvailable === false ? (
                    <span className="text-cp-coral font-medium">No price from API (set on add)</span>
                  ) : (
                    <>
                      <span>In: {formatCost(model.inputCostPerM)}/M</span>
                      <span>Out: {formatCost(model.outputCostPerM)}/M</span>
                    </>
                  )}
                </div>
              </div>
              <button
                onClick={() => setPricingModalModel(model)}
                className="ml-2 px-3 py-1 text-xs bg-cp-teal/20 text-cp-teal hover:bg-cp-teal/30 rounded-lg transition-colors shrink-0"
              >
                Add
              </button>
            </div>
          ))}
        </div>
      )}

      {searched && results.length === 0 && !searching && !searchError && (
        <p className="text-xs text-ui/25 text-center py-2">No models found matching "{query}"</p>
      )}

      {pricingModalModel && (
        <AddModelPricingModal
          providerId={providerId}
          model={pricingModalModel}
          onClose={() => setPricingModalModel(null)}
          onAdded={() => handleAdded(pricingModalModel.apiModelId)}
        />
      )}

      <ManualAddModel providerId={providerId} onModelAdded={onModelAdded} />
    </div>
  );
};

// Add-from-catalog pricing modal: pre-fills a catalog price, says so in red when the
// provider lists none; every unit is offered so per-song / per-clip models price correctly.

type AddModalUnit = 'token' | 'megapixel' | 'second' | 'character' | 'minute' | 'item';

const ADD_MODAL_UNITS: { unit: AddModalUnit; label: string; inputLabel: string; hint: string }[] = [
  { unit: 'token', label: 'Token', inputLabel: '$ / M tokens', hint: 'Per million input/output tokens.' },
  { unit: 'item', label: 'Item', inputLabel: '$ / item', hint: 'Flat price per generated item (a song, an image, a clip).' },
  { unit: 'second', label: 'Second', inputLabel: '$ / second', hint: 'Per second of generated media (video / audio).' },
  { unit: 'megapixel', label: 'Megapixel', inputLabel: '$ / megapixel', hint: 'Per output megapixel (image gen).' },
  { unit: 'minute', label: 'Minute', inputLabel: '$ / minute', hint: 'Per minute of input audio (transcription).' },
  { unit: 'character', label: 'Character', inputLabel: '$ / character', hint: 'Per character of input text (TTS).' },
];

const AddModelPricingModal = ({
  providerId,
  model,
  onClose,
  onAdded,
}: {
  providerId: string;
  model: api.BrowseModelResult;
  onClose: () => void;
  onAdded: () => void;
}) => {
  const priceAvailable = model.priceAvailable !== false;

  // Default unit: token when the catalog gave a price, else guessed from the output
  // modality (video → second, image → megapixel, audio → item) so generators land right.
  const guessUnit = (): AddModalUnit => {
    if (priceAvailable) return 'token';
    const mods = model.outputModalities ?? [];
    if (mods.includes('video')) return 'second';
    if (mods.includes('audio')) return 'item';
    if (mods.includes('image')) return 'megapixel';
    return 'token';
  };

  const [unit, setUnit] = useState<AddModalUnit>(guessUnit());
  const [inputPrice, setInputPrice] = useState(
    model.inputCostPerM !== null && model.inputCostPerM !== undefined ? String(model.inputCostPerM) : '',
  );
  const [outputPrice, setOutputPrice] = useState(
    model.outputCostPerM !== null && model.outputCostPerM !== undefined ? String(model.outputCostPerM) : '',
  );
  const [unitPrice, setUnitPrice] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsePrice = (s: string): number | null => {
    const trimmed = s.trim();
    if (trimmed === '') return null;
    const n = parseFloat(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const handleConfirm = async () => {
    setAdding(true);
    setError(null);
    const result = await api.addProviderModel(providerId, {
      ...model,
      pricingUnit: unit,
      inputCostPerM: unit === 'token' ? parsePrice(inputPrice) : null,
      outputCostPerM: unit === 'token' ? parsePrice(outputPrice) : null,
      costPerUnit: unit === 'token' ? null : parsePrice(unitPrice),
    });
    setAdding(false);
    if (result.ok) onAdded();
    else setError(result.error ?? 'Failed to add model');
  };

  const activeHint = ADD_MODAL_UNITS.find(u => u.unit === unit)?.hint ?? '';
  const activeInputLabel = ADD_MODAL_UNITS.find(u => u.unit === unit)?.inputLabel ?? '$ / unit';

  return (
    <>
      {/* The dim stays its own layer: the `.dojo3-stage` backdrop reset only ever
          makes the backdrop transparent, so folding it in would dim nothing. */}
      <div className="fixed inset-0 bg-black/50" />
      <ModalShell
        onClose={onClose}
        label="Add model"
        backdropClassName="fixed inset-0 z-50 flex items-center justify-center p-4"
        panelClassName="glass-modal-bg relative z-10 w-full max-w-md p-5 rounded-2xl shadow-xl"
        closeOnEscape={!adding}
        closeOnBackdrop={!adding}
      >
        <h3 className="text-sm font-semibold text-ui/90">Add model</h3>
        <p className="text-xs text-ui/50 mt-0.5 truncate">{model.name}</p>
        <p className="text-[10px] text-ui/35 truncate">{model.apiModelId}</p>

        {priceAvailable ? (
          <p className="mt-3 text-[11px] text-ui/45">Pricing was pulled from the provider catalog. Adjust if needed.</p>
        ) : (
          <p className="mt-3 text-[11px] text-cp-coral">
            This provider's catalog doesn't expose a price for this model. Enter one below, or leave it blank to set it later.
          </p>
        )}

        <div className="mt-4">
          <label className="block text-[11px] font-medium text-ui/60 mb-1">Priced by</label>
          <div className="flex flex-wrap gap-1.5">
            {ADD_MODAL_UNITS.map(({ unit: u, label }) => (
              <button
                key={u}
                type="button"
                onClick={() => setUnit(u)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                  unit === u
                    ? 'bg-cp-teal/25 text-cp-teal'
                    : 'bg-ui/[0.05] text-ui/50 hover:bg-ui/[0.08]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] text-ui/35">{activeHint}</p>
        </div>

        <div className="mt-4">
          {unit === 'token' ? (
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-[10px] text-ui/45 mb-1">Input $ / M</label>
                <input
                  type="number" min="0" step="any" value={inputPrice}
                  onChange={(e) => setInputPrice(e.target.value)}
                  placeholder="blank = unknown"
                  className="glass-input w-full text-sm"
                />
              </div>
              <div className="flex-1">
                <label className="block text-[10px] text-ui/45 mb-1">Output $ / M</label>
                <input
                  type="number" min="0" step="any" value={outputPrice}
                  onChange={(e) => setOutputPrice(e.target.value)}
                  placeholder="blank = unknown"
                  className="glass-input w-full text-sm"
                />
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-[10px] text-ui/45 mb-1">{activeInputLabel}</label>
              <input
                type="number" min="0" step="any" value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
                placeholder="blank = unknown"
                className="glass-input w-full text-sm"
              />
            </div>
          )}
        </div>

        {error && <p className="mt-3 text-[11px] text-cp-coral">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={adding}
            className="px-3 py-1.5 rounded-lg text-xs text-ui/60 hover:text-ui/90 hover:bg-ui/[0.06] transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={adding}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-cp-teal/20 text-cp-teal hover:bg-cp-teal/30 transition-colors disabled:opacity-40"
          >
            {adding ? 'Adding…' : 'Add model'}
          </button>
        </div>
      </ModalShell>
    </>
  );
};

const MANUAL_ADD_CAPABILITIES = [
  { key: 'tools', label: 'Tools', desc: 'Function/tool calling' },
  { key: 'vision', label: 'Vision', desc: 'Image input' },
  { key: 'thinking', label: 'Thinking', desc: 'Extended reasoning' },
  { key: 'image_generation', label: 'Image Gen', desc: 'Image output' },
  { key: 'video_generation', label: 'Video Gen', desc: 'Video output' },
  { key: 'audio_generation', label: 'TTS', desc: 'Text-to-speech: reads text aloud' },
  { key: 'music_generation', label: 'Music Gen', desc: 'Composes music / sound effects from a prompt' },
  { key: 'transcription', label: 'Transcription', desc: 'Speech-to-text' },
] as const;

type ManualAddPricingUnit = 'token' | 'megapixel' | 'second' | 'character' | 'minute' | 'item';

const ManualAddModel = ({ providerId, onModelAdded }: { providerId: string; onModelAdded: () => void }) => {
  const [expanded, setExpanded] = useState(false);
  const [modelId, setModelId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [selectedCaps, setSelectedCaps] = useState<Set<string>>(new Set());
  const [pricingUnit, setPricingUnit] = useState<ManualAddPricingUnit>('token');
  const [inputPrice, setInputPrice] = useState('');
  const [outputPrice, setOutputPrice] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Units follow the ticked capabilities; token is always allowed, the rest mirror the ModelRow rules.
  const supportsImageGen = selectedCaps.has('image_generation');
  const supportsVideoGen = selectedCaps.has('video_generation');
  const supportsAudioGen = selectedCaps.has('audio_generation');
  const supportsMusicGen = selectedCaps.has('music_generation');
  const supportsTranscription = selectedCaps.has('transcription');
  const availableUnits: ManualAddPricingUnit[] = ['token'];
  if (supportsImageGen) availableUnits.push('megapixel');
  if (supportsVideoGen || supportsAudioGen || supportsMusicGen) availableUnits.push('second');
  if (supportsAudioGen) availableUnits.push('character');
  if (supportsTranscription) availableUnits.push('minute');
  if (supportsImageGen || supportsVideoGen || supportsAudioGen || supportsMusicGen) availableUnits.push('item');

  // If the user untoggled a capability that the current unit depended
  // on, snap back to token so we don't submit an invalid combo.
  useEffect(() => {
    if (!availableUnits.includes(pricingUnit)) setPricingUnit('token');
  }, [availableUnits, pricingUnit]);

  const UNIT_LABEL: Record<ManualAddPricingUnit, string> = {
    token: 'Token', megapixel: 'Megapixel', second: 'Second',
    character: 'Character', minute: 'Minute', item: 'Item',
  };
  const UNIT_HINT: Record<ManualAddPricingUnit, string> = {
    token: 'Per million tokens. Enter 0 for free; blank for unknown.',
    megapixel: 'Per output megapixel. Useful for OpenRouter image-gen SKUs that don\'t price by token.',
    second: 'Per second of generated media. Typical for video and some audio models.',
    character: 'Per character of input text. Common for TTS providers.',
    minute: 'Per minute of input audio. Common for transcription providers.',
    item: 'Flat price per generated item (a song, an image, a clip). Common for music models that bill per track.',
  };

  const toggleCap = (key: string) => {
    setSelectedCaps(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Empty means unknown, "0" means free: two different saved states.
  const parsePrice = (s: string): number | null => {
    const trimmed = s.trim();
    if (trimmed === '') return null;
    const n = parseFloat(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const handleAdd = async () => {
    const trimmedId = modelId.trim();
    if (!trimmedId) { setError('Model ID is required'); return; }
    setError(null);
    setAdding(true);

    // The chosen unit can go stale between toggles; snap to token rather than submit an invalid combo.
    const effectiveUnit: ManualAddPricingUnit =
      availableUnits.includes(pricingUnit) ? pricingUnit : 'token';

    const result = await api.addProviderModel(providerId, {
      apiModelId: trimmedId,
      name: displayName.trim() || trimmedId,
      contextWindow: null,
      maxOutputTokens: null,
      inputCostPerM: effectiveUnit === 'token' ? parsePrice(inputPrice) : null,
      outputCostPerM: effectiveUnit === 'token' ? parsePrice(outputPrice) : null,
      pricingUnit: effectiveUnit,
      costPerUnit: effectiveUnit === 'token' ? null : parsePrice(unitPrice),
      capabilities: Array.from(selectedCaps),
    } as api.BrowseModelResult & { capabilities?: string[]; pricingUnit?: ManualAddPricingUnit; costPerUnit?: number | null });

    setAdding(false);
    if (result.ok) {
      setModelId('');
      setDisplayName('');
      setSelectedCaps(new Set());
      setInputPrice('');
      setOutputPrice('');
      setUnitPrice('');
      setPricingUnit('token');
      setExpanded(false);
      onModelAdded();
    } else {
      setError(result.error ?? 'Failed to add model');
    }
  };

  return (
    <div className="border-t border-ui/[0.06] pt-3 mt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-ui/40 hover:text-ui/70 transition-colors"
      >
        {expanded ? '▾ Hide manual add' : '▸ Manual add (model not in catalog?)'}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          <p className="text-[10px] text-ui/25">
            For models not listed in the catalog (e.g. new image models, private endpoints).
            Enter the exact model ID from the provider and select its capabilities.
          </p>

          <div className="flex gap-2">
            <input
              type="text"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="Model ID (e.g. black-forest-labs/flux.2-max)"
              className="glass-input flex-1 font-mono"
            />
          </div>

          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Display name (optional, defaults to model ID)"
            className="glass-input w-full"
          />

          <div>
            <label className="form-label mb-2">Capabilities</label>
            <div className="flex flex-wrap gap-2">
              {MANUAL_ADD_CAPABILITIES.map(cap => (
                <button
                  key={cap.key}
                  onClick={() => toggleCap(cap.key)}
                  title={cap.desc}
                  className={`px-2.5 py-1 rounded text-[11px] font-medium border transition-colors ${
                    selectedCaps.has(cap.key)
                      ? 'bg-cp-blue/20 text-cp-blue-light border-cp-blue/40'
                      : 'bg-ui/[0.03] text-ui/40 border-ui/[0.10] hover:border-ui/[0.15]'
                  }`}
                >
                  {cap.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
              <label className="form-label">Pricing (optional)</label>
              {availableUnits.length > 1 && (
                <div className="flex rounded-md overflow-hidden border border-ui/[0.10] text-[11px] font-medium">
                  {availableUnits.map((unit) => (
                    <button
                      key={unit}
                      onClick={() => setPricingUnit(unit)}
                      className={`px-2.5 py-1 transition-colors ${
                        pricingUnit === unit
                          ? 'bg-cp-amber/20 text-cp-amber'
                          : 'bg-ui/[0.03] text-ui/40 hover:text-ui/70'
                      }`}
                      type="button"
                    >
                      {UNIT_LABEL[unit]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {pricingUnit === 'token' ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={inputPrice}
                    onChange={(e) => setInputPrice(e.target.value)}
                    placeholder="Input $/M, blank if unknown"
                    className="glass-input w-full"
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={outputPrice}
                    onChange={(e) => setOutputPrice(e.target.value)}
                    placeholder="Output $/M, blank if unknown"
                    className="glass-input w-full"
                  />
                </div>
                <p className="text-[10px] text-ui/25 mt-1">{UNIT_HINT.token}</p>
              </>
            ) : (
              <>
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(e.target.value)}
                  placeholder={`$ per ${pricingUnit}, blank if unknown`}
                  className="glass-input w-full"
                />
                <p className="text-[10px] text-ui/25 mt-1">{UNIT_HINT[pricingUnit]}</p>
              </>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleAdd}
              disabled={adding || !modelId.trim()}
              className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
            >
              {adding ? 'Adding...' : 'Add Model'}
            </button>
            {error && <span className="text-xs text-cp-coral">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
};

export const ModelsTab = () => {
  const toast = useToast();
  const [models, setModels] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [primaryModelId, setPrimaryModelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingModel, setSettingModel] = useState(false);
  const [primaryError, setPrimaryError] = useState<string | null>(null);   // the server's refusal, shown

  const [primaryAgentId, setPrimaryAgentId] = useState('primary');
  // False until both look-ups (which agent is primary, and its model) have answered.
  const [primaryKnown, setPrimaryKnown] = useState(false);

  const loadData = async () => {
    setPrimaryKnown(false);
    const pidResult = await api.getSetting('primary_agent_id');
    const pid = pidResult.ok && pidResult.data.value ? pidResult.data.value : 'primary';
    setPrimaryAgentId(pid);
    const [modelsResult, agentResult, providersResult] = await Promise.all([
      api.getModels(),
      api.getAgent(pid),
      api.getProviders(),
    ]);
    if (modelsResult.ok) setModels(modelsResult.data);
    if (agentResult.ok) setPrimaryModelId(agentResult.data.modelId);
    setPrimaryKnown(pidResult.ok && agentResult.ok);
    if (providersResult.ok) setProviders(providersResult.data);
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, []);

  const toggleModel = async (model: Model) => {
    if (model.isEnabled) {
      const usage = await api.checkModelUsage([model.id]);
      if (!usage.ok) {
        if (!window.confirm(`Could not check which agents use this model (${usage.error}). Turn it off anyway?`)) return;
      } else if (usage.data.usages.length > 0) {
        const affected = usage.data.usages[0].usedBy.map(u => u.name).join(', ');
        if (!window.confirm(`This model is currently used by: ${affected}.\n\nDisabling it moves them to another model of 32K or more, or leaves them with no model if there is none. Continue?`)) {
          return;
        }
      }
      const result = await api.disableModels([model.id]);
      if (result.ok) {
        setModels((prev) =>
          prev.map((m) => (m.id === model.id ? { ...m, isEnabled: false } : m)),
        );
        const { agentsMoved: moved, agentsWithoutModel: none } = result.data;
        if (moved + none > 0) toast.info(`${moved} agent(s) moved to another model and ${none} left with no model.`);
      } else {
        toast.error(result.error ?? 'The change could not be saved.');
      }
    } else {
      const result = await api.enableModels([model.id]);
      if (result.ok) {
        setModels((prev) =>
          prev.map((m) => (m.id === model.id ? { ...m, isEnabled: true } : m)),
        );
      } else {
        toast.error(result.error ?? 'The change could not be saved.');
      }
    }
  };

  const handleSetPrimaryModel = async (modelId: string) => {
    setSettingModel(true);
    const result = await api.setAgentModel(primaryAgentId, modelId);
    if (result.ok) { setPrimaryModelId(modelId); setPrimaryError(null); } else setPrimaryError(result.error);
    setSettingModel(false);
  };

  if (loading) return <div className="loading-state">Loading...</div>;

  const enabledModels = models.filter((m) => m.isEnabled);
  const showWarning = primaryKnown && !primaryModelId && enabledModels.length > 0;

  return (
    <div className="space-y-3 max-w-4xl">
      {!primaryKnown && <div className="note--warn">Could not read the primary agent's model right now.</div>}
      {showWarning && (
        <div className="alert-banner alert-warning flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-cp-amber">Primary agent has no model assigned</h3>
            <p className="text-xs text-cp-amber/70 mt-0.5">
              Your primary agent can't respond to messages without a model. Pick one below.
            </p>
          </div>
          <select
            onChange={(e) => handleSetPrimaryModel(e.target.value)}
            disabled={settingModel}
            defaultValue=""
            className="px-3 py-2 bg-ui/[0.05] border border-cp-amber/40 rounded-lg text-sm text-ui/90 focus:outline-none focus:ring-2 focus:ring-cp-amber min-w-[180px]"
          >
            <option value="" disabled>
              {settingModel ? 'Setting...' : 'Set Model'}
            </option>
            {enabledModels.filter(isListedAgentModel).map((m) => <AgentModelOption key={m.id} model={m} label={m.name} />)}
          </select>
        </div>
      )}
      {primaryError && <div className="alert-banner alert-error">{primaryError}</div>}

      {providers.length === 0 ? (
        <p className="text-ui/40 text-sm">No providers configured. Add one in the Providers tab first.</p>
      ) : (
        providers.map(provider => {
          const providerModels = models
            .filter(m => m.providerId === provider.id)
            .sort((a, b) => (parseUtc(a.createdAt)?.getTime() ?? 0) - (parseUtc(b.createdAt)?.getTime() ?? 0));
          const isAggregator = provider.type === 'openai-compatible' && provider.isValidated;
          // Skip empty groups EXCEPT aggregators: they need the browse box visible
          if (providerModels.length === 0 && !isAggregator) return null;
          return (
            <ProviderModelGroup
              key={provider.id}
              provider={provider}
              models={providerModels}
              primaryModelId={primaryModelId}
              onToggle={toggleModel}
              onPricingChange={loadData}
              browseSection={isAggregator ? (
                <BrowseModels
                  providerId={provider.id}
                  providerName={provider.name}
                  onModelAdded={loadData}
                />
              ) : undefined}
            />
          );
        })
      )}

      {/* Platform-level model pickers, below the provider catalogs. They take the live models
          list as a prop, so newly added models show in the dropdowns without a page reload. */}
      <div className="scards pt-3">
        <FallbackVisionModelCard models={models} />
        <ImageGenModelCard models={models} />
        <VideoGenModelCard models={models} />
        <AudioGenModelCard models={models} />
        <MusicGenModelCard models={models} />
        <TranscriptionModelCard models={models} />
      </div>
    </div>
  );
};
