import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgentDetail, Model, PermissionManifest } from '@dojo/shared';
import type { WsEvent, AgentCreatedEvent, AgentStatusEvent, AgentTerminatedEvent } from '@dojo/shared';
import * as api from '../lib/api';
import { formatDateShort } from '../lib/dates';
import { useWebSocket } from '../hooks/useWebSocket';
import { AgentCard } from '../components/AgentCard';
import { GroupCard } from '../components/GroupCard';
import { StatusBadge } from '../components/StatusBadge';
import { PermissionsEditor, DEFAULT_SUBAGENT_PERMISSIONS, DEFAULT_SUBAGENT_TOOLS_POLICY } from '../components/PermissionsEditor';
import { TechniqueSelector } from '../components/TechniqueSelector';

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
  const [permissions, setPermissions] = useState<Partial<PermissionManifest>>(DEFAULT_SUBAGENT_PERMISSIONS);
  const [toolsPol, setToolsPol] = useState(DEFAULT_SUBAGENT_TOOLS_POLICY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [equippedTechniques, setEquippedTechniques] = useState<string[]>([]);

  const [shareProfile, setShareProfile] = useState(false);


  const handlePermsChange = (perms: Partial<PermissionManifest>, tools: { allow: string[]; deny: string[] }, sp: boolean) => {
    setPermissions(perms);
    setToolsPol(tools);
    setShareProfile(sp);
  };

  const handleCreate = async () => {
    if (!name.trim() || !systemPrompt.trim()) return;
    setSaving(true);
    setError(null);

    const createData: Record<string, unknown> = {
      name: name.trim(),
      systemPrompt: systemPrompt.trim(),
      modelId: modelId || undefined,
      timeout: timeout ? Number(timeout) : undefined,
      permissions: permissions as PermissionManifest,
      toolsPolicy: (toolsPol.allow.length > 0 || toolsPol.deny.length > 0) ? toolsPol : undefined,
      classification,
      shareUserProfile: shareProfile || undefined,
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
    <div className="glass-modal-backdrop">
      <div className="glass-modal p-6 max-w-2xl w-full mx-4 max-h-[85vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-white mb-4">Recruit Agent</h3>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold white/55 uppercase tracking-wide block mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Agent name"
              className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="text-xs font-semibold white/55 uppercase tracking-wide block mb-1">System Prompt</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Instructions for the agent..."
              rows={6}
              className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none font-mono"
            />
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label className="text-xs font-semibold white/55 uppercase tracking-wide block mb-1">Model</label>
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
            </div>
            <div className="w-36">
              <label className="text-xs font-semibold white/55 uppercase tracking-wide block mb-1">Timeout (sec)</label>
              <input
                value={timeout}
                onChange={(e) => setTimeout_(e.target.value)}
                placeholder="No timeout"
                type="number"
                min="0"
                className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Classification */}
          <div>
            <label className="text-xs font-semibold white/55 uppercase tracking-wide block mb-1">Classification</label>
            <div className="flex gap-2">
              <button
                onClick={() => setClassification('apprentice')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                  classification === 'apprentice'
                    ? 'bg-white/[0.08] text-white white/[0.10]'
                    : 'bg-white/[0.05] white/40 white/[0.08] hover:white/70'
                }`}
              >
                <div>Apprentice</div>
                <div className="text-[10px] font-normal white/40 mt-0.5">Auto-dismisses, subject to timeouts</div>
              </button>
              <button
                onClick={() => setClassification('ronin')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                  classification === 'ronin'
                    ? 'bg-blue-600/20 text-blue-400 border-blue-500/30'
                    : 'bg-white/[0.05] white/40 white/[0.08] hover:white/70'
                }`}
              >
                <div>Ronin</div>
                <div className="text-[10px] font-normal white/40 mt-0.5">Persists across restarts, only you can dismiss</div>
              </button>
            </div>
          </div>

          {/* Group */}
          {availableGroups.length > 0 && (
            <div>
              <label className="text-xs font-semibold white/55 uppercase tracking-wide block mb-1">Group</label>
              <select value={selectedGroupId} onChange={(e) => setSelectedGroupId(e.target.value)} className="glass-select w-full">
                <option value="">No group (ungrouped)</option>
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
              className="flex items-center gap-2 text-xs font-semibold white/55 uppercase tracking-wide hover:white/70 transition-colors"
            >
              <span className="white/30">{showPerms ? '\u25BC' : '\u25B6'}</span>
              Permissions {!showPerms && <span className="normal-case font-normal white/30">(restrictive defaults — click to customize)</span>}
            </button>
            {showPerms && (
              <div className="mt-3 glass-nested rounded-xl p-4">
                <PermissionsEditor
                  permissions={permissions}
                  toolsPolicy={toolsPol}
                  onChange={handlePermsChange}
                  compact
                />
              </div>
            )}
          </div>
        </div>

        {/* Equipped Techniques */}
        <div>
          <label className="text-xs font-semibold white/55 uppercase tracking-wide block mb-1">Equipped Techniques</label>
          <TechniqueSelector selected={equippedTechniques} onChange={setEquippedTechniques} />
        </div>

        <div className="flex gap-3 justify-end mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm white/55 hover:white/90 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={saving || !name.trim() || !systemPrompt.trim()}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white rounded-lg transition-colors"
          >
            {saving ? 'Creating...' : 'Recruit Agent'}
          </button>
        </div>
      </div>
    </div>
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

  const statusColor =
    agent.status === 'terminated' ? 'white/40' : 'text-red-400';

  const duration = agent.uptime > 0
    ? agent.uptime < 60
      ? `${agent.uptime}s`
      : agent.uptime < 3600
        ? `${Math.floor(agent.uptime / 60)}m`
        : `${Math.floor(agent.uptime / 3600)}h ${Math.floor((agent.uptime % 3600) / 60)}m`
    : '--';

  return (
    <div className="border-b white/[0.04] last:border-b-0">
      <div
        className="flex items-center gap-3 px-4 py-2.5 hover:white/[0.02] cursor-pointer transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-xs white/30 w-4">{expanded ? '-' : '+'}</span>
        <span className="text-sm white/70 font-medium w-36 truncate">{agent.name}</span>
        <StatusBadge status={agent.status} />
        <span className="text-xs white/40 w-20">{duration}</span>
        <span className="text-xs white/40 w-16">{agent.messageCount} msgs</span>
        <span className="text-xs white/40 flex-1 truncate">{agent.taskId || ''}</span>
        <span className="text-xs white/30">{formatDateShort(agent.updatedAt)}</span>
      </div>

      {expanded && (
        <div className="px-4 pb-3 pt-1 white/[0.02] flex items-center gap-3">
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/agents/${agent.id}`); }}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            View Detail
          </button>
          {agent.classification !== 'sensei' && (
            confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-400">Delete permanently?</span>
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    await api.purgeAgent(agent.id);
                    onReload();
                    setConfirmDelete(false);
                  }}
                  className="text-xs px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
                >
                  Yes
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                  className="text-xs white/55 hover:white/90"
                >
                  No
                </button>
              </div>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                className="text-xs text-red-400 hover:text-red-300 transition-colors"
              >
                Delete
              </button>
            )
          )}
          <span className="text-xs white/30 ml-auto">
            Model: {agent.model?.name || 'None'} | Type: {agent.agentType}
          </span>
        </div>
      )}
    </div>
  );
};

// ── Main Component ──

export const Agents = () => {
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
  const [ollamaWarning, setOllamaWarning] = useState<{ count: number; max: number } | null>(null);
  const [ollamaWarningExpanded, setOllamaWarningExpanded] = useState(false);
  const { subscribe } = useWebSocket();

  const loadAgents = async () => {
    const [agentResult, groupResult] = await Promise.all([
      api.getAgents(),
      api.getGroups(),
    ]);
    if (agentResult.ok) setAgents(agentResult.data);
    else setError(agentResult.error);
    if (groupResult.ok) setGroups(groupResult.data);
  };

  const checkOllamaWarning = async () => {
    const result = await api.getOllamaLockStatus();
    if (result.ok && result.data.warning) {
      setOllamaWarning({ count: result.data.activeAgentModels.count, max: result.data.maxConcurrentModels });
    } else {
      setOllamaWarning(null);
    }
  };

  useEffect(() => {
    const load = async () => {
      await loadAgents();
      const [modelsResult, providersResult] = await Promise.all([
        api.getModels(),
        api.getProviders(),
      ]);
      if (modelsResult.ok) {
        setModels(modelsResult.data.filter((m) => m.isEnabled));
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
          a.id === e.agentId ? { ...a, status: e.status as AgentDetail['status'] } : a,
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

  const activeAgents = agents.filter(
    (a) => a.status !== 'terminated' && a.agentType !== 'archived',
  );
  const terminatedAgents = agents
    .filter((a) => a.status === 'terminated' && a.agentType !== 'archived')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const visibleTerminated = showAllHistory ? terminatedAgents : terminatedAgents.slice(0, 20);

  const handleClearHistory = async () => {
    const result = await api.archiveOldAgents();
    if (result.ok) {
      loadAgents();
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="white/40">Loading agents...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 p-4 md:p-6 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-white">Agents</h1>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowCreateGroup(true)} className="glass-btn glass-btn-secondary text-sm">+ Form Squad</button>
          <button onClick={() => setShowCreate(true)} className="glass-btn glass-btn-primary text-sm">+ Recruit Agent</button>
        </div>
      </div>

      {/* Ollama model concurrency warning */}
      {ollamaWarning && (
        <div className="mb-4 px-4 py-2.5 rounded-xl bg-cp-amber/10 border border-cp-amber/20">
          <div className="flex items-center justify-between">
            <span className="text-xs text-cp-amber">
              {ollamaWarning.count} different local models in use — your system supports {ollamaWarning.max} concurrent. Some agents may queue.
            </span>
            <button
              onClick={() => setOllamaWarningExpanded(!ollamaWarningExpanded)}
              className="text-xs text-cp-amber/70 hover:text-cp-amber ml-2 shrink-0"
            >
              {ollamaWarningExpanded ? 'Hide' : 'Learn more'}
            </button>
          </div>
          {ollamaWarningExpanded && (
            <div className="mt-2 text-xs white/50 space-y-1">
              <p>Your machine can only keep {ollamaWarning.max} Ollama model{ollamaWarning.max > 1 ? 's' : ''} loaded in RAM at once. When agents use different local models, they have to wait for the current model to finish before swapping.</p>
              <p>To avoid delays: assign all agents to the same local model, switch some agents to a cloud model (Anthropic/OpenAI), or <a href="/settings?tab=platform" className="text-cp-amber underline hover:text-cp-amber/80">increase the concurrent model limit</a> if your machine has enough RAM.</p>
            </div>
          )}
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

      {/* Ungrouped at the bottom — also a drop zone to remove from groups */}
      <UngroupedSection agents={activeAgents.filter(a => !a.groupId)} models={models} providerNameById={providerNameById} onReload={loadAgents} />

      {/* Create Group Modal */}
      {showCreateGroup && (
        <CreateGroupModal onClose={() => setShowCreateGroup(false)} onCreated={loadAgents} />
      )}

      {/* Recent History */}
      {terminatedAgents.length > 0 && (
        <div>
          <div className="flex items-center gap-3 mb-2">
            <button
              onClick={() => setHistoryExpanded(!historyExpanded)}
              className="flex items-center gap-2 text-sm font-semibold white/55 uppercase tracking-wide hover:white/70 transition-colors"
            >
              <span className="text-xs">{historyExpanded ? '\u25BC' : '\u25B6'}</span>
              Recent History ({terminatedAgents.length})
            </button>
            {historyExpanded && terminatedAgents.length > 0 && (
              <button
                onClick={handleClearHistory}
                className="text-xs white/30 hover:white/55 transition-colors ml-auto"
              >
                Clear older than 7 days
              </button>
            )}
          </div>

          {historyExpanded && (
            <div className="glass-card overflow-hidden">
              {/* Column headers */}
              <div className="flex items-center gap-3 px-4 py-2 border-b white/[0.06] text-xs white/30 uppercase tracking-wide">
                <span className="w-4" />
                <span className="w-36">Name</span>
                <span className="w-16">Status</span>
                <span className="w-20">Duration</span>
                <span className="w-16">Messages</span>
                <span className="flex-1">Task</span>
                <span>Date</span>
              </div>

              {visibleTerminated.map((agent) => (
                <TerminatedAgentRow
                  key={agent.id}
                  agent={agent}
                  onReload={loadAgents}
                />
              ))}

              {terminatedAgents.length > 20 && !showAllHistory && (
                <div className="px-4 py-2 border-t white/[0.06]">
                  <button
                    onClick={() => setShowAllHistory(true)}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Show all {terminatedAgents.length} terminated agents
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
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
    </div>
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
    <div className="glass-modal-backdrop">
      <div className="glass-modal p-6 max-w-md w-full mx-4">
        <h3 className="text-lg font-semibold text-white mb-4">Form Squad</h3>
        <p className="text-sm text-white/40 mb-4">Groups organize agents around a shared purpose. The description is injected into all member agents' context.</p>

        {error && <div className="mb-4 px-3 py-2 rounded-xl bg-cp-coral/10 border border-cp-coral/20 text-cp-coral text-sm">{error}</div>}

        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-white/55 uppercase tracking-wide block mb-1">Group Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Research Team" className="glass-input" autoFocus />
          </div>
          <div>
            <label className="text-xs font-semibold text-white/55 uppercase tracking-wide block mb-1">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this group does..." className="glass-textarea" rows={3} />
          </div>
        </div>

        <div className="flex gap-3 justify-end mt-6">
          <button onClick={onClose} className="glass-btn glass-btn-ghost">Cancel</button>
          <button onClick={handleCreate} disabled={saving || !name.trim()} className="glass-btn glass-btn-primary">
            {saving ? 'Creating...' : 'Form Squad'}
          </button>
        </div>
      </div>
    </div>
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
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const agentId = e.dataTransfer.getData('agent-id');
    if (agentId) {
      await api.assignAgentToGroupApi(agentId, null);
      onReload();
    }
  };

  return (
    <div
      className={`mb-6 p-4 rounded-2xl transition-all ${dragOver ? 'ring-2 ring-white/20 bg-white/[0.02]' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <h2 className="section-label mb-3">Unassigned ({agents.length})</h2>
      {agents.length === 0 ? (
        <p className="text-sm text-white/30 text-center py-4">
          {dragOver ? 'Drop here to remove from squad' : 'No unassigned agents'}
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} models={models} providerNameById={providerNameById} onModelChanged={onReload} />
          ))}
        </div>
      )}
    </div>
  );
};
