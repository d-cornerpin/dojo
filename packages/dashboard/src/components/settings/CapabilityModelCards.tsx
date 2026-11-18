// ── Settings → The platform-wide capability model cards, shared by the Models and Sensei tabs.
// They belong to neither tab, so both import them; their private price formatters live here.

import { useGuardedLoad } from '../../lib/load-guard';
import { useState, useEffect, useRef } from 'react';
import type { Model } from '@dojo/shared';
import * as api from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { engineRoleId, loadEngineRoleIds } from '../../lib/engine-role-ids';
import { formatDate } from '../../lib/dates';
import { AgentModelOption } from '../AgentModelOption';
import { isListedAgentModel } from '../../lib/role-models';


// Platform-wide fallback vision pick: which vision-capable model takes over when the calling
// agent's own model can't see, anywhere the engine routes an image through a vision model.

// Cost text for a per-token rate: > 0 → "$X / M", exactly 0 → "Free", null → null (none known).
const formatTokenPrice = (n: number | null): string | null => {
  if (n === null || typeof n !== 'number') return null;
  if (n === 0) return 'Free';
  return `$${n}/M`;
};

// Per-unit price text: null or invalid → null, 0 → "Free"; characters are priced per 1k
// because per-character rates would render as fractions of a cent.
const formatUnitPrice = (
  n: number | null,
  unit: 'megapixel' | 'second' | 'character' | 'minute' | 'item',
): string | null => {
  if (n === null || typeof n !== 'number') return null;
  if (n === 0) return 'Free';
  switch (unit) {
    case 'megapixel': return `$${n}/MP`;
    case 'second':    return `$${n}/second`;
    case 'minute':    return `$${n}/minute`;
    case 'character': return `$${n * 1000} / 1k chars`;
    case 'item':      return `$${n}/item`;
  }
};

const ModelCostLine = ({ model }: { model: Model | null }) => {
  if (!model) return null;

  // Non-token units: costPerUnit, with costPerMegapixel as a fallback for
  // older image-gen rows that only carry the megapixel field.
  if (model.pricingUnit !== 'token') {
    const value = model.costPerUnit ?? model.costPerMegapixel;
    const label = formatUnitPrice(value, model.pricingUnit);
    if (label === null) {
      return (
        <p className="text-[11px] text-ui/35 mt-2">
          Pricing not listed for this model.
        </p>
      );
    }
    return (
      <p className="text-[11px] text-ui/55 mt-2">
        Cost: <span className="text-ui/80">{label}</span>
      </p>
    );
  }

  // Token: separate input and output rates.
  const inLabel = formatTokenPrice(model.inputCostPerM);
  const outLabel = formatTokenPrice(model.outputCostPerM);
  if (inLabel === null && outLabel === null) {
    return (
      <p className="text-[11px] text-ui/35 mt-2">
        Pricing not listed for this model.
      </p>
    );
  }
  return (
    <p className="text-[11px] text-ui/55 mt-2">
      Cost:{' '}
      {inLabel !== null && (
        <span className="text-ui/80">{inLabel} in</span>
      )}
      {inLabel !== null && outLabel !== null && <span className="text-ui/35"> &middot; </span>}
      {outLabel !== null && (
        <span className="text-ui/80">{outLabel} out</span>
      )}
    </p>
  );
};

// Generic platform-capability picker: a dropdown over enabled models matching the capability,
// Save/Clear, an invalid-saved-pick warning, a cost line; `extraOptions` adds free local entries.
interface ExtraOption {
  id: string;
  label: string;
  costLine?: React.ReactNode;
}
export const CapabilityModelCard = ({
  title,
  description,
  settingKey,
  capability,
  matchFn,
  selectorLabel,
  noModelsMessage,
  noSelectionMessage,
  models,
  extraOptions = [],
}: {
  title: string;
  description: string;
  settingKey: string;
  capability?: string;
  // When provided, picks matching models instead of the capability tag, so a card
  // can match e.g. "any text-capable model" rather than one tag.
  matchFn?: (m: Model) => boolean;
  selectorLabel: string;
  noModelsMessage: string;
  noSelectionMessage: string;
  models: Model[];
  extraOptions?: ExtraOption[];
}) => {
  const [selectedId, setSelectedId] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const toast = useToast();
  // A failed read is "could not load", not "no model chosen": Save and Clear write over the stored pick.
  const load = useGuardedLoad<string | null>(settingKey, async (key) => {
    const r = await api.getSetting(key);
    return r.ok ? { ok: true as const, data: r.data.value } : r;
  });
  const storedPick = load.data;

  const matchingModels = models.filter(m => m.isEnabled && (matchFn ? matchFn(m) : !!capability && m.capabilities.includes(capability)));
  const hasAnyOption = matchingModels.length > 0 || extraOptions.length > 0;

  useEffect(() => { if (load.status === 'ready') setSelectedId(storedPick ?? ''); }, [load.status, storedPick]);

  const handleSave = async () => {
    setSaving(true);
    const res = await api.setSetting(settingKey, selectedId);
    setSaving(false);
    if (!res.ok) { toast.error(res.error ?? 'The model could not be saved.'); return; }   // e.g. the memory-fit refusal
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClear = async () => {
    setSaving(true);
    const res = await api.setSetting(settingKey, '');
    setSaving(false);
    if (!res.ok) { toast.error(res.error ?? 'The model could not be cleared.'); return; }   // e.g. a memory-fit refusal
    setSelectedId('');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (load.status !== 'ready') return load.status === 'loading' ? <div className="tile loading-state">Loading...</div> : <div className="note--warn" style={{ color: 'var(--dojo3-rust)' }} role="alert">Could not load this model setting, so it can&apos;t be changed right now. Nothing has been changed.{' '}<button type="button" className="btn btn--ghost" onClick={load.reload}>Retry</button></div>;

  const isExtra = extraOptions.some(o => o.id === selectedId);
  const selectedModel = matchingModels.find(m => m.id === selectedId) ?? null;
  const configuredButInvalid = selectedId !== '' && !isExtra && !selectedModel;
  const selectedExtra = extraOptions.find(o => o.id === selectedId) ?? null;

  return (
    <div className="tile space-y-4">
      <div>
        <div className="scard__title">{title}</div>
        <p className="text-xs text-ui/40 mt-1">{description}</p>
      </div>

      {!hasAnyOption ? (
        <div className="alert-banner alert-warning">{noModelsMessage}</div>
      ) : !selectedId ? (
        <div className="alert-banner alert-warning">{noSelectionMessage}</div>
      ) : configuredButInvalid ? (
        <div className="alert-banner alert-warning">
          The saved model is no longer available. Pick a new one below.
        </div>
      ) : null}

      {hasAnyOption && (
        <>
          <div>
            <label className="flabel">{selectorLabel}</label>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="finput field--select"
            >
              <option value="">(none)</option>
              {extraOptions.length > 0 && (
                <optgroup label="Local">
                  {extraOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </optgroup>
              )}
              {matchingModels.length > 0 && (
                <optgroup label={extraOptions.length > 0 ? 'Cloud' : ''}>
                  {matchingModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.apiModelId})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {selectedExtra
              ? (selectedExtra.costLine ?? (
                  <p className="text-[11px] text-ui/55 mt-2">Cost: <span className="text-ui/80">Free</span> <span className="text-ui/35">(runs on this machine)</span></p>
                ))
              : <ModelCostLine model={selectedModel} />}
          </div>

          <div className="srow">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="btn btn--primary btn--sm"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            {selectedId && (
              <button
                type="button"
                onClick={handleClear}
                disabled={saving}
                className="btn btn--sm"
              >
                Clear
              </button>
            )}
            {saved && <span className="text-xs text-cp-teal">Saved!</span>}
          </div>
        </>
      )}
    </div>
  );
};

// Thin wrappers: each pins the generic card's title, description, setting key and capability;
// one card per capability, so a new one is a call site, not a copy.
export const FallbackVisionModelCard = ({ models }: { models: Model[] }) => (
  <CapabilityModelCard
    title="Fallback Vision Model"
    description="The model used to look at images when your agent's own model can't see."
    settingKey="dojo_fallback_vision_model_id"
    capability="vision"
    selectorLabel="Vision model"
    noModelsMessage="No vision-capable models are enabled. Enable one above and come back here to pick it."
    noSelectionMessage="No vision model selected. Pick one below."
    models={models}
  />
);

export const ImageGenModelCard = ({ models }: { models: Model[] }) => (
  <CapabilityModelCard
    title="Image Generation Model"
    description="The model used when an agent creates an image."
    settingKey="dojo_image_gen_model_id"
    capability="image_generation"
    selectorLabel="Image-gen model"
    noModelsMessage="No image-generation models are enabled. Enable one above and come back here to pick it."
    noSelectionMessage="No image-generation model selected. Pick one below."
    models={models}
  />
);

export const VideoGenModelCard = ({ models }: { models: Model[] }) => (
  <CapabilityModelCard
    title="Video Generation Model"
    description="The model used when an agent creates a video. Video can take a few minutes to generate."
    settingKey="dojo_video_gen_model_id"
    capability="video_generation"
    selectorLabel="Video-gen model"
    noModelsMessage="No video-generation models are enabled. Enable one above and come back here to pick it."
    noSelectionMessage="No video-generation model selected. Pick one below."
    models={models}
  />
);

export const AudioGenModelCard = ({ models }: { models: Model[] }) => (
  <CapabilityModelCard
    title="Text-to-Speech (TTS) Model"
    description="The model used to generate spoken-audio reads of text on request (the tts_create tool). Separate from the Voice tab, which is how you talk with the agent live. Music / sound-effect models have their own picker below."
    settingKey="dojo_audio_gen_model_id"
    capability="audio_generation"
    selectorLabel="TTS model"
    noModelsMessage="No TTS models are enabled. Enable one above and come back here to pick it. (Tip: untag music models from this capability via the Edit button on their row.)"
    noSelectionMessage="No TTS model selected. Pick one below."
    models={models}
  />
);

export const MusicGenModelCard = ({ models }: { models: Model[] }) => (
  <CapabilityModelCard
    title="Music Generation Model"
    description="The model used when an agent composes music or sound effects from a prompt. Different from TTS, which reads text aloud."
    settingKey="dojo_music_gen_model_id"
    capability="music_generation"
    selectorLabel="Music-gen model"
    noModelsMessage="No music-generation models are enabled. Enable one above (e.g. Google Lyria) and come back here to pick it."
    noSelectionMessage="No music-generation model selected. Pick one below."
    models={models}
  />
);

// Transcription offers two local engines (Whisper, Moonshine) outside the models
// table, free on this machine, via `extraOptions`.
export const TranscriptionModelCard = ({ models }: { models: Model[] }) => (
  <CapabilityModelCard
    title="Transcription Model"
    description="The model used when an agent converts audio to text. Local engines run on this machine."
    settingKey="dojo_transcription_model_id"
    capability="transcription"
    selectorLabel="Transcription model"
    noModelsMessage="Pick a local engine, or enable a transcription-capable cloud model above."
    noSelectionMessage="No transcription model selected. Pick one below."
    models={models}
    extraOptions={[
      { id: 'local:whisper', label: 'Whisper (local, via whisper.cpp)' },
      { id: 'local:moonshine', label: 'Moonshine (local, default)' },
    ]}
  />
);

type HealerCfg = Awaited<ReturnType<typeof api.getHealerConfig>> extends infer R ? (R extends { ok: true; data: infer D } ? D : never) : never;

export const HealerCard = ({ models }: { models: Model[] }) => {
  // Read before shown: a failed read must not look like the defaults (auto model, 04:00, active).
  // Save writes what is on screen, and could switch a Healer set to monitor or off back on.
  const load = useGuardedLoad<HealerCfg>('healer', () => api.getHealerConfig());
  if (load.status === 'loading') return <div className="tile loading-state">Loading...</div>;
  if (load.status === 'failed') return <div className="note--warn" style={{ color: 'var(--dojo3-rust)' }} role="alert">Could not load the Healer settings, so it can&apos;t be changed right now. Nothing has been changed.{' '}<button type="button" className="btn btn--ghost" onClick={load.reload}>Retry</button></div>;
  return <HealerEditor models={models} config={load.data!} refresh={load.refresh} />;
};

const HealerEditor = ({ models, config, refresh }: { models: Model[]; config: HealerCfg; refresh: () => Promise<void> }) => {
  const [healerModelId, setHealerModelId] = useState(config.modelId ?? '');
  const [healerTime, setHealerTime] = useState(config.healerTime);
  const [healerMode, setHealerMode] = useState<'active' | 'monitor'>(config.healerMode);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastDiagnostic, setLastDiagnostic] = useState<api.HealerDiagnostic | null>(null);
  const [sendingReport, setSendingReport] = useState(false);
  // provider-isolation flags, read with the config; the save path re-reads them for the banner.
  const providerSharedWithPrimary = config.providerSharedWithPrimary ?? false;
  const primaryProviderName = config.primaryProviderName ?? null;
  const toast = useToast();
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    api.getHealerDiagnostic().then((diagResult) => {
      if (diagResult.ok && diagResult.data) setLastDiagnostic(diagResult.data);
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const result = await api.updateHealerConfig({
      modelId: healerModelId || undefined,
      healerTime,
      healerMode,
    });
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      // reload so the provider-isolation banner reflects the new pick without a page refresh.
      await refresh();
    } else toast.error(result.error ?? 'The Healer settings could not be saved.');   // e.g. the 32K floor or the memory fit
    setSaving(false);
  };

  const handleRunNow = async () => {
    setRunning(true);
    const result = await api.triggerHealerRun();
    if (result.ok) {
      // Wait until the Healer finishes, matched BY CONFIGURED ID (never a name or a guess). No count: it
      // follows the Healer's own status until it is not working, or the card goes away.
      if (result.data.llmTriggered) {
        await loadEngineRoleIds();
        const healerAgentId = engineRoleId('healer');
        while (healerAgentId && mounted.current) {
          await new Promise(r => setTimeout(r, 5000));
          const agents = await api.getAgents();
          if (agents.ok && !agents.data.some((a: { id: string; status: string }) => a.id === healerAgentId && a.status === 'working')) break;
        }
      }
      const diagResult = await api.getHealerDiagnostic();
      if (diagResult.ok && diagResult.data) setLastDiagnostic(diagResult.data);
      toast.success('Healing cycle complete');
    } else {
      toast.error(result.error ?? 'Healing cycle failed');
    }
    setRunning(false);
  };

  const handleSendReport = async () => {
    setSendingReport(true);
    const result = await api.sendHealerReport();
    if (result.ok) {
      toast.success('Healer report sent and archived');
    } else if (result.error === 'NO_EMAIL_CONFIGURED') {
      toast.error('Nothing was sent. The report is emailed from the agent\'s own Google or Microsoft account, and none is connected. Connect one in Settings → Channels.');
    } else if (result.error === 'NO_OWNER_MAILBOX') {
      toast.error('Nothing was sent. The report is emailed to you, and none of your own Google or Microsoft accounts is connected. Connect one as yours in Settings → Channels.');
    } else {
      toast.error(result.error ?? 'Failed to send report');
    }
    setSendingReport(false);
  };


  return (
    <div className="tile space-y-4">
      <div>
        <div className="scard__title">Healing</div>
        <p className="text-xs text-ui/40 mt-1">
          The Healer agent analyzes daily health data, auto-fixes routine issues (stuck agents, orphaned tasks), and proposes solutions for complex problems. Proposals appear on the Vitals page for your approval.
        </p>
      </div>

      <div>
        <label className="flabel">Healer Model</label>
        <select
          value={healerModelId}
          onChange={(e) => setHealerModelId(e.target.value)}
          className="finput field--select"
        >
          <option value="">Auto (first available mid-tier model)</option>
          {models.filter(isListedAgentModel).map((m) => <AgentModelOption key={m.id} model={m} label={`${m.name} (${m.apiModelId})`} />)}
        </select>
        <p className="text-[10px] text-ui/25 mt-1">
          Mid-tier model recommended. Needs good reasoning but doesn't need to be frontier.
        </p>
        {/* The Healer's point is being on a different provider than the main agent,
            so it can still step in when the main provider goes down. */}
        {providerSharedWithPrimary && primaryProviderName && (
          <div className="mt-3 rounded-md border border-cp-amber/40 bg-cp-amber/10 px-3 py-2.5 text-xs text-cp-amber-light/90 leading-relaxed">
            <div className="font-medium mb-1 text-cp-amber-light">Heads up, both agents are using the same service</div>
            <div>
              Your main agent and your Healer agent are both using {primaryProviderName}. If {primaryProviderName} has a problem, both will stop working at the same time and there's nothing to step in and fix it. Pick a different model from a different service for one of them.
            </div>
          </div>
        )}
      </div>

      <div>
        <label className="flabel">Healing Time</label>
        <input
          type="time"
          value={healerTime}
          onChange={(e) => setHealerTime(e.target.value)}
          className="finput"
        />
        <div className="fhelp">
          When the Healer runs each day. Default: 4:00 AM (after the Dreamer).
        </div>
      </div>

      <div>
        <label className="flabel mb-2">Mode</label>
        <div className="space-y-2">
          {([
            { value: 'active' as const, label: 'Active', desc: 'Auto-fix routine issues + propose complex fixes for your approval' },
            { value: 'monitor' as const, label: 'Monitor', desc: 'Compile diagnostic report only, no fixes applied' },
          ]).map((option) => (
            <label key={option.value} className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="healerMode"
                value={option.value}
                checked={healerMode === option.value}
                onChange={() => setHealerMode(option.value)}
                className="mt-1 accent-cp-amber"
              />
              <div>
                <span className="text-sm text-ui/70">{option.label}</span>
                <p className="text-[10px] text-ui/25">{option.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="srow pt-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="btn btn--primary btn--sm"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={handleRunNow}
          disabled={running}
          className="btn btn--sm"
        >
          {running ? 'Running...' : 'Run Now'}
        </button>
        {saved && <span className="text-xs text-cp-teal">Saved!</span>}
      </div>

      <div>
        <button
          type="button"
          onClick={handleSendReport}
          disabled={sendingReport}
          className="btn btn--sm"
        >
          {sendingReport ? 'Sending...' : 'Send Healer Report'}
        </button>
        <p className="text-[10px] text-ui/25 mt-1">
          Emails a summary of everything the Healer has found and fixed, then starts a new log.
        </p>
      </div>

      {lastDiagnostic && (
        <div className="pt-2 border-t border-ui/[0.06]">
          <p className="text-[10px] text-ui/25 mb-1">
            Last cycle: {formatDate(lastDiagnostic.created_at)}
            {'-'}
            {lastDiagnostic.critical_count > 0 && <span className="text-cp-coral">{lastDiagnostic.critical_count} critical</span>}
            {lastDiagnostic.critical_count > 0 && lastDiagnostic.warning_count > 0 && ', '}
            {lastDiagnostic.warning_count > 0 && <span className="text-cp-amber">{lastDiagnostic.warning_count} warnings</span>}
            {(lastDiagnostic.critical_count > 0 || lastDiagnostic.warning_count > 0) && lastDiagnostic.info_count > 0 && ', '}
            {lastDiagnostic.info_count > 0 && <span className="text-ui/40">{lastDiagnostic.info_count} info</span>}
            {lastDiagnostic.critical_count === 0 && lastDiagnostic.warning_count === 0 && lastDiagnostic.info_count === 0 && <span className="text-cp-teal">All clear</span>}
          </p>
        </div>
      )}
    </div>
  );
};
