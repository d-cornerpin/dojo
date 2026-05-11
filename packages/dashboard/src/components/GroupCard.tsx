import { useState, type DragEvent } from 'react';
import type { AgentDetail, Model } from '@dojo/shared';
import { AgentCard } from './AgentCard';
import * as api from '../lib/api';

interface GroupCardProps {
  group: api.AgentGroup;
  agents: AgentDetail[];
  models: Model[];
  providerNameById: Record<string, string>;
  onReload: () => void;
}

export const GroupCard = ({ group, agents, models, providerNameById, onReload }: GroupCardProps) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? '');
  const [dreamerIgnore, setDreamerIgnore] = useState(group.dreamerIgnore === true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleSave = async () => {
    await api.updateGroupApi(group.id, { name, description, dreamerIgnore });
    setEditing(false);
    onReload();
  };

  const handleDelete = async () => {
    await api.deleteGroupApi(group.id);
    onReload();
  };

  const [dragOver, setDragOver] = useState(false);
  const isSystem = group.id === 'system-group';

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (isSystem) return; // Can't drop into system group
    const agentId = e.dataTransfer.getData('agent-id');
    if (agentId) {
      await api.assignAgentToGroupApi(agentId, group.id);
      onReload();
    }
  };

  return (
    <div
      className={`glass-card p-5 mb-6 transition-all ${dragOver && !isSystem ? 'ring-2 ring-cp-amber/50 bg-ui/[0.03]' : ''}`}
      onDragOver={(e) => { if (!isSystem) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Group header with colored bar */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          {/* group.color is a literal hex stored on agent_groups at create
              time (see server/src/agent/groups.ts GROUP_COLORS). It does NOT
              follow Feng Shui theme switches. Migrating to a color-slot model
              that resolves to theme vars at render time is tracked separately
              — see the Compliance Audit section in FENG-SHUI-THEME-SPEC.md. */}
          <div className="w-1 h-10 rounded-full" style={{ background: group.color }} />
          <div>
            {editing ? (
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
                className="glass-input text-base font-semibold py-1 px-2 w-48" />
            ) : (
              <h3 className="text-base font-semibold text-ui">{group.name}</h3>
            )}
            {editing ? (
              <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                className="glass-textarea text-xs mt-1 py-1 px-2 min-h-[40px]" rows={2} />
            ) : (
              group.description && <p className="text-xs text-ui/40 mt-0.5">{group.description}</p>
            )}
            {editing && (
              <label className="mt-2 flex items-center gap-2 text-xs text-ui/55 cursor-pointer">
                <input
                  type="checkbox"
                  checked={dreamerIgnore}
                  onChange={(e) => setDreamerIgnore(e.target.checked)}
                  className="accent-cp-teal"
                />
                Skip in Dreamer cycle (members' chats won't enter the vault)
              </label>
            )}
            {!editing && group.dreamerIgnore === true && (
              <p className="mt-1 text-[10px] text-cp-amber/80">Dreamer ignore: ON — members' chats are not archived for the nightly cycle.</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ui/25">{agents.length} agent{agents.length !== 1 ? 's' : ''}</span>
          {editing ? (
            <>
              <button onClick={handleSave} className="glass-btn glass-btn-primary text-xs py-1 px-3">Save</button>
              <button onClick={() => setEditing(false)} className="glass-btn glass-btn-ghost text-xs py-1 px-2">Cancel</button>
            </>
          ) : !isSystem ? (
            <>
              <button onClick={() => setEditing(true)} className="text-xs text-ui/25 hover:text-ui/55 transition-colors">Edit</button>
              {confirmDelete ? (
                <div className="flex items-center gap-1">
                  <button onClick={handleDelete} className="glass-btn glass-btn-destructive text-xs py-1 px-2">Delete Group</button>
                  <button onClick={() => setConfirmDelete(false)} className="text-xs text-ui/40">Cancel</button>
                </div>
              ) : (
                <button onClick={() => setConfirmDelete(true)} className="text-xs text-ui/25 hover:text-cp-coral transition-colors">Delete</button>
              )}
            </>
          ) : null}
        </div>
      </div>

      {/* Agent cards grid */}
      {agents.length === 0 ? (
        <p className="text-sm text-ui/25 text-center py-4">No agents in this group</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} models={models} providerNameById={providerNameById} onModelChanged={onReload} />
          ))}
        </div>
      )}
    </div>
  );
};
