import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import type { AgentDetail as AgentDetailType, Model, PermissionManifest } from '@dojo/shared';
import * as api from '../lib/api';
import { useToast } from '../hooks/useToast';
import { PermissionsEditor } from '../components/PermissionsEditor';
import { TechniqueSelector } from '../components/TechniqueSelector';

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

// ── Equipped Techniques card ──
//
// Mirrors AgentDetail's EquippedTechniquesSection: TechniqueSelector saves
// on change via updateAgentConfig({ equippedTechniques }).
const EquippedTechniquesCard = ({ agent, onUpdated }: { agent: AgentDetailType; onUpdated: () => void }) => {
  const [equipped, setEquipped] = useState<string[]>(agent.equippedTechniques ?? []);
  const toast = useToast();

  useEffect(() => {
    setEquipped(agent.equippedTechniques ?? []);
  }, [agent.equippedTechniques]);

  const handleChange = async (updated: string[]) => {
    setEquipped(updated);
    const result = await api.updateAgentConfig(agent.id, { equippedTechniques: updated } as Record<string, unknown>);
    if (result.ok) {
      toast.success('Techniques updated');
      onUpdated();
    }
  };

  return (
    <div className="tile">
      <div className="scard__title">Equipped Techniques</div>
      <div className="scard__desc">Skills this agent can draw on. Changes save immediately.</div>
      <TechniqueSelector selected={equipped} onChange={handleChange} />
    </div>
  );
};

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
  const isPrimary = agent.classification === 'sensei';

  const [models, setModels] = useState<Model[]>([]);
  const [providerNameById, setProviderNameById] = useState<Record<string, string>>({});
  const [systemPrompt, setSystemPrompt] = useState('');
  const [loading, setLoading] = useState(true);

  const [editedName, setEditedName] = useState(agent.name);
  const [selectedModelId, setSelectedModelId] = useState(
    agent.modelId === 'auto' ? 'auto' : (agent.modelId ?? ''),
  );

  const [editedPerms, setEditedPerms] = useState<Partial<PermissionManifest>>(
    agent.permissions as Partial<PermissionManifest>,
  );
  const [editedToolsPolicy, setEditedToolsPolicy] = useState<{ allow: string[]; deny: string[] }>(
    (agent.toolsPolicy as { allow: string[]; deny: string[] }) ?? { allow: [], deny: [] },
  );
  const [editedShareProfile, setEditedShareProfile] = useState<boolean>(
    (agent.config as Record<string, unknown>)?.shareUserProfile === true,
  );

  useEffect(() => {
    const load = async () => {
      const [promptResult, modelsResult, providersResult] = await Promise.all([
        api.getAgentSystemPrompt(agent.id),
        api.getModels(),
        api.getProviders(),
      ]);
      if (promptResult.ok) setSystemPrompt(promptResult.data.content);
      if (modelsResult.ok) setModels(modelsResult.data.filter((m: Model) => m.isEnabled));
      if (providersResult.ok) {
        const map: Record<string, string> = {};
        for (const p of providersResult.data) map[p.id] = p.name;
        setProviderNameById(map);
      }
      setLoading(false);
    };
    load();
  }, [agent.id]);

  const saveName = async () => {
    const trimmed = editedName.trim();
    if (!trimmed || trimmed === agent.name) return;
    const result = await api.updateAgentConfig(agent.id, { name: trimmed } as Record<string, unknown>);
    if (result.ok) {
      // For sensei agents, also update the platform config setting so the
      // primary / PM / trainer name shown elsewhere stays in sync.
      if (agent.classification === 'sensei') {
        const primaryResult = await api.getSetting('primary_agent_id');
        const pmResult = await api.getSetting('pm_agent_id');
        const trainerResult = await api.getSetting('trainer_agent_id');

        if (primaryResult.ok && primaryResult.data.value === agent.id) {
          await api.setSetting('primary_agent_name', trimmed);
        } else if (pmResult.ok && pmResult.data.value === agent.id) {
          await api.setSetting('pm_agent_name', trimmed);
        } else if (trainerResult.ok && trainerResult.data.value === agent.id) {
          await api.setSetting('trainer_agent_name', trimmed);
        }
      }
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
    const result = await api.updateAgentConfig(agent.id, { systemPrompt });
    if (result.ok) { toast.success('System prompt saved'); onUpdated(); }
    else { toast.error(result.error || 'Could not save system prompt.'); }
  };

  const handlePermsChange = (
    perms: Partial<PermissionManifest>,
    tools: { allow: string[]; deny: string[] },
    shareProfile: boolean,
  ) => {
    setEditedPerms(perms);
    setEditedToolsPolicy(tools);
    setEditedShareProfile(shareProfile);
  };

  const savePermissions = async () => {
    const existingConfig = (agent.config as Record<string, unknown>) ?? {};
    const updatedConfig = { ...existingConfig, shareUserProfile: editedShareProfile };
    const result = await api.updateAgentConfig(agent.id, {
      permissions: editedPerms as Record<string, unknown>,
      toolsPolicy: editedToolsPolicy,
      config: updatedConfig,
    } as Record<string, unknown>);
    if (result.ok) { toast.success('Permissions saved'); onUpdated(); }
    else { toast.error(result.error || 'Could not save permissions.'); }
  };

  if (loading) {
    return <div className="stub"><p className="stub__line">Loading config...</p></div>;
  }

  const modelDirty = selectedModelId !== (agent.modelId === 'auto' ? 'auto' : (agent.modelId ?? ''));

  return (
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
        {isPrimary && (
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
        <label className="flabel">Model</label>
        <div className="srow">
          <select
            className="finput field--select"
            style={{ flex: 1, width: 'auto' }}
            value={selectedModelId}
            onChange={(e) => setSelectedModelId(e.target.value)}
          >
            <option value="">No model selected</option>
            <option value="auto">Auto (Smart Router)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {providerNameById[m.providerId] ? ` (${providerNameById[m.providerId]})` : ''}
              </option>
            ))}
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
        {isPrimary ? (
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

      {/* Equipped Techniques */}
      <EquippedTechniquesCard agent={agent} onUpdated={onUpdated} />

      {/* System Prompt */}
      <div className="tile">
        <div className="scard__title">
          System Prompt{isPrimary ? ' (SOUL.md)' : ''}
        </div>
        <div className="scard__desc">
          {isPrimary
            ? "The primary agent's soul. Edits here rewrite SOUL.md."
            : 'Instructions that shape how this agent behaves.'}
        </div>
        <textarea
          className="finput"
          style={TEXTAREA_STYLE}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={12}
          spellCheck={false}
        />
        <div className="srow" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button type="button" onClick={saveSystemPrompt} className="btn btn--sm">
            Save Prompt
          </button>
        </div>
      </div>

      {/* Memory */}
      <MemoryCard agent={agent} onUpdated={onUpdated} />

      {/* Permissions */}
      <div className="tile">
        <div className="scard__title">Permissions</div>
        {isPrimary ? (
          <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal', marginBottom: 0 }}>
            This Sensei agent has full access to all files, commands, tools, and system controls.
          </div>
        ) : (
          <>
            <div className="scard__desc">What this agent is allowed to touch. Save to apply.</div>
            <PermissionsEditor
              permissions={agent.permissions as Partial<PermissionManifest>}
              toolsPolicy={(agent.toolsPolicy as { allow: string[]; deny: string[] }) ?? undefined}
              shareUserProfile={(agent.config as Record<string, unknown>)?.shareUserProfile === true}
              onChange={handlePermsChange}
            />
            <div className="srow" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
              <button type="button" onClick={savePermissions} className="btn btn--primary btn--sm">
                Save Permissions
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export const AgentConfigPanel = () => {
  const { id } = useParams<{ id: string }>();
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
