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
    <section
      className="group"
      style={dragOver && !isSystem ? { outline: '2px solid rgba(217,165,92,.5)', outlineOffset: 6, borderRadius: 8 } : undefined}
      onDragOver={(e) => { if (!isSystem) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="group__head">
        <div style={{ minWidth: 0, flex: 1 }}>
          {editing ? (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="field"
              style={{ width: 240, marginBottom: 8 }}
            />
          ) : (
            <div className="group__title">{group.name}</div>
          )}
          {editing ? (
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="field"
              rows={2}
              style={{ width: '100%', maxWidth: 420, height: 'auto', borderRadius: 12, padding: '8px 12px', lineHeight: 1.5, display: 'block' }}
            />
          ) : (
            group.description && <div className="group__desc">{group.description}</div>
          )}
          {editing && (
            <label style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }} className="text-secondary">
              <input
                type="checkbox"
                checked={dreamerIgnore}
                onChange={(e) => setDreamerIgnore(e.target.checked)}
              />
              Skip in Dreamer cycle (members' chats won't enter the vault)
            </label>
          )}
          {!editing && group.dreamerIgnore === true && (
            <div className="group__note">Dreamer ignore: ON · members' chats are not archived for the nightly cycle.</div>
          )}
        </div>

        <div className="group__side">
          <span>{agents.length} agent{agents.length !== 1 ? 's' : ''}</span>
          {editing ? (
            <>
              <button type="button" className="group__action" onClick={handleSave}>Save</button>
              <button type="button" className="group__action" onClick={() => setEditing(false)}>Cancel</button>
            </>
          ) : !isSystem ? (
            <>
              <button type="button" className="group__action" onClick={() => setEditing(true)}>Edit</button>
              {confirmDelete ? (
                <>
                  <button type="button" className="group__action" style={{ color: 'var(--dojo3-rust)' }} onClick={handleDelete}>Confirm delete</button>
                  <button type="button" className="group__action" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </>
              ) : (
                <button type="button" className="group__action" onClick={() => setConfirmDelete(true)}>Delete</button>
              )}
            </>
          ) : null}
        </div>
      </div>

      {agents.length === 0 ? (
        <p className="text-tertiary" style={{ fontSize: 12, padding: '16px 2px 2px' }}>
          {dragOver && !isSystem ? 'Drop here to add to this squad' : 'No agents in this group'}
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
