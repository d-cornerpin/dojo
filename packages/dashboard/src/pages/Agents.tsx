import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgentDetail, Model } from '@dojo/shared';
import { DEFAULT_SUBAGENT_PERMISSIONS } from '@dojo/shared';
import type { WsEvent, AgentStatusEvent, AgentTerminatedEvent } from '@dojo/shared';
import * as api from '../lib/api';
import { formatDateShort } from '../lib/dates';
import { useWebSocket } from '../hooks/useWebSocket';
import { useToast } from '../hooks/useToast';
import { AgentCard } from '../components/AgentCard';
import { GroupCard } from '../components/GroupCard';
import { PermissionsEditor } from '../components/PermissionsEditor';
import { createAgentAccess, readLegacyAccess } from '../lib/manifest-edits';
import { TechniqueSelector } from '../components/TechniqueSelector';
import { ModalShell } from '../components/ModalShell';
import { AgentModelOption } from '../components/AgentModelOption';

// ── Create Agent Modal ──

const CreateAgentModal = ({
  models,
  providerNameById,
  groups: availableGroups,
  onClose,
  onCreate,
}: {
  models: Model[];
  providerNameById: Record<string, string>;
  groups: api.AgentGroup[];
  onClose: () => void;
  onCreate: () => void;
}) => {
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [modelId, setModelId] = useState(models.length > 0 ? models[0].id : '');
  const [timeout, setTimeout_] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [classification, setClassification] = useState<'apprentice' | 'ronin'>('apprentice');
  const [showPerms, setShowPerms] = useState(false);
  // The form starts from the server's one helper default (no Web tool group, hence null grants); it sends
  // permissions only once the owner changes one.
  const [initialAccess] = useState(() => readLegacyAccess(DEFAULT_SUBAGENT_PERMISSIONS, undefined, false, null));
  const [access, setAccess] = useState(initialAccess);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [equippedTechniques, setEquippedTechniques] = useState<string[]>([]);

  const handleCreate = async () => {
    if (!name.trim() || !systemPrompt.trim()) return;
    setSaving(true);
    setError(null);

    const createData: Record<string, unknown> = {
      name: name.trim(),
      systemPrompt: systemPrompt.trim(),
      modelId: modelId || undefined,
      timeout: timeout ? Number(timeout) : undefined,
      ...createAgentAccess(initialAccess, access),
      classification,
      groupId: selectedGroupId || undefined,
      equippedTechniques: equippedTechniques.length > 0 ? equippedTechniques : undefined,
    };
    const result = await api.createAgent(createData as unknown as Parameters<typeof api.createAgent>[0]);

    if (result.ok) {
      onCreate();
      onClose();
    } else {
      setError(result.error);
    }
    setSaving(false);
  };

  return (
    <ModalShell
      onClose={onClose}
      label="Recruit Agent"
      backdropClassName="glass-modal-backdrop"
      panelClassName="glass-modal p-6 max-w-2xl w-full mx-4 max-h-[85vh] overflow-y-auto"
      closeOnEscape={!saving}
      closeOnBackdrop={false}
    >
        <h3 className="text-lg font-semibold text-ui mb-4">Recruit Agent</h3>

        {error && (
          <div className="alert-banner alert-error mb-4">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Agent name"
              className="glass-input w-full"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">System Prompt</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Instructions for the agent..."
              rows={6}
              className="glass-textarea w-full resize-none font-mono"
            />
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Model</label>
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className="glass-select w-full"
              >
                <option value="">No model selected</option>
                <option value="auto">Auto (Smart Router)</option>
                {models.map((m) => <AgentModelOption key={m.id} model={m} label={`${m.name}${providerNameById[m.providerId] ? ` (${providerNameById[m.providerId]})` : ''}`} />)}
              </select>
            </div>
            <div className="w-36">
              <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Timeout (sec)</label>
              <input
                value={timeout}
                onChange={(e) => setTimeout_(e.target.value)}
                placeholder="No timeout"
                type="number"
                min="0"
                className="glass-input w-full"
              />
            </div>
          </div>

          {/* Classification */}
          <div>
            <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Classification</label>
            <div className="flex gap-2">
              <button
                onClick={() => setClassification('apprentice')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                  classification === 'apprentice'
                    ? 'bg-ui/[0.08] text-ui text-ui/25'
                    : 'bg-ui/[0.05] text-ui/40 text-ui/25 hover:text-ui/70'
                }`}
              >
                <div>Apprentice</div>
                <div className="text-[10px] font-normal text-ui/40 mt-0.5">Auto-dismisses, subject to timeouts</div>
              </button>
              <button
                onClick={() => setClassification('ronin')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                  classification === 'ronin'
                    ? 'bg-cp-amber/20 text-cp-amber border-cp-amber/30'
                    : 'bg-ui/[0.05] text-ui/40 text-ui/25 hover:text-ui/70'
                }`}
              >
                <div>Ronin</div>
                <div className="text-[10px] font-normal text-ui/40 mt-0.5">Persists across restarts, only you can dismiss</div>
              </button>
            </div>
          </div>

          {/* Group */}
          {availableGroups.length > 0 && (
            <div>
              <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Squad</label>
              <select value={selectedGroupId} onChange={(e) => setSelectedGroupId(e.target.value)} className="glass-select w-full">
                <option value="">No squad</option>
                {availableGroups.filter(g => g.id !== 'system-group').map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Permissions (collapsible) */}
          <div>
            <button
              onClick={() => setShowPerms(!showPerms)}
              className="flex items-center gap-2 text-xs font-semibold text-ui/55 uppercase tracking-wide hover:text-ui/70 transition-colors"
            >
              <span className="text-ui/25">{showPerms ? '\u25BC' : '\u25B6'}</span>
              Permissions {!showPerms && <span className="normal-case font-normal text-ui/25">(restrictive defaults, click to customize)</span>}
            </button>
            {showPerms && (
              <div className="mt-3 glass-nested rounded-xl p-4">
                <PermissionsEditor state={access} onChange={setAccess} compact />
              </div>
            )}
          </div>
        </div>

        {/* Equipped Techniques */}
        <div>
          <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Equipped Techniques</label>
          <TechniqueSelector selected={equippedTechniques} onChange={setEquippedTechniques} />
        </div>

        <div className="flex gap-3 justify-end mt-6">
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={saving || !name.trim() || !systemPrompt.trim()}
            className="btn btn--primary"
          >
            {saving ? 'Creating...' : 'Recruit Agent'}
          </button>
        </div>
    </ModalShell>
  );
};

// ── Terminated Agent Compact Row ──

const TerminatedAgentRow = ({
  agent,
  onReload,
}: {
  agent: AgentDetail;
  onReload: () => void;
}) => {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const pillClass = agent.status === 'terminated' ? 'pill--norm' : 'pill--down';
  const statusLabel = agent.status === 'terminated' ? 'Ended' : agent.status;

  const duration = agent.uptime > 0
    ? agent.uptime < 60
      ? `${agent.uptime}s`
      : agent.uptime < 3600
        ? `${Math.floor(agent.uptime / 60)}m`
        : `${Math.floor(agent.uptime / 3600)}h ${Math.floor((agent.uptime % 3600) / 60)}m`
    : '--';

  return (
    <div style={{ borderBottom: '1px solid rgba(140,116,84,.12)' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', cursor: 'pointer' }}
      >
        <span className="text-tertiary" style={{ fontSize: 11, width: 12 }}>{expanded ? '-' : '+'}</span>
        <span style={{ width: 144, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: 'var(--dojo3-ink-2)' }}>{agent.name}</span>
        <span className={`pill ${pillClass}`}><i className="dot" />{statusLabel}</span>
        <span className="text-tertiary" style={{ fontSize: 11, width: 64 }}>{duration}</span>
        <span className="text-tertiary" style={{ fontSize: 11, width: 64 }}>{agent.messageCount} msgs</span>
        <span className="text-tertiary" style={{ fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.taskId || ''}</span>
        <span className="text-tertiary" style={{ fontSize: 11 }}>{formatDateShort(agent.updatedAt)}</span>
      </div>

      {expanded && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '2px 16px 12px' }}>
          <button
            type="button"
            className="link"
            onClick={(e) => { e.stopPropagation(); navigate(`/agents/${agent.id}`); }}
          >
            View Detail
          </button>
          {agent.classification !== 'sensei' && (
            confirmDelete ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--dojo3-rust)' }}>Delete permanently?</span>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={async (e) => {
                    e.stopPropagation();
                    setDeleteError(null);
                    const res = await api.purgeAgent(agent.id);
                    if (res.ok) {
                      onReload();
                      setConfirmDelete(false);
                    } else {
                      setDeleteError(res.error);
                    }
                  }}
                >
                  Yes
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); setDeleteError(null); }}
                >
                  No
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="group__action"
                style={{ color: 'var(--dojo3-rust)' }}
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
              >
                Delete
              </button>
            )
          )}
          {deleteError && (
            <span role="alert" style={{ fontSize: 11, color: 'var(--dojo3-rust)' }}>{deleteError}</span>
          )}
          <span className="text-tertiary" style={{ fontSize: 11, marginLeft: 'auto' }}>
            Model: {agent.model?.name || 'None'} | Type: {agent.agentType}
          </span>
        </div>
      )}
    </div>
  );
};

// ── Main Component ──

export const Agents = () => {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentDetail[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [providerNameById, setProviderNameById] = useState<Record<string, string>>({});
  const [groups, setGroups] = useState<api.AgentGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [ollamaWarnings, setOllamaWarnings] = useState<api.OllamaLockWarning[]>([]);
  const [ollamaWarningExpanded, setOllamaWarningExpanded] = useState(false);
  const { subscribe, connectionStatus } = useWebSocket();
  const prevConnectionRef = useRef<typeof connectionStatus>('disconnected');
  const toast = useToast();

  const loadAgents = async () => {
    const [agentResult, groupResult] = await Promise.all([
      api.getAgents(),
      api.getGroups(),
    ]);
    if (agentResult.ok) { setAgents(agentResult.data); setError(null); }
    else setError(agentResult.error);
    if (groupResult.ok) setGroups(groupResult.data);
  };

  const checkOllamaWarning = async () => {
    const result = await api.getOllamaLockStatus();
    // `request` casts the parsed JSON to its type without verifying it, so
    // `data.warnings` is only a server-side promise; this un-awaited read must tolerate its absence.
    const warnings = result.ok ? result.data?.warnings : undefined;
    setOllamaWarnings(Array.isArray(warnings) ? warnings : []);
  };

  useEffect(() => {
    const load = async () => {
      await loadAgents();
      const [modelsResult, providersResult] = await Promise.all([
        api.getModels(),
        api.getProviders(),
      ]);
      if (modelsResult.ok) {
        setModels(modelsResult.data.filter((m) => m.isEnabled && !m.capabilities.includes('decision')));   // never the Dojo's decision model
      }
      if (providersResult.ok) {
        const map: Record<string, string> = {};
        for (const p of providersResult.data) map[p.id] = p.name;
        setProviderNameById(map);
      }
      setLoading(false);
      checkOllamaWarning();
    };
    load();
  }, []);

  useEffect(() => {
    const unsubCreated = subscribe('agent:created', () => { loadAgents(); });
    const unsubStatus = subscribe('agent:status', (event: WsEvent) => {
      const e = event as AgentStatusEvent;
      setAgents((prev) =>
        prev.map((a) =>
          a.id === e.agentId ? { ...a, status: e.status as AgentDetail['status'], parkedCause: e.parkedCause ?? null } : a,
        ),
      );
    });
    const unsubTerminated = subscribe('agent:terminated', (event: WsEvent) => {
      const e = event as AgentTerminatedEvent;
      setAgents((prev) =>
        prev.map((a) =>
          a.id === e.agentId ? { ...a, status: 'terminated' as const } : a,
        ),
      );
    });

    return () => { unsubCreated(); unsubStatus(); unsubTerminated(); };
  }, [subscribe]);

  // Re-fetch on WS reconnect: statuses broadcast during a disconnect window are
  // missed, and the grid would show stale state (an agent stuck on 'idle').
  useEffect(() => {
    const prev = prevConnectionRef.current;
    prevConnectionRef.current = connectionStatus;
    if (prev !== 'connected' && connectionStatus === 'connected') {
      loadAgents().catch(() => { /* best effort */ });
    }
  }, [connectionStatus]);

  const activeAgents = agents.filter(
    (a) => a.status !== 'terminated' && a.agentType !== 'archived'
  );
  const terminatedAgents = agents
    .filter((a) => a.status === 'terminated' && a.agentType !== 'archived')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const visibleTerminated = showAllHistory ? terminatedAgents : terminatedAgents.slice(0, 20);

  const handleClearHistory = async () => {
    const result = await api.archiveOldAgents();
    if (result.ok) {
      loadAgents();
    } else {
      // A clear the server refuses must say why, so the history is not shown as cleared.
      toast.error(result.error ?? 'The history could not be cleared.');
    }
  };

  if (loading) return <div className="loading-state">Loading...</div>;

  if (error && agents.length === 0) {
    return (
      <div className="stub">
        <p className="stub__line" style={{ color: 'var(--dojo3-rust)' }}>{error}</p>
      </div>
    );
  }

  return (
    <>
      {/* Header */}
      <header className="phead">
        <h2 className="phead__title">Agents</h2>
        <span className="phead__meta">{activeAgents.length} agent{activeAgents.length !== 1 ? 's' : ''}</span>
        <div className="phead__actions">
          <button type="button" className="btn" onClick={() => navigate('/interagent')}>Agent Threads</button>
          <button type="button" className="btn" onClick={() => setShowCreateGroup(true)}>+ Form Squad</button>
          <button type="button" className="btn btn--primary" onClick={() => setShowCreate(true)}>+ Recruit Agent</button>
        </div>
      </header>

      {error && <div className="note--warn">Could not refresh the agent list: {error}</div>}

      {/* Ollama model concurrency warnings, one per over-limit provider */}
      {ollamaWarnings.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {ollamaWarnings.map((w) => (
            <div key={w.providerId} className="note--warn" style={{ marginBottom: 0 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <span>
                  {w.count} different local models in use on <b>{w.providerName}</b> · supports {w.maxConcurrentModels} concurrent. Some agents may queue.
                </span>
                <button
                  type="button"
                  className="link"
                  onClick={() => setOllamaWarningExpanded(!ollamaWarningExpanded)}
                  style={{ flexShrink: 0 }}
                >
                  {ollamaWarningExpanded ? 'Hide' : 'Learn more'}
                </button>
              </div>
              {ollamaWarningExpanded && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, textTransform: 'none', letterSpacing: 'normal' }}>
                  <p>
                    <b>{w.providerName}</b> can only keep {w.maxConcurrentModels} Ollama model{w.maxConcurrentModels > 1 ? 's' : ''} loaded in RAM at once.
                    When agents assigned to this provider use different models, they have to wait for the current one to finish before swapping.
                    Other Ollama providers on your network aren't affected, each machine has its own slot pool.
                  </p>
                  <p>
                    Current models on {w.providerName}: {w.models.join(', ')}
                  </p>
                  <p>
                    To avoid delays: assign all agents on this provider to the same model, route some agents to a different Ollama provider (or a cloud model), or <a href="/settings?tab=platform" className="link">increase the concurrent model limit</a> if the host has enough RAM.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* System Group first */}
      {groups.filter(g => g.id === 'system-group').map((group) => (
        <GroupCard key={group.id} group={group} agents={activeAgents.filter(a => a.groupId === group.id)} models={models} providerNameById={providerNameById} onReload={loadAgents} />
      ))}

      {/* User-created groups */}
      {groups.filter(g => g.id !== 'system-group').map((group) => (
        <GroupCard key={group.id} group={group} agents={activeAgents.filter(a => a.groupId === group.id)} models={models} providerNameById={providerNameById} onReload={loadAgents} />
      ))}

      {/* Ungrouped at the bottom, also a drop zone to remove from groups */}
      <UngroupedSection agents={activeAgents.filter(a => !a.groupId)} models={models} providerNameById={providerNameById} onReload={loadAgents} />

      {/* Create Group Modal */}
      {showCreateGroup && (
        <CreateGroupModal onClose={() => setShowCreateGroup(false)} onCreated={loadAgents} />
      )}

      {/* Recent History */}
      {terminatedAgents.length > 0 && (
        <section className="group">
          <div className="group__head">
            <div>
              <button
                type="button"
                className="group__title"
                onClick={() => setHistoryExpanded(!historyExpanded)}
                style={{ background: 'transparent', border: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <span style={{ fontSize: 10 }}>{historyExpanded ? '\u25BC' : '\u25B6'}</span>
                Recent History
              </button>
            </div>
            <div className="group__side">
              <span>{terminatedAgents.length} ended</span>
              {historyExpanded && (
                <button type="button" className="group__action" onClick={handleClearHistory}>
                  Clear older than 7 days
                </button>
              )}
            </div>
          </div>

          {historyExpanded && (
            <div className="tile" style={{ marginTop: 16, padding: 0, overflow: 'hidden' }}>
              {visibleTerminated.map((agent) => (
                <TerminatedAgentRow
                  key={agent.id}
                  agent={agent}
                  onReload={loadAgents}
                />
              ))}

              {terminatedAgents.length > 20 && !showAllHistory && (
                <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(140,116,84,.14)' }}>
                  <button type="button" className="link" onClick={() => setShowAllHistory(true)}>
                    Show all {terminatedAgents.length} ended agents
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {showCreate && (
        <CreateAgentModal
          models={models}
          providerNameById={providerNameById}
          groups={groups}
          onClose={() => setShowCreate(false)}
          onCreate={loadAgents}
        />
      )}
    </>
  );
};

// ── Create Group Modal ──

const CreateGroupModal = ({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const result = await api.createGroupApi(name.trim(), description.trim());
    if (result.ok) {
      onCreated();
      onClose();
    } else {
      setError(result.error);
    }
    setSaving(false);
  };

  return (
    <ModalShell
      onClose={onClose}
      label="Form Squad"
      backdropClassName="glass-modal-backdrop"
      panelClassName="glass-modal p-6 max-w-md w-full mx-4"
      closeOnEscape={!saving}
      closeOnBackdrop={false}
    >
        <h3 className="text-lg font-semibold text-ui mb-4">Form Squad</h3>
        <p className="text-sm text-ui/40 mb-4">A squad gathers agents around a shared purpose. Every agent in the squad is told its description.</p>

        {error && <div className="note--warn" style={{ color: 'var(--dojo3-rust)' }}>{error}</div>}

        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Squad name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Research Team" className="glass-input" autoFocus />
          </div>
          <div>
            <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this squad does..." className="glass-textarea" rows={3} />
          </div>
        </div>

        <div className="flex gap-3 justify-end mt-6">
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="button" onClick={handleCreate} disabled={saving || !name.trim()} className="btn btn--primary">
            {saving ? 'Creating...' : 'Form Squad'}
          </button>
        </div>
    </ModalShell>
  );
};

// ── Ungrouped Section (also a drop zone to remove from groups) ──

const UngroupedSection = ({
  agents,
  models,
  providerNameById,
  onReload,
}: {
  agents: AgentDetail[];
  models: Model[];
  providerNameById: Record<string, string>;
  onReload: () => void;
}) => {
  const toast = useToast();
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const agentId = e.dataTransfer.getData('agent-id');
    if (agentId) {
      const res = await api.assignAgentToGroupApi(agentId, null);
      if (!res.ok) toast.error(res.error ?? 'The agent could not be moved.');
      onReload();
    }
  };

  return (
    <section
      className="group"
      style={dragOver ? { outline: '2px solid rgba(152,126,92,.4)', outlineOffset: 6, borderRadius: 8 } : undefined}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="group__head">
        <div>
          <div className="group__title">Unassigned</div>
          <div className="group__desc">Agents that don't belong to a squad. Drop an agent here to remove it from its squad.</div>
        </div>
        <div className="group__side">
          <span>{agents.length} agent{agents.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
      {agents.length === 0 ? (
        <p className="text-tertiary" style={{ fontSize: 12, padding: '16px 2px 2px' }}>
          {dragOver ? 'Drop here to remove from squad' : 'No unassigned agents'}
        </p>
      ) : (
        <div className="cards">
          {agents.map((agent, i) => (
            <AgentCard key={agent.id} agent={agent} models={models} providerNameById={providerNameById} onModelChanged={onReload} index={i} />
          ))}
        </div>
      )}
    </section>
  );
};
