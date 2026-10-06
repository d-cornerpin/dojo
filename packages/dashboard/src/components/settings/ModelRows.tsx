// ── Settings → THE SHARED MODEL-ROW STACK, and the reason this split is not simply one file per tab.
//
// `ProviderModelGroup` renders `ModelRow`, and the Models tab renders `ProviderModelGroup`.
// Split strictly by tab, Providers and Models would have imported each other — a CYCLE, and a
// worse coupling than the god file had. The rows, their three editors, the capability badges
// and the Ollama host/RAM row are what both tabs actually share, so they live here and the two
// tabs both depend on this, not on one another.
//
// Lifted OUT of `pages/Settings.tsx` by t111-E1. The moved lines are VERBATIM; the only new
// bytes are this header, the imports below and the `export` keyword(s).

import { useState } from 'react';
import type { Provider, Model, GenerationParamSpec, VoiceOption } from '@dojo/shared';
import * as api from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { CollapseChevron } from '../CollapseToggle';


// ── Models Tab ──

export const ProviderModelGroup = ({
  provider,
  models,
  primaryModelId,
  onToggle,
  onPricingChange,
  browseSection,
}: {
  provider: Provider;
  models: Model[];
  primaryModelId: string | null;
  onToggle: (model: Model) => void;
  onPricingChange: () => void;
  browseSection?: React.ReactNode;
}) => {
  // Collapsed by default — long catalogs (OpenRouter etc.) make the page
  // unwieldy when every group expands on load. User clicks to drill in.
  const [open, setOpen] = useState(false);
  const enabledCount = models.filter(m => m.isEnabled).length;

  return (
    <div className="tile overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-3 flex items-center justify-between text-sm font-medium text-ui/70 hover:bg-ui/[0.03] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span>{provider.name}</span>
          <span className="text-xs text-ui/25">{enabledCount}/{models.length} enabled</span>
        </div>
        <CollapseChevron collapsed={!open} className="text-ui/40" />
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2">
          {provider.type === 'ollama' && (
            <OllamaHostRamRow provider={provider} onChange={onPricingChange} />
          )}
          {models.map(model => (
            <ModelRow
              key={model.id}
              model={model}
              providerType={provider.type}
              isPrimaryModel={model.id === primaryModelId}
              onToggle={() => onToggle(model)}
              onPricingChange={onPricingChange}
            />
          ))}
          {browseSection}
        </div>
      )}
    </div>
  );
};

// Detects localhost Ollama from the stored base URL. Mirrors the server-side
// helper in services/num-ctx-calculator.ts so the UI shows the right state
// (auto-detected vs. editable) before any API call.
function isLocalOllamaBaseUrlClient(baseUrl: string | null): boolean {
  if (!baseUrl) return true; // default Ollama baseUrl is localhost
  const lower = baseUrl.toLowerCase();
  return (
    lower.includes('localhost') ||
    lower.includes('127.0.0.1') ||
    lower.includes('[::1]') ||
    lower.includes('0.0.0.0')
  );
}

// Ollama-only: row above the model list showing/editing how much RAM the
// Ollama host has, so the num_ctx auto-sizer can compute recommendations.
// For localhost, this is auto-detected from the dojo host; for remote
// providers, the user types it in and the server recomputes every model's
// num_ctx recommendation on the spot.
const OllamaHostRamRow = ({ provider, onChange }: { provider: Provider; onChange: () => void }) => {
  const isLocal = isLocalOllamaBaseUrlClient(provider.baseUrl);
  const [ramInput, setRamInput] = useState(
    provider.hostRamGb === null ? '' : String(provider.hostRamGb),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    const trimmed = ramInput.trim();
    let ramGb: number | null;
    if (trimmed === '') {
      ramGb = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        setError('Must be a whole number');
        return;
      }
      if (n < 1 || n > 2048) {
        setError('Must be between 1 and 2048');
        return;
      }
      ramGb = n;
    }
    if (ramGb === provider.hostRamGb) return; // no change

    setSaving(true);
    const result = await api.updateProviderHostRam(provider.id, ramGb);
    setSaving(false);
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      // onChange triggers a models reload so every card's recommended
      // num_ctx picks up the newly-computed value from the server.
      onChange();
    } else {
      setError(result.error ?? 'Save failed');
    }
  };

  if (isLocal) {
    return (
      <div className="glass-nested rounded-xl p-3 flex items-center gap-3 text-xs">
        <span className="text-ui/40 w-20">Host RAM</span>
        <span className="text-ui/70 font-mono">auto-detected (this machine)</span>
        <span className="text-[10px] text-ui/25 italic">
          num_ctx recommendations use os.totalmem()
        </span>
      </div>
    );
  }

  return (
    <div className="glass-nested rounded-xl p-3 flex items-center gap-3 text-xs">
      <label className="text-ui/40 w-20" title="Total RAM of the remote Ollama host in GB. The dojo uses this value to auto-size num_ctx recommendations for every model on this provider.">
        Host RAM
      </label>
      <input
        type="number"
        step="1"
        min="1"
        max="2048"
        placeholder="GB"
        value={ramInput}
        onChange={(e) => setRamInput(e.target.value)}
        onBlur={handleSave}
        disabled={saving}
        className="glass-input w-20 font-mono text-right disabled:opacity-60"
      />
      <span className="text-[10px] text-ui/25">GB</span>
      {saved && <span className="text-xs text-cp-teal">Saved — recomputing…</span>}
      {error && <span className="text-xs text-cp-coral">{error}</span>}
      {!saved && !error && (
        <span className="text-[10px] text-ui/25 italic">
          {provider.hostRamGb === null
            ? 'set this to enable num_ctx recommendations for remote models'
            : `num_ctx auto-sized for ${provider.hostRamGb} GB`}
        </span>
      )}
    </div>
  );
};

const CAPABILITY_LABELS: Record<string, { label: string; className: string; title: string }> = {
  tools: {
    label: 'Tools',
    className: 'bg-cp-blue/15 text-cp-blue-light border-cp-blue/30',
    title: 'Supports function/tool calling',
  },
  vision: {
    label: 'Vision',
    className: 'bg-cp-purple/15 text-cp-purple border-cp-purple/30',
    title: 'Can accept image inputs',
  },
  thinking: {
    label: 'Thinking',
    className: 'bg-cp-amber/15 text-cp-amber-light border-cp-amber/30',
    title: 'Supports extended reasoning / thinking',
  },
  embedding: {
    label: 'Embedding',
    className: 'bg-cp-teal/15 text-cp-teal-light border-cp-teal/30',
    title: 'Embedding model (not for chat)',
  },
  image_generation: {
    label: 'Image Gen',
    className: 'bg-cp-amber/15 text-cp-amber border-cp-amber/30',
    title: 'Can generate images via the image_create tool',
  },
  video_generation: {
    label: 'Video Gen',
    className: 'bg-cp-coral/15 text-cp-coral border-cp-coral/30',
    title: 'Can generate video via the video_create tool',
  },
  audio_generation: {
    label: 'TTS',
    className: 'bg-cp-teal/15 text-cp-teal border-cp-teal/30',
    title: 'Text-to-speech: reads text aloud as a voice. Drives the tts_create tool.',
  },
  music_generation: {
    label: 'Music Gen',
    className: 'bg-cp-purple/15 text-cp-purple border-cp-purple/30',
    title: 'Composes music or sound effects from a creative prompt. Different from TTS — does NOT read text aloud.',
  },
  transcription: {
    label: 'Transcription',
    className: 'bg-cp-blue/15 text-cp-blue border-cp-blue/30',
    title: 'Can convert audio to text via the transcribe_audio tool',
  },
};

// Capability keys the user can manually toggle in the edit UI. Matches
// the MANUAL_ADD_CAPABILITIES set above, but kept separately so we can
// independently evolve either without coupling the two flows.
const EDITABLE_CAPABILITIES = [
  { key: 'tools', label: 'Tools' },
  { key: 'vision', label: 'Vision' },
  { key: 'thinking', label: 'Thinking' },
  { key: 'image_generation', label: 'Image Gen' },
  { key: 'video_generation', label: 'Video Gen' },
  { key: 'audio_generation', label: 'TTS' },
  { key: 'music_generation', label: 'Music Gen' },
  { key: 'transcription', label: 'Transcription' },
] as const;

const CapabilityBadges = ({ capabilities }: { capabilities: string[] }) => {
  const known = capabilities.filter(c => CAPABILITY_LABELS[c]);
  if (known.length === 0) {
    return (
      <div className="mt-1.5 flex items-center gap-1">
        <span className="text-[10px] text-ui/25 italic">capabilities unknown</span>
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {known.map(c => {
        const meta = CAPABILITY_LABELS[c];
        return (
          <span
            key={c}
            title={meta.title}
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${meta.className}`}
          >
            {meta.label}
          </span>
        );
      })}
    </div>
  );
};

export const ModelRow = ({
  model,
  providerType,
  isPrimaryModel,
  onToggle,
  onPricingChange,
}: {
  model: Model;
  providerType: string;
  isPrimaryModel: boolean;
  onToggle: () => void;
  onPricingChange: () => void;
}) => {
  const toast = useToast();
  const [inputCost, setInputCost] = useState(String(model.inputCostPerM ?? 0));
  const [outputCost, setOutputCost] = useState(String(model.outputCostPerM ?? 0));
  const [unitCost, setUnitCost] = useState(
    model.costPerUnit === null || model.costPerUnit === undefined
      ? (model.costPerMegapixel === null || model.costPerMegapixel === undefined
        ? ''
        : String(model.costPerMegapixel))
      : String(model.costPerUnit),
  );
  type PricingUnitChoice = 'token' | 'megapixel' | 'second' | 'character' | 'minute' | 'item';
  const [pricingUnit, setPricingUnit] = useState<PricingUnitChoice>(model.pricingUnit ?? 'token');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const supportsImageGen = model.capabilities.includes('image_generation');
  const supportsVideoGen = model.capabilities.includes('video_generation');
  const supportsAudioGen = model.capabilities.includes('audio_generation');
  const supportsMusicGen = model.capabilities.includes('music_generation');
  const supportsTranscription = model.capabilities.includes('transcription');

  // Which pricing units make sense for this model's capability set.
  // Token is always offered. Each other unit appears only when the
  // matching capability is on the model. 'item' (flat per-song / image /
  // clip) applies to any generation capability.
  const availableUnits: PricingUnitChoice[] = ['token'];
  if (supportsImageGen) availableUnits.push('megapixel');
  if (supportsVideoGen || supportsAudioGen || supportsMusicGen) availableUnits.push('second');
  if (supportsAudioGen) availableUnits.push('character');
  if (supportsTranscription) availableUnits.push('minute');
  if (supportsImageGen || supportsVideoGen || supportsAudioGen || supportsMusicGen) availableUnits.push('item');
  const showUnitToggle = availableUnits.length > 1;

  const UNIT_LABEL: Record<PricingUnitChoice, string> = {
    token: 'Token',
    megapixel: 'Megapixel',
    second: 'Second',
    character: 'Character',
    minute: 'Minute',
    item: 'Item',
  };
  const UNIT_PLACEHOLDER: Record<PricingUnitChoice, string> = {
    token: '',
    megapixel: '$ per output megapixel',
    second: '$ per second of output',
    character: '$ per character of input',
    minute: '$ per minute of input',
    item: '$ per generated item (song / image / clip)',
  };
  const UNIT_INPUT_LABEL: Record<PricingUnitChoice, string> = {
    token: '$/M',
    megapixel: '$/MP',
    second: '$/sec',
    character: '$/char',
    minute: '$/min',
    item: '$/item',
  };

  // Local optimistic state for the thinking toggle. Mirrors the prop but
  // flips instantly on click while the PATCH is in flight.
  const [thinkingEnabled, setThinkingEnabled] = useState(model.thinkingEnabled);
  const supportsThinking = model.capabilities.includes('thinking');

  // Inline capability editor — opens when the user clicks Edit next to
  // the capability badges. Lets the user overwrite the probed
  // capabilities directly. Useful when a provider doesn't advertise a
  // newly-launched SKU's true output modality (e.g. OpenRouter not
  // tagging google/lyria-3-clip-preview as audio_generation).
  const [editingCaps, setEditingCaps] = useState(false);
  const [draftCaps, setDraftCaps] = useState<Set<string>>(new Set(model.capabilities));
  const [savingCaps, setSavingCaps] = useState(false);
  const capsChanged =
    editingCaps && (
      draftCaps.size !== model.capabilities.length ||
      model.capabilities.some(c => !draftCaps.has(c))
    );
  const handleCapsSave = async () => {
    setSavingCaps(true);
    const result = await api.updateModelCapabilities(model.id, Array.from(draftCaps));
    setSavingCaps(false);
    if (result.ok) {
      setEditingCaps(false);
      onPricingChange(); // reload models so badges + downstream pickers refresh
    } else {
      toast.error(result.error ?? 'Failed to save capabilities');
    }
  };
  const handleCapsCancel = () => {
    setDraftCaps(new Set(model.capabilities));
    setEditingCaps(false);
  };

  // Ollama-only: per-model num_ctx control. The input box shows
  // `override ?? recommended`. When the user types, it becomes an
  // override. Reset button restores to the RAM-aware recommendation.
  const isOllama = providerType === 'ollama';
  const effectiveNumCtx =
    model.numCtxOverride ?? model.numCtxRecommended ?? null;
  const [numCtxInput, setNumCtxInput] = useState(
    effectiveNumCtx === null ? '' : String(effectiveNumCtx),
  );
  const [ctxSaving, setCtxSaving] = useState(false);
  const [ctxSaved, setCtxSaved] = useState(false);
  const [ctxError, setCtxError] = useState<string | null>(null);

  // Parse the per-unit cost input. Empty string → null (unknown).
  const parsedUnit = unitCost.trim() === '' ? null : Number(unitCost);
  const currentSavedUnitValue = model.costPerUnit ?? model.costPerMegapixel ?? null;
  const unitHasChanges = parsedUnit !== currentSavedUnitValue;
  const tokenHasChanges =
    Number(inputCost) !== (model.inputCostPerM ?? 0) ||
    Number(outputCost) !== (model.outputCostPerM ?? 0);
  const hasChanges =
    pricingUnit !== (model.pricingUnit ?? 'token') ||
    (pricingUnit === 'token' ? tokenHasChanges : unitHasChanges);

  const handleSave = async () => {
    setSaving(true);
    const payload: Parameters<typeof api.updateModelPricing>[1] = {
      pricingUnit,
    };
    if (pricingUnit === 'token') {
      payload.inputCostPerM = Number(inputCost) || 0;
      payload.outputCostPerM = Number(outputCost) || 0;
    } else {
      // null is meaningful (unknown), so send it through explicitly.
      payload.costPerUnit = parsedUnit;
    }
    const result = await api.updateModelPricing(model.id, payload);
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onPricingChange();
    }
    setSaving(false);
  };

  const handleUnitToggle = async (next: PricingUnitChoice) => {
    if (next === pricingUnit) return;
    setPricingUnit(next);
    // Persist the mode change immediately so the model is consistent
    // even if the user navigates away without typing a new number.
    setSaving(true);
    const result = await api.updateModelPricing(model.id, { pricingUnit: next });
    if (result.ok) onPricingChange();
    setSaving(false);
  };

  const handleThinkingToggle = async () => {
    const next = !thinkingEnabled;
    setThinkingEnabled(next); // optimistic
    const result = await api.updateModelThinking(model.id, next);
    if (!result.ok) {
      setThinkingEnabled(!next); // roll back
    } else {
      onPricingChange();
    }
  };

  const handleNumCtxSave = async () => {
    setCtxError(null);
    const trimmed = numCtxInput.trim();

    // Empty input means "use the recommendation" (clear any override).
    // Otherwise parse and validate. If the typed value equals the current
    // recommendation exactly, that's also equivalent to "no override".
    let override: number | null;
    if (trimmed === '') {
      override = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        setCtxError('Must be a whole number');
        return;
      }
      if (n < 512 || n > 2_097_152) {
        setCtxError('Must be between 512 and 2097152');
        return;
      }
      override = n === model.numCtxRecommended ? null : n;
    }

    if (override === model.numCtxOverride) return; // no change

    setCtxSaving(true);
    const result = await api.updateModelNumCtx(model.id, override);
    setCtxSaving(false);
    if (result.ok) {
      setCtxSaved(true);
      setTimeout(() => setCtxSaved(false), 1500);
      onPricingChange();
    } else {
      setCtxError(result.error ?? 'Save failed');
    }
  };

  const handleNumCtxReset = async () => {
    setCtxError(null);
    // Restore the box to the recommendation (or empty if no recommendation).
    setNumCtxInput(
      model.numCtxRecommended === null ? '' : String(model.numCtxRecommended),
    );
    if (model.numCtxOverride === null) return; // nothing to clear server-side
    setCtxSaving(true);
    const result = await api.updateModelNumCtx(model.id, null);
    setCtxSaving(false);
    if (result.ok) {
      setCtxSaved(true);
      setTimeout(() => setCtxSaved(false), 1500);
      onPricingChange();
    } else {
      setCtxError(result.error ?? 'Reset failed');
    }
  };

  return (
    <div className="tile">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-ui">
            {model.name}
            {isPrimaryModel && (
              <span className="ml-2 text-xs text-cp-blue font-normal">(primary agent model)</span>
            )}
          </h3>
          <p className="text-xs text-ui/40 mt-0.5">
            {model.apiModelId}
            {model.contextWindow ? ` | ${Math.round(model.contextWindow / 1000)}k context` : ''}
            {' | '}{model.providerId}
          </p>
          {editingCaps ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {EDITABLE_CAPABILITIES.map((cap) => {
                const checked = draftCaps.has(cap.key);
                return (
                  <button
                    key={cap.key}
                    type="button"
                    onClick={() => {
                      const next = new Set(draftCaps);
                      if (checked) next.delete(cap.key);
                      else next.add(cap.key);
                      setDraftCaps(next);
                    }}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                      checked
                        ? 'bg-cp-amber/20 text-cp-amber border-cp-amber/40'
                        : 'bg-ui/[0.03] text-ui/40 border-ui/[0.10] hover:border-ui/[0.15]'
                    }`}
                  >
                    {cap.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={handleCapsSave}
                disabled={savingCaps || !capsChanged}
                className="px-2 py-0.5 text-[10px] glass-btn-primary rounded transition-colors disabled:opacity-40"
              >
                {savingCaps ? '...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={handleCapsCancel}
                disabled={savingCaps}
                className="px-2 py-0.5 text-[10px] text-ui/40 hover:text-ui/70 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
              <CapabilityBadges capabilities={model.capabilities} />
              <button
                type="button"
                onClick={() => {
                  setDraftCaps(new Set(model.capabilities));
                  setEditingCaps(true);
                }}
                className="text-[10px] text-ui/40 hover:text-ui/70 underline transition-colors"
                title="Override the probed capabilities. Use when the provider didn't advertise a real capability of this model."
              >
                Edit
              </button>
            </div>
          )}
          {supportsThinking && (
            <label
              className="mt-2 inline-flex items-center gap-2 cursor-pointer select-none"
              title="When unchecked, the model is asked to skip extended thinking. Works for Ollama and OpenRouter models today; other providers store the preference for future use."
            >
              <input
                type="checkbox"
                checked={thinkingEnabled}
                onChange={handleThinkingToggle}
                className="h-3.5 w-3.5 rounded border-ui/[0.15] bg-ui/[0.05] accent-amber-500 cursor-pointer"
              />
              <span className="text-[11px] text-ui/55">
                Enable thinking
              </span>
            </label>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={model.isEnabled}
            onClick={onToggle}
            className={`switch ${model.isEnabled ? 'is-on' : ''}`}
          />
          <button
            onClick={async () => {
              if (!confirm(`Delete "${model.name}"? This removes it from the dojo entirely.`)) return;
              const result = await api.deleteModel(model.id);
              if (result.ok) {
                toast.success(`${model.name} deleted`);
                onPricingChange();
              } else {
                toast.error(result.error ?? 'Delete failed');
              }
            }}
            className="w-6 h-6 flex items-center justify-center rounded text-ui/25 hover:text-cp-coral hover:bg-cp-coral/10 transition-colors"
            title="Delete model"
          >
            <span className="text-sm leading-none">×</span>
          </button>
        </div>
      </div>

      {/* Pricing fields — segmented control for "priced by" appears
          only when the model has more than one applicable unit. Token
          is always one option; capability-specific units appear when
          the relevant capability is on the model. */}
      {showUnitToggle && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[11px] text-ui/40">Priced by</span>
          <div className="flex rounded-md overflow-hidden border border-ui/[0.10] text-[11px] font-medium">
            {availableUnits.map((unit) => (
              <button
                key={unit}
                onClick={() => handleUnitToggle(unit)}
                className={`px-2.5 py-1 transition-colors ${
                  pricingUnit === unit
                    ? 'bg-cp-amber/20 text-cp-amber'
                    : 'bg-ui/[0.03] text-ui/40 hover:text-ui/70'
                }`}
              >
                {UNIT_LABEL[unit]}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-4 flex-wrap">
        {pricingUnit === 'token' ? (
          <>
            <div className="flex items-center gap-2">
              <label className="text-xs text-ui/40 w-20">Input $/M</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={inputCost}
                onChange={(e) => setInputCost(e.target.value)}
                onBlur={() => hasChanges && handleSave()}
                className="glass-input w-24 font-mono text-right"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-ui/40 w-20">Output $/M</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={outputCost}
                onChange={(e) => setOutputCost(e.target.value)}
                onBlur={() => hasChanges && handleSave()}
                className="glass-input w-24 font-mono text-right"
              />
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <label className="text-xs text-ui/40 w-20" title={UNIT_PLACEHOLDER[pricingUnit]}>
              {UNIT_INPUT_LABEL[pricingUnit]}
            </label>
            <input
              type="number"
              step="0.001"
              min="0"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              onBlur={() => hasChanges && handleSave()}
              placeholder="leave blank if unknown"
              className="glass-input w-40 font-mono text-right"
            />
          </div>
        )}
        {hasChanges && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-2 py-1 text-xs glass-btn-primary rounded transition-colors"
          >
            {saving ? '...' : 'Save'}
          </button>
        )}
        {saved && <span className="text-xs text-cp-teal">Saved</span>}
      </div>

      {/* Price-unknown hint: this model has no rate on file (NULL, not an
          explicit 0), so per owner decision D-H its usage is billed at $0 and
          never counts toward the budget. Surfaced so a genuinely-paid model
          with a failed price lookup isn't silently hidden at $0. */}
      {model.priceUnknown && (
        <p className="mt-1.5 text-[11px] text-cp-coral">
          Price unknown, set a rate above. Until then this model is billed at $0 and does not count toward your budget.
        </p>
      )}

      {isOllama && (
        <div className="mt-3 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label
              className="text-xs text-ui/40 w-20"
              title="Context window (num_ctx) passed to Ollama for every call to this model. The pre-filled value is a RAM-aware recommendation based on your machine's memory and this model's architecture. Higher values use more RAM."
            >
              Context
            </label>
            <input
              type="number"
              step="1"
              min="512"
              max="2097152"
              placeholder={model.numCtxRecommended === null ? 'default' : ''}
              value={numCtxInput}
              onChange={(e) => setNumCtxInput(e.target.value)}
              onBlur={handleNumCtxSave}
              disabled={ctxSaving}
              className="glass-input w-28 font-mono text-right disabled:opacity-60"
            />
            <span className="text-[10px] text-ui/25">tokens</span>
            {model.numCtxRecommended !== null && (
              <button
                onClick={handleNumCtxReset}
                disabled={ctxSaving || (model.numCtxOverride === null && numCtxInput === String(model.numCtxRecommended))}
                className="text-[10px] text-ui/40 hover:text-ui/70 underline disabled:text-ui/25 disabled:no-underline disabled:cursor-default"
                title={`Reset to auto-sized recommendation (${model.numCtxRecommended.toLocaleString()} tokens)`}
              >
                reset
              </button>
            )}
          </div>
          {ctxSaved && <span className="text-xs text-cp-teal">Saved</span>}
          {ctxError && <span className="text-xs text-cp-coral">{ctxError}</span>}
          <span className="text-[10px] text-ui/25 italic">
            {model.numCtxOverride !== null
              ? 'override set — reset for auto-sized default'
              : model.numCtxRecommended !== null
              ? `auto-sized for your RAM (~${Math.round(model.numCtxRecommended / 1024)}k tokens)`
              : 'higher = more RAM'}
          </span>
        </div>
      )}

      <ModelLimitsEditor model={model} onSaved={onPricingChange} />

      {supportsVideoGen && (
        <GenerationParamsEditor model={model} onSaved={onPricingChange} />
      )}

      {supportsAudioGen && (
        <VoiceCatalogEditor model={model} onSaved={onPricingChange} />
      )}
    </div>
  );
};

// ── Model Limits Editor (T72b/1) ──
//
// `max output` and `context` decide what `max_tokens` goes on every request to this model.
// For a manual provider both are OUR GUESSES — browse-add stores nothing (no local server
// reports OpenRouter's `top_provider` block), validate stores `context_length ?? 128000` and
// a cap derived from it, and neither vLLM's `max_model_len` nor LM Studio's
// `max_context_length` is read. Until this editor existed there was no way to correct either
// one: every other writer of those columns is a discovery sync, and deleting and re-adding
// the model writes nothing again.
//
// The visible consequence, and the reason this shipped: a guessed window small enough (or a
// prompt large enough) collapses the derived output budget onto its floor, and for a model
// with thinking enabled that floor was a guaranteed empty answer — the reasoning spent the
// budget, the provider returned `finish_reason: length`, and no words were ever written.
//
// Blank means "let discovery decide" and is a real, restorable state, not a mistake.
const ModelLimitsEditor = ({ model, onSaved }: { model: Model; onSaved: () => void }) => {
  const [maxOut, setMaxOut] = useState(
    model.maxOutputTokens === null || model.maxOutputTokens === undefined ? '' : String(model.maxOutputTokens),
  );
  const [ctx, setCtx] = useState(
    model.contextWindow === null || model.contextWindow === undefined ? '' : String(model.contextWindow),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (
    field: 'maxOutputTokens' | 'contextWindow',
    raw: string,
    current: number | null | undefined,
  ) => {
    setError(null);
    const trimmed = raw.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && (!Number.isInteger(next) || next <= 0)) {
      setError('Must be a whole number of tokens, or blank');
      return;
    }
    if (next === (current ?? null)) return; // no change
    setSaving(true);
    const result = await api.updateModelLimits(model.id, { [field]: next });
    setSaving(false);
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onSaved();
    } else {
      setError(result.error ?? 'Save failed');
    }
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <label
          className="text-xs text-ui/40 w-20"
          title="The most tokens this model may generate in one reply. Models that think before they answer spend this budget on reasoning first, so a low value can produce an empty reply. Blank = let discovery decide."
        >
          Max output
        </label>
        <input
          type="number"
          step="1"
          min="1"
          placeholder="auto"
          value={maxOut}
          onChange={(e) => setMaxOut(e.target.value)}
          onBlur={() => save('maxOutputTokens', maxOut, model.maxOutputTokens)}
          disabled={saving}
          className="glass-input w-28 font-mono text-right disabled:opacity-60"
        />
        <span className="text-[10px] text-ui/25">tokens</span>
      </div>
      <div className="flex items-center gap-2">
        <label
          className="text-xs text-ui/40"
          title="How much this model can read in one call, prompt and reply together. Set it to what your server is actually configured for — a wrong value here shrinks the room left for the reply."
        >
          Context
        </label>
        <input
          type="number"
          step="1"
          min="1"
          placeholder="auto"
          value={ctx}
          onChange={(e) => setCtx(e.target.value)}
          onBlur={() => save('contextWindow', ctx, model.contextWindow)}
          disabled={saving}
          className="glass-input w-28 font-mono text-right disabled:opacity-60"
        />
        <span className="text-[10px] text-ui/25">tokens</span>
      </div>
      {saved && <span className="text-xs text-cp-teal">Saved</span>}
      {error && <span className="text-xs text-cp-coral">{error}</span>}
      {!saved && !error && (
        <span className="text-[10px] text-ui/25 italic">
          blank = discovered automatically
        </span>
      )}
    </div>
  );
};

// ── Generation Params Editor ──
// Per-model editor for the canonical generation params the agent must
// supply (video: duration / aspect_ratio / resolution). Each param maps to
// the model's accepted values/range plus the provider wire field it
// translates to. This is the user-confirmed override layer (decision: make
// the per-model spec editable on the card); blank or no edits leave the
// family-seeded default in place.
type ParamFieldDraft = {
  accepted: boolean;
  values: string;   // comma-separated, edited as text
  min: string;
  max: string;
  default: string;
  wireField: string;
  wireType: 'string' | 'number';
};

const specToDraft = (spec: GenerationParamSpec): Record<string, ParamFieldDraft> => {
  const out: Record<string, ParamFieldDraft> = {};
  for (const [name, f] of Object.entries(spec)) {
    out[name] = {
      accepted: f.accepted,
      values: f.values.map((v) => String(v)).join(', '),
      min: f.min === undefined ? '' : String(f.min),
      max: f.max === undefined ? '' : String(f.max),
      default: String(f.default),
      wireField: f.wireField,
      wireType: f.wireType,
    };
  }
  return out;
};

const GenerationParamsEditor = ({ model, onSaved }: { model: Model; onSaved: () => void }) => {
  const toast = useToast();
  const spec = model.generationParams;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, ParamFieldDraft>>(
    spec ? specToDraft(spec) : {},
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!spec) {
    return (
      <div className="mt-3 text-[10px] text-ui/25 italic">
        Generation params not seeded yet — restart the server to backfill, then edit here.
      </div>
    );
  }

  const paramNames = Object.keys(draft);

  const setField = (name: string, key: keyof ParamFieldDraft, value: string | boolean) => {
    setDraft((prev) => ({ ...prev, [name]: { ...prev[name], [key]: value } }));
  };

  const handleSave = async () => {
    // Rebuild a GenerationParamSpec from the draft. Numeric values are
    // coerced when the underlying wireType is number; otherwise kept as
    // strings (the agent-facing enum is matched by string equality).
    const next: GenerationParamSpec = {};
    for (const [name, d] of Object.entries(draft)) {
      const isNumeric = d.wireType === 'number';
      const values = d.values
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => (isNumeric ? Number(s) : s));
      const min = d.min.trim() === '' ? undefined : Number(d.min);
      const max = d.max.trim() === '' ? undefined : Number(d.max);
      const def = isNumeric && d.default.trim() !== '' && Number.isFinite(Number(d.default))
        ? Number(d.default)
        : d.default;
      next[name] = {
        accepted: d.accepted,
        values,
        ...(min !== undefined && Number.isFinite(min) ? { min } : {}),
        ...(max !== undefined && Number.isFinite(max) ? { max } : {}),
        default: def,
        wireField: d.wireField.trim(),
        wireType: d.wireType,
      };
    }
    setSaving(true);
    const result = await api.updateModelGenerationParams(model.id, next);
    setSaving(false);
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onSaved();
    } else {
      toast.error(result.error ?? 'Failed to save generation params');
    }
  };

  const handleReset = async () => {
    if (!confirm('Reset to the seeded defaults? Your edits will be cleared.')) return;
    setSaving(true);
    const result = await api.updateModelGenerationParams(model.id, null);
    setSaving(false);
    if (result.ok) {
      onSaved();
    } else {
      toast.error(result.error ?? 'Failed to reset generation params');
    }
  };

  return (
    <div className="mt-3 border-t border-ui/[0.08] pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-ui/55 hover:text-ui/80 transition-colors flex items-center gap-1"
        title="The agent must supply these params to use video_create. Edit the accepted values and how each maps to this model's request body."
      >
        <span>{open ? '▾' : '▸'}</span>
        Generation parameters
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-[80px_1fr_52px_52px_64px_84px_70px] gap-1.5 text-[9px] uppercase tracking-wide text-ui/30 px-0.5">
            <span>Param</span>
            <span>Allowed values</span>
            <span>Min</span>
            <span>Max</span>
            <span>Default</span>
            <span>Wire field</span>
            <span>Wire type</span>
          </div>
          {paramNames.map((name) => {
            const d = draft[name];
            return (
              <div key={name} className="grid grid-cols-[80px_1fr_52px_52px_64px_84px_70px] gap-1.5 items-center">
                <label className="inline-flex items-center gap-1 text-[11px] text-ui/60" title="Uncheck to drop this param from the request body for this model (the agent still must supply it).">
                  <input
                    type="checkbox"
                    checked={d.accepted}
                    onChange={(e) => setField(name, 'accepted', e.target.checked)}
                    className="h-3 w-3 rounded border-ui/[0.15] bg-ui/[0.05] accent-amber-500"
                  />
                  <span className="truncate">{name}</span>
                </label>
                <input
                  type="text"
                  value={d.values}
                  onChange={(e) => setField(name, 'values', e.target.value)}
                  placeholder="comma-separated; blank = use min/max"
                  className="glass-input text-[11px] font-mono"
                />
                <input
                  type="text"
                  value={d.min}
                  onChange={(e) => setField(name, 'min', e.target.value)}
                  className="glass-input text-[11px] font-mono text-right"
                />
                <input
                  type="text"
                  value={d.max}
                  onChange={(e) => setField(name, 'max', e.target.value)}
                  className="glass-input text-[11px] font-mono text-right"
                />
                <input
                  type="text"
                  value={d.default}
                  onChange={(e) => setField(name, 'default', e.target.value)}
                  className="glass-input text-[11px] font-mono text-right"
                />
                <input
                  type="text"
                  value={d.wireField}
                  onChange={(e) => setField(name, 'wireField', e.target.value)}
                  className="glass-input text-[11px] font-mono"
                />
                <select
                  value={d.wireType}
                  onChange={(e) => setField(name, 'wireType', e.target.value as 'string' | 'number')}
                  className="glass-input text-[11px]"
                >
                  <option value="string">string</option>
                  <option value="number">number</option>
                </select>
              </div>
            );
          })}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-2 py-1 text-xs glass-btn-primary rounded transition-colors"
            >
              {saving ? '...' : 'Save'}
            </button>
            <button
              onClick={handleReset}
              disabled={saving}
              className="text-[10px] text-ui/40 hover:text-ui/70 underline transition-colors"
              title="Clear your edits and re-apply the family-seeded defaults."
            >
              reset to defaults
            </button>
            {saved && <span className="text-xs text-cp-teal">Saved</span>}
            <span className="text-[10px] text-ui/25 italic">
              aspect_ratio + resolution compose the size field
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Voice Catalog Editor ──
// Per-model editor for the TTS voice list the agent may pick from (the
// tts_create tool). Each entry is an id (base timbre), a description (the
// vibe shown to the agent), and a perceived gender. Seeded from a code
// family registry; this is the user-confirmed override layer. Reset clears
// to null and lets the family seed re-apply on the next backfill.
type VoiceDraft = { id: string; description: string; gender: 'male' | 'female' | 'neutral' };

const VoiceCatalogEditor = ({ model, onSaved }: { model: Model; onSaved: () => void }) => {
  const toast = useToast();
  const catalog = model.voiceCatalog;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<VoiceDraft[]>(
    catalog ? catalog.map((v) => ({ id: v.id, description: v.description, gender: v.gender })) : [],
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!catalog) {
    return (
      <div className="mt-3 text-[10px] text-ui/25 italic">
        Voice catalog not seeded yet — restart the server to backfill, then edit here.
      </div>
    );
  }

  const setVoice = (i: number, key: keyof VoiceDraft, value: string) => {
    setDraft((prev) => prev.map((v, idx) => (idx === i ? { ...v, [key]: value } : v)));
  };
  const addVoice = () => setDraft((prev) => [...prev, { id: '', description: '', gender: 'neutral' }]);
  const removeVoice = (i: number) => setDraft((prev) => prev.filter((_, idx) => idx !== i));

  const handleSave = async () => {
    const next: VoiceOption[] = draft
      .map((v) => ({ id: v.id.trim(), description: v.description.trim(), gender: v.gender }))
      .filter((v) => v.id.length > 0);
    setSaving(true);
    const result = await api.updateModelVoiceCatalog(model.id, next);
    setSaving(false);
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onSaved();
    } else {
      toast.error(result.error ?? 'Failed to save voice catalog');
    }
  };

  const handleReset = async () => {
    if (!confirm('Reset to the seeded voices? Your edits will be cleared.')) return;
    setSaving(true);
    const result = await api.updateModelVoiceCatalog(model.id, null);
    setSaving(false);
    if (result.ok) {
      onSaved();
    } else {
      toast.error(result.error ?? 'Failed to reset voice catalog');
    }
  };

  return (
    <div className="mt-3 border-t border-ui/[0.08] pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-ui/55 hover:text-ui/80 transition-colors flex items-center gap-1"
        title="The voices the agent may pick from for tts_create. The id sets the base timbre; the description is the vibe the agent matches against a request."
      >
        <span>{open ? '▾' : '▸'}</span>
        Voices ({draft.length})
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-[96px_1fr_84px_28px] gap-1.5 text-[9px] uppercase tracking-wide text-ui/30 px-0.5">
            <span>Voice id</span>
            <span>Character</span>
            <span>Gender</span>
            <span></span>
          </div>
          {draft.map((v, i) => (
            <div key={i} className="grid grid-cols-[96px_1fr_84px_28px] gap-1.5 items-center">
              <input
                type="text"
                value={v.id}
                onChange={(e) => setVoice(i, 'id', e.target.value)}
                placeholder="onyx"
                className="glass-input text-[11px] font-mono"
              />
              <input
                type="text"
                value={v.description}
                onChange={(e) => setVoice(i, 'description', e.target.value)}
                placeholder="deep and authoritative"
                className="glass-input text-[11px]"
              />
              <select
                value={v.gender}
                onChange={(e) => setVoice(i, 'gender', e.target.value)}
                className="glass-input text-[11px]"
              >
                <option value="male">male</option>
                <option value="female">female</option>
                <option value="neutral">neutral</option>
              </select>
              <button
                type="button"
                onClick={() => removeVoice(i)}
                className="text-ui/30 hover:text-red-400 transition-colors text-sm"
                title="Remove this voice"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addVoice}
            className="text-[10px] text-ui/40 hover:text-ui/70 underline transition-colors"
          >
            + add voice
          </button>
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-2 py-1 text-xs glass-btn-primary rounded transition-colors"
            >
              {saving ? '...' : 'Save'}
            </button>
            <button
              onClick={handleReset}
              disabled={saving}
              className="text-[10px] text-ui/40 hover:text-ui/70 underline transition-colors"
              title="Clear your edits and re-apply the family-seeded voices."
            >
              reset to defaults
            </button>
            {saved && <span className="text-xs text-cp-teal">Saved</span>}
            <span className="text-[10px] text-ui/25 italic">
              character/accent/emotion goes in the spoken text, not the id
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
