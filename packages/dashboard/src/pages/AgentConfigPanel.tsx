import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import type { AgentDetail as AgentDetailType, Model } from '@dojo/shared';
import * as api from '../lib/api';
import { useToast } from '../hooks/useToast';
import { AccessPanel } from '../components/AccessPanel';
import { useActiveAgent } from '../components/ActiveAgentProvider';
import { QuietTimeCard } from '../components/QuietTimeCard';
import { useGuardedLoad } from '../lib/load-guard';
import { AgentModelOption } from '../components/AgentModelOption';
import { isListedAgentModel } from '../lib/role-models';

// Agent config overlay. This is the element for the /agents/:id route and
// renders as a self-headered dojo3 panel (an overlay over the chat in the
// persistent stage), not a full page. It re-skins AgentDetail's ConfigTab
// logic onto the prototype settings-card primitives so the user can
// configure an agent without leaving the stage.
//
// The mounting contract matches the rebuilt Settings panel: first child is
// the .phead header, and no full-height / scroll / padding root is added -
// the stage panel (.dojo3-pbody) supplies padding, scrolling, and the
// floating close button.

// The .finput primitive is sized for single-line inputs (fixed height,
// 32px line-height). For the multi-row system-prompt textarea we override
// those so it grows with rows and wraps as a mono editor.
const TEXTAREA_STYLE: React.CSSProperties = {
  height: 'auto',
  minHeight: 240,
  lineHeight: 1.55,
  padding: '10px 12px',
  resize: 'vertical',
  fontFamily: 'var(--dojo3-font-mono)',
};

const CLASSIFICATION_LABELS: Record<string, string> = {
  sensei: 'Sensei',
  ronin: 'Ronin',
  apprentice: 'Apprentice',
};

// Equipped techniques live inside the Access panel (the same `TechniqueSelector` and
// `updateAgentConfig({equippedTechniques})`), so one field has one control.
//
// The permission toggles are rows two and five of the Access panel, "What it can reach" and
// "What it may manage". They write the same `permissions` blob, `tools_policy` column and
// `config.shareUserProfile` through the same PUT.
//
// A platform agent's manifest is not editable here. That rule rides one prop
// (`manifestEditable`), decided HERE from the sensei classification (the dojo's built-in
// agents), so the panel never has to classify an agent to draw itself.

// ── Memory card ──
//
// The Dreamer-ignore toggle. When on, the vault archive layer skips this
// agent entirely - Dreamer never extracts memories from its conversations.
const MemoryCard = ({ agent, onUpdated }: { agent: AgentDetailType; onUpdated: () => void }) => {
  const [enabled, setEnabled] = useState(agent.dreamerIgnore === true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => { setEnabled(agent.dreamerIgnore === true); }, [agent.dreamerIgnore]);

  const toggle = async () => {
    if (saving) return;
    const next = !enabled;
    setSaving(true);
    setEnabled(next);
    const result = await api.updateAgentConfig(agent.id, { dreamerIgnore: next });
    setSaving(false);
    if (result.ok) {
      toast.success(next ? 'Skipping Dreamer cycle' : 'Dreamer cycle re-enabled');
      onUpdated();
    } else {
      setEnabled(!next);
      toast.error(result.error || 'Could not update memory setting.');
    }
  };

  return (
    <div className="tile">
      <div className="scard__title">Memory</div>
      <div className="scard__desc">
        When on, this agent's conversations are NOT archived for the Dreamer to process. Useful for
        ephemeral test agents and any agent whose chatter you don't want extracted into long-term memory.
        The agent's own memory and chat history are unaffected.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
        <label className="flabel" style={{ marginBottom: 0 }}>Skip in Dreamer cycle</label>
        <button
          type="button"
          aria-pressed={enabled}
          onClick={toggle}
          disabled={saving}
          className={`switch ${enabled ? 'is-on' : ''}`}
        />
      </div>
    </div>
  );
};

// ── Config body ──
//
// Loaded once the agent is available. Holds the card stack and reuses the
// state / handlers / API calls from AgentDetail's ConfigTab.
const ConfigBody = ({ agent, onUpdated }: { agent: AgentDetailType; onUpdated: () => void }) => {
  const toast = useToast();
  // `isSensei` is the CLASSIFICATION, which many agents carry while exactly one is the
  // primary. Claims about "the primary agent" must key off `primaryId`, which comes from
  // the platform through the provider the agent card already uses.
  const isSensei = agent.classification === 'sensei';
  const { primaryId } = useActiveAgent();
  const isThisPrimary = primaryId != null && agent.id === primaryId;

  const [models, setModels] = useState<Model[]>([]);
  const [providerNameById, setProviderNameById] = useState<Record<string, string>>({});
  const [systemPrompt, setSystemPrompt] = useState('');
  const [promptTouched, setPromptTouched] = useState(false);
  const [promptSaveFailed, setPromptSaveFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listsFailed, setListsFailed] = useState(false);
  const [listsTry, setListsTry] = useState(0);
  // The prompt is saved whole (for the primary agent it is SOUL.md): it may only be saved on top of a
  // prompt that was successfully read for THIS agent (lib/load-guard.ts).
  const promptLoad = useGuardedLoad<string>(agent.id, async (id) => {
    const r = await api.getAgentSystemPrompt(id);
    return r.ok ? { ok: true as const, data: r.data.content } : r;
  });
  const loadedPrompt = promptLoad.loadedKey === agent.id ? promptLoad.data : null;
  useEffect(() => {
    if (loadedPrompt !== null) { setSystemPrompt(loadedPrompt); setPromptTouched(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptLoad.settled]);   // each settled read replaces the draft (a save that fails never triggers one)

  const [editedName, setEditedName] = useState(agent.name);
  const [selectedModelId, setSelectedModelId] = useState(
    agent.modelId === 'auto' ? 'auto' : (agent.modelId ?? ''),
  );

  useEffect(() => {
    const load = async () => {
      const [modelsResult, providersResult] = await Promise.all([
        api.getModels(),
        api.getProviders(),
      ]);
      if (modelsResult.ok) setModels(modelsResult.data.filter(isListedAgentModel));
      if (providersResult.ok) {
        const map: Record<string, string> = {};
        for (const p of providersResult.data) map[p.id] = p.name;
        setProviderNameById(map);
      }
      setListsFailed(!modelsResult.ok || !providersResult.ok);
      setLoading(false);
    };
    load();
  }, [agent.id, listsTry]);

  const saveName = async () => {
    const trimmed = editedName.trim();
    if (!trimmed || trimmed === agent.name) return;
    const result = await api.updateAgentConfig(agent.id, { name: trimmed } as Record<string, unknown>);
    if (result.ok) {
      toast.success('Name updated');
      onUpdated();
    } else {
      toast.error(result.error || 'Could not update name.');
    }
  };

  const saveModel = async () => {
    if (!selectedModelId) return;
    const result = await api.updateAgentConfig(agent.id, { modelId: selectedModelId });
    if (result.ok) { toast.success('Model updated'); onUpdated(); }
    else { toast.error(result.error || 'Could not update model.'); }
  };

  const saveClassification = async (value: string) => {
    const result = await api.updateAgentConfig(agent.id, { classification: value } as Record<string, unknown>);
    if (result.ok) { toast.success('Classification updated'); onUpdated(); }
    else { toast.error(result.error || 'Could not update classification.'); }
  };

  const saveSystemPrompt = async () => {
    // Never send a prompt that was not read for this agent, and never a blank the owner did not type.
    if (!promptLoad.canSave(agent.id) || loadedPrompt === null) return;
    if (!promptTouched && !systemPrompt.trim()) return;
    const result = await api.updateAgentConfig(agent.id, { systemPrompt, systemPromptBase: loadedPrompt });
    if (result.ok) { promptLoad.adopt(systemPrompt); setPromptSaveFailed(false); toast.success('System prompt saved'); onUpdated(); }
    else {
      // What the owner typed stays in the editor. The saved version loads only if he asks for it.
      toast.error(result.error || 'Could not save system prompt.');
      setPromptSaveFailed(true);
    }
  };

  if (loading) {
    return <div className="stub"><p className="stub__line">Loading config...</p></div>;
  }

  const modelDirty = selectedModelId !== (agent.modelId === 'auto' ? 'auto' : (agent.modelId ?? ''));

  return (
    <>
    {/* ── ACCESS ──
        Full width rather than a masonry sibling: one row alone is 38 checkboxes,
        and a 310px column would make the owner's most consequential card the
        hardest one to read. Everything else keeps its column. */}
    <div style={{ maxWidth: '56rem', marginBottom: 14 }}>
      <AccessPanel
        agent={agent}
        onUpdated={onUpdated}
        manifestEditable={!isSensei}
        manifestNote={isThisPrimary
          ? 'This is your main agent. It already has full access to your files, commands and system controls, and that is not changed from here.'
          : 'This is one of the dojo’s built-in agents. Its file, command and system-control settings are set by the dojo and are not changed from here.'}
      />
    </div>

    <div className="scards">
      {/* Name */}
      <div className="tile">
        <div className="scard__title">Name</div>
        <div className="scard__desc">The agent's display name across the dojo.</div>
        <div className="srow">
          <input
            className="finput"
            style={{ flex: 1, width: 'auto' }}
            value={editedName}
            onChange={(e) => setEditedName(e.target.value)}
          />
          <button
            type="button"
            onClick={saveName}
            disabled={!editedName.trim() || editedName.trim() === agent.name}
            className="btn btn--sm"
          >
            Save
          </button>
        </div>
        {isSensei && (
          <div className="fhelp">Changing a Sensei's name updates the platform config.</div>
        )}
      </div>

      {/* Model */}
      <div className="tile">
        <div className="scard__title">Model</div>
        <div className="scard__desc">
          Current:{' '}
          {agent.modelId === 'auto' ? 'Auto (Smart Router)' : (agent.model?.name || 'None')}
        </div>
        {listsFailed && (
          <div className="fhelp">
            Could not load the model list.{' '}
            <button type="button" className="btn btn--sm" onClick={() => setListsTry((n) => n + 1)}>Retry</button>
          </div>
        )}
        <label className="flabel">Model</label>
        <div className="srow">
          <select
            className="finput field--select"
            // minWidth 0: a flex child refuses to shrink below its intrinsic
            // min-content width, and long model names ("Vendor: Model (Provider)")
            // made the select overflow the card's right edge and push Save out.
            style={{ flex: 1, width: 'auto', minWidth: 0 }}
            value={selectedModelId}
            onChange={(e) => setSelectedModelId(e.target.value)}
          >
            <option value="">No model selected</option>
            <option value="auto">Auto (Smart Router)</option>
            {models.map((m) => <AgentModelOption key={m.id} model={m} label={`${m.name}${providerNameById[m.providerId] ? ` (${providerNameById[m.providerId]})` : ''}`} />)}
          </select>
          <button
            type="button"
            onClick={saveModel}
            disabled={!modelDirty || !selectedModelId}
            className="btn btn--sm"
          >
            Save
          </button>
        </div>
      </div>

      {/* Classification */}
      <div className="tile">
        <div className="scard__title">Classification</div>
        {isSensei ? (
          <>
            <div className="scard__desc">
              A Sensei's classification is locked. Cannot be dismissed or deleted. Set programmatically.
            </div>
            <span className="pill pill--draft"><i className="dot" />Sensei (locked)</span>
          </>
        ) : (
          <>
            <div className="scard__desc">
              {agent.classification === 'ronin'
                ? 'Persists across restarts. Only you can dismiss from the dashboard.'
                : 'Can be dismissed by other agents. Subject to timeouts.'}
            </div>
            <label className="flabel">Rank</label>
            <select
              className="finput field--select"
              value={agent.classification}
              onChange={(e) => saveClassification(e.target.value)}
            >
              <option value="apprentice">{CLASSIFICATION_LABELS.apprentice}</option>
              <option value="ronin">{CLASSIFICATION_LABELS.ronin}</option>
            </select>
          </>
        )}
      </div>

      {/* System Prompt */}
      <div className="tile">
        <div className="scard__title">
          System Prompt{isThisPrimary ? ' (SOUL.md)' : ''}
        </div>
        <div className="scard__desc">
          {isThisPrimary
            ? "The primary agent's soul. Edits here rewrite SOUL.md."
            : isSensei
              ? "This Sensei's stored soul. Edits here rewrite the file the model actually reads."
              : 'Instructions that shape how this agent behaves.'}
        </div>
        {promptLoad.status === 'failed' ? (
          <>
            <div className="fhelp">Could not load this agent’s prompt, so it can’t be edited right now. The saved prompt has not been changed.</div>
            <div className="srow" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
              <button type="button" onClick={promptLoad.reload} className="btn btn--sm">Retry</button>
            </div>
          </>
        ) : promptLoad.status === 'loading' ? (
          <div className="fhelp">Loading the prompt...</div>
        ) : (
          <>
            <textarea
              className="finput"
              style={TEXTAREA_STYLE}
              value={systemPrompt}
              onChange={(e) => { setSystemPrompt(e.target.value); setPromptTouched(true); }}
              rows={12}
              spellCheck={false}
            />
            <div className="srow" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
              {promptSaveFailed && (
                <button type="button" onClick={() => { setPromptSaveFailed(false); promptLoad.reload(); }} className="btn btn--sm">
                  Load the saved version
                </button>
              )}
              <button type="button" onClick={saveSystemPrompt} className="btn btn--sm">
                Save Prompt
              </button>
            </div>
          </>
        )}
      </div>

      {/* Memory. The main agent always dreams, so it has no Skip-in-Dreamer toggle. */}
      {!isThisPrimary && <MemoryCard agent={agent} onUpdated={onUpdated} />}
      <QuietTimeCard agent={agent} onUpdated={onUpdated} />
    </div>
    </>
  );
};

// Keyed by id: the route reuses one element for every agent, so each agent gets a fresh panel
// and a late answer for the agent you left lands in a panel that is gone.
export const AgentConfigPanel = () => {
  const { id } = useParams<{ id: string }>();
  return <AgentConfigFor key={id} id={id} />;
};

const AgentConfigFor = ({ id }: { id: string | undefined }) => {
  const [agent, setAgent] = useState<AgentDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAgent = useCallback(async () => {
    if (!id) return;
    const result = await api.getAgent(id);
    if (result.ok) {
      setAgent(result.data);
      setError(null);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    loadAgent();
  }, [loadAgent]);

  const metaLabel = agent
    ? `${CLASSIFICATION_LABELS[agent.classification] ?? 'Agent'} config`
    : 'Agent config';

  return (
    <>
      <header className="phead">
        <h2 className="phead__title">{agent?.name ?? 'Agent'}</h2>
        <span className="phead__meta">{metaLabel}</span>
      </header>

      {loading && (
        <div className="stub"><p className="stub__line">Loading agent...</p></div>
      )}

      {!loading && (error || !agent) && (
        <div className="stub"><p className="stub__line">{error || 'Agent not found.'}</p></div>
      )}

      {!loading && agent && (
        <ConfigBody agent={agent} onUpdated={loadAgent} />
      )}
    </>
  );
};
