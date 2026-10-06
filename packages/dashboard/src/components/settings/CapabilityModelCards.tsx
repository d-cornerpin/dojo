// ── Settings → The platform-wide capability model cards — the SECOND shared seam.
//
// Two renderers: the Models tab lists the platform-wide picks, and the Sensei tab renders the
// Healer card beside its own controls. They belong to neither tab, so they are imported by
// both. Their private price formatters travel with them; every call site is here.
//
// Lifted OUT of `pages/Settings.tsx` by t111-E1. The moved lines are VERBATIM; the only new
// bytes are this header, the imports below and the `export` keyword(s).

import { useState, useEffect } from 'react';
import type { Model } from '@dojo/shared';
import * as api from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { formatDate } from '../../lib/dates';


// ── Fallback Vision Model Card ──
//
// Single platform-wide choice: which vision-capable model handles
// vision work when the calling agent's own model can't see. Used by
// screen_read, web_browse screenshots, and anywhere else the engine
// needs to route an image through a vision model. Replaces the old
// per-tool "cheapest vision-ish enabled model" auto-pick.

// Self-contained: loads its own model list since it lives on the Dojo
// tab, which doesn't otherwise need the model catalog. Keeps this card
// Small cost display rendered below a model dropdown. Tri-state per
// unit field:
//   number > 0 → formatted "$X / <unit>"
//   exactly 0 → "Free"
//   null      → unknown (line collapses to a quiet hint when nothing
//               is known about pricing)
const formatTokenPrice = (n: number | null): string | null => {
  if (n === null || typeof n !== 'number') return null;
  if (n === 0) return 'Free';
  return `$${n}/M`;
};

// Per-unit formatting for the non-token pricing units. Returns null
// when the value is null or invalid. Returns the literal "Free" when
// zero. Character pricing displays per-thousand (rates are tiny,
// per-character would render as fractions of a cent).
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

  // Non-token units: read costPerUnit (falls back to costPerMegapixel
  // during the v2.11.0 compat window for image-gen rows added pre-061).
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

// Generic platform-capability model picker card. Same shape every
// picker has: a dropdown over enabled-and-capability-matching models,
// a Save / Clear button, a configured-but-invalid warning, and a
// ModelCostLine under the dropdown.
//
// `extraOptions` lets a caller inject pseudo entries that aren't in
// the models table (used by the transcription card to expose
// `local:whisper` and `local:moonshine`). When one of those is
// selected, the picker calls `renderExtraCostLine` for the cost
// display instead of ModelCostLine.
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
  // When provided, used to pick matching models instead of capability.includes —
  // lets a card match e.g. "any text-capable model" rather than one tag.
  matchFn?: (m: Model) => boolean;
  selectorLabel: string;
  noModelsMessage: string;
  noSelectionMessage: string;
  models: Model[];
  extraOptions?: ExtraOption[];
}) => {
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const matchingModels = models.filter(m => m.isEnabled && (matchFn ? matchFn(m) : !!capability && m.capabilities.includes(capability)));
  const hasAnyOption = matchingModels.length > 0 || extraOptions.length > 0;

  useEffect(() => {
    const load = async () => {
      const settingResult = await api.getSetting(settingKey);
      if (settingResult.ok && settingResult.data.value) setSelectedId(settingResult.data.value);
      setLoading(false);
    };
    load();
  }, [settingKey]);

  const handleSave = async () => {
    setSaving(true);
    await api.setSetting(settingKey, selectedId);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClear = async () => {
    setSaving(true);
    await api.setSetting(settingKey, '');
    setSelectedId('');
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (loading) return null;

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

// Thin wrappers around CapabilityModelCard. Each gives the generic
// component its title, description, setting key, and capability flag.
// The two existing cards (vision + image gen) replace ~120 lines each
// of nearly identical boilerplate; the three new cards (video, audio
// gen, transcription) come online for free.
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

// Transcription is special: it exposes two local engines (Whisper,
// Moonshine) that don't live in the models table. Those surface
// through the extraOptions prop as `local:whisper` and
// `local:moonshine` and run on this machine for free.
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

// The model that writes memory summaries when an agent compacts. Any text model
// works — explicitly excludes image/video/music/embedding models, which can't
// produce text. Leaving it unset uses the cheapest text-capable model.
export const CompactionModelCard = ({ models }: { models: Model[] }) => (
  <CapabilityModelCard
    title="Summarization Model"
    description="Writes memory summaries when an agent compacts its history. Summaries are bulk work, so a cheap, fast text model is ideal. Leave unset to auto-pick the cheapest text-capable model."
    settingKey="compaction_model_id"
    matchFn={(m) => !m.capabilities.some((c) => c.includes('generation') || c === 'embedding')}
    selectorLabel="Summarization model"
    noModelsMessage="No text-capable models are enabled. Enable a chat model above and come back here to pick it."
    noSelectionMessage="Using the default: the cheapest enabled text-capable model. Pick one to set it explicitly."
    models={models}
  />
);


export const HealerCard = ({ models }: { models: Model[] }) => {
  const [healerModelId, setHealerModelId] = useState('');
  const [healerTime, setHealerTime] = useState('04:00');
  const [healerMode, setHealerMode] = useState<'active' | 'monitor' | 'off'>('active');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastDiagnostic, setLastDiagnostic] = useState<api.HealerDiagnostic | null>(null);
  const [sendingReport, setSendingReport] = useState(false);
  // v2.3.19 — provider-isolation surface from the API
  const [providerSharedWithPrimary, setProviderSharedWithPrimary] = useState(false);
  const [primaryProviderName, setPrimaryProviderName] = useState<string | null>(null);
  const [healerProviderName, setHealerProviderName] = useState<string | null>(null);
  const toast = useToast();

  const reloadConfig = async () => {
    const configResult = await api.getHealerConfig();
    if (configResult.ok) {
      setHealerModelId(configResult.data.modelId ?? '');
      setHealerTime(configResult.data.healerTime);
      setHealerMode(configResult.data.healerMode);
      setProviderSharedWithPrimary(configResult.data.providerSharedWithPrimary ?? false);
      setPrimaryProviderName(configResult.data.primaryProviderName ?? null);
      setHealerProviderName(configResult.data.healerProviderName ?? null);
    }
  };

  useEffect(() => {
    const load = async () => {
      const [, diagResult] = await Promise.all([
        reloadConfig(),
        api.getHealerDiagnostic(),
      ]);
      if (diagResult.ok && diagResult.data) {
        setLastDiagnostic(diagResult.data);
      }
      setLoading(false);
    };
    load();
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
      // v2.3.19 — reload so the provider-isolation banner reflects the new
      // model selection without requiring a page refresh.
      await reloadConfig();
    }
    setSaving(false);
  };

  const handleRunNow = async () => {
    setRunning(true);
    const result = await api.triggerHealerRun();
    if (result.ok) {
      // Poll until the Healer finishes, matched BY CONFIGURED ID and never by display name (2026-09-26 owner rule).
      if (result.data.llmTriggered) {
        const healerAgentId = await api.getSetting('healer_agent_id').then(r => (r.ok && r.data.value ? r.data.value : 'healer'));
        const pollForCompletion = async () => {
          for (let i = 0; i < 60; i++) { // Poll for up to 5 minutes
            await new Promise(r => setTimeout(r, 5000));
            const agents = await api.getAgents();
            if (agents.ok) {
              const healer = agents.data.find((a: { id: string; status: string }) => a.id === healerAgentId && a.status === 'working');
              if (!healer) break; // the Healer finished or was terminated
            }
          }
        };
        await pollForCompletion();
      }
      // Refresh diagnostic
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
      toast.error('You need to connect a Google or Microsoft email account in Integrations before you can send Healer Reports.');
    } else if (result.error === 'NO_REPORT_RECIPIENT') {
      toast.error('No Healer Report recipient is configured. Set healer_report_recipient in the config table before sending.');
    } else {
      toast.error(result.error ?? 'Failed to send report');
    }
    setSendingReport(false);
  };

  if (loading) return <div className="tile loading-state">Loading...</div>;

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
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.apiModelId})
            </option>
          ))}
        </select>
        <p className="text-[10px] text-ui/25 mt-1">
          Mid-tier model recommended. Needs good reasoning but doesn't need to be frontier.
        </p>
        {/* v2.3.19 — provider-isolation warning. The Healer's whole point is
            being on a DIFFERENT provider from the main agent so it can step
            in when the main provider goes down. Same provider = no backup. */}
        {providerSharedWithPrimary && primaryProviderName && (
          <div className="mt-3 rounded-md border border-cp-amber/40 bg-cp-amber/10 px-3 py-2.5 text-xs text-cp-amber-light/90 leading-relaxed">
            <div className="font-medium mb-1 text-cp-amber-light">Heads up — both agents are using the same service</div>
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
            { value: 'off' as const, label: 'Off', desc: 'Healer disabled' },
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
          disabled={running || healerMode === 'off'}
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
            {' — '}
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
