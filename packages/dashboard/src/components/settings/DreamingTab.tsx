// ── Settings → The Sensei (dreaming) tab. The Healer card it renders is shared with the Models tab and
// lives in `CapabilityModelCards.tsx`.
//
// Lifted OUT of `pages/Settings.tsx` by t111-E1. The moved lines are VERBATIM; the only new
// bytes are this header, the imports below and the `export` keyword(s).

import { useState, useEffect } from 'react';
import type { Model } from '@dojo/shared';
import * as api from '../../lib/api';
import { formatDate } from '../../lib/dates';
import { HealerCard } from './CapabilityModelCards';
import { isPickableAgentModel } from '../../lib/role-models';
import { useGuardedLoad } from '../../lib/load-guard';
import { LoadGate } from '../LoadGate';


// ── Dreaming Tab ──

type DreamingConfig = Awaited<ReturnType<typeof api.getDreamingConfig>> extends infer R ? (R extends { ok: true; data: infer D } ? D : never) : never;

export const DreamingTab = () => {
  // The schedule is read before it is shown: a failed read must not appear as 03:00 / full, because Save
  // writes whatever is on screen over the real schedule.
  const load = useGuardedLoad<DreamingConfig>('dreaming', () => api.getDreamingConfig());
  return <LoadGate load={load} what="the dreaming settings"><DreamingEditor initial={load.data!} /></LoadGate>;
};

const DreamingEditor = ({ initial }: { initial: DreamingConfig }) => {
  const [models, setModels] = useState<Model[]>([]);
  const [dreamModelId, setDreamModelId] = useState(initial.modelId ?? '');
  const [dreamTime, setDreamTime] = useState(initial.dreamTime);
  const [dreamMode, setDreamMode] = useState<'full' | 'light' | 'off'>(initial.dreamMode);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);   // v3.5: the server's refusal, shown
  const [lastDream, setLastDream] = useState<api.DreamReport | null>(null);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<{ kind: 'ok' | 'err' | 'idle'; message: string }>({ kind: 'idle', message: '' });

  useEffect(() => {
    const load = async () => {
      const [modelsResult, latestResult] = await Promise.all([api.getModels(), api.getLatestDream()]);
      if (modelsResult.ok) setModels(modelsResult.data.filter(isPickableAgentModel));
      if (latestResult.ok) setLastDream(latestResult.data);
    };
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const result = await api.updateDreamingConfig({
      modelId: dreamModelId || undefined,
      dreamTime,
      dreamMode,
    });
    setSaveError(result.ok ? null : result.error);
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setSaving(false);
  };

  const handleRunNow = async () => {
    if (running) return;
    if (!confirm('Start a Dreamer cycle now? It will process all unprocessed conversation archives.')) return;
    setRunning(true);
    setRunStatus({ kind: 'idle', message: '' });
    const result = await api.triggerDream();
    if (result.ok) {
      setRunStatus({ kind: 'ok', message: result.data.message });
    } else {
      setRunStatus({ kind: 'err', message: result.error || 'Failed to start Dreamer.' });
    }
    setRunning(false);
    setTimeout(() => setRunStatus({ kind: 'idle', message: '' }), 6000);
  };

  return (
    <div className="max-w-4xl">
      <div className="scards">
      <div className="tile space-y-4">
        <div>
          <div className="scard__title">Dreaming</div>
          <p className="text-xs text-ui/40 mt-1">
            Configure how the dojo processes its daily conversations into long-term memories overnight. A temporary "Dreamer" agent is spawned to do the work -- it uses the tracker, extracts knowledge, and dismisses itself when done.
          </p>
        </div>

        <div>
          <label className="flabel">Dreamer Model</label>
          <select
            value={dreamModelId}
            onChange={(e) => setDreamModelId(e.target.value)}
            className="finput field--select"
          >
            <option value="">Auto (first available Standard tier model)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.apiModelId})
              </option>
            ))}
          </select>
          <div className="fhelp">
            The model the Dreamer agent uses. Standard tier recommended for good extraction quality at reasonable cost.
          </div>
        </div>

        <div>
          <label className="flabel">Dream Time</label>
          <input
            type="time"
            value={dreamTime}
            onChange={(e) => setDreamTime(e.target.value)}
            className="finput"
          />
          <div className="fhelp">
            When the Dreamer agent wakes up to process the day's conversations. Default: 3:00 AM.
          </div>
        </div>

        <div>
          <label className="flabel mb-2">Dream Mode</label>
          <div className="space-y-2">
            {([
              { value: 'full', label: 'Full Dream', desc: 'Extract memories + identify technique candidates + vault maintenance' },
              { value: 'light', label: 'Light Dream', desc: 'Extract memories + vault maintenance only, no technique identification' },
              { value: 'off', label: 'Off', desc: 'Do not run the nightly dream' },
            ] as const).map((option) => (
              <label key={option.value} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="dreamMode"
                  value={option.value}
                  checked={dreamMode === option.value}
                  onChange={() => setDreamMode(option.value)}
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

        {dreamMode === 'off' && (
          <p className="text-[10px] text-ui/25">Dreaming is off; these apply when you turn it back on.</p>
        )}

        <div className="srow pt-2 flex-wrap">
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
            title="Wake the Dreamer now to process unprocessed archives"
          >
            {running ? 'Starting...' : 'Run Now'}
          </button>
          {saved && <span className="text-xs text-cp-teal">Saved!</span>}
          {runStatus.kind === 'ok' && <span className="text-xs text-cp-teal">{runStatus.message}</span>}
          {runStatus.kind === 'err' && <span className="text-xs text-cp-coral">{runStatus.message}</span>}
        </div>
        {saveError && <div className="alert-banner alert-error">{saveError}</div>}

        {/* Last dream report — lives inside the Dreamer panel, not its own card. */}
        {lastDream && (
          <div className="border-t border-ui/[0.06] pt-3 space-y-2">
            <div className="flabel">Last Dream</div>
            <p className="text-[10px] text-ui/25">
              {formatDate(lastDream.createdAt)}
              {lastDream.durationMs && ` (${(lastDream.durationMs / 1000).toFixed(1)}s)`}
            </p>
            <pre className="text-xs text-ui/55 whitespace-pre-wrap font-mono bg-ui/[0.03] rounded p-2">
              {lastDream.reportText ?? 'No report text available'}
            </pre>
          </div>
        )}
      </div>

      {/* Healer card — self-healing sensei */}
      <HealerCard models={models} />
      </div>
    </div>
  );
};
