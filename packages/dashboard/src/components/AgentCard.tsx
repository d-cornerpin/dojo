import { useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import type { AgentDetail, Model } from '@dojo/shared';
import { StatusBadge } from './StatusBadge';
import * as api from '../lib/api';

interface AgentCardProps {
  agent: AgentDetail;
  models: Model[];
  onModelChanged: () => void;
}

// Cached sensei role lookup
let _senseiRoles: Record<string, string> | null = null;
async function getSenseiRoles(): Promise<Record<string, string>> {
  if (_senseiRoles) return _senseiRoles;
  const [primary, pm, trainer] = await Promise.all([
    api.getSetting('primary_agent_id'),
    api.getSetting('pm_agent_id'),
    api.getSetting('trainer_agent_id'),
  ]);
  _senseiRoles = {};
  if (primary.ok && primary.data.value) _senseiRoles[primary.data.value] = 'Dojo Master \u2014 Main Agent';
  if (pm.ok && pm.data.value) _senseiRoles[pm.data.value] = 'Dojo Planner \u2014 Task Agent';
  if (trainer.ok && trainer.data.value) _senseiRoles[trainer.data.value] = 'Dojo Trainer \u2014 Technique Agent';
  return _senseiRoles;
}

const classificationBadge: Record<string, { cls: string; label: string }> = {
  sensei: { cls: 'glass-badge-amber', label: 'Sensei' },
  ronin: { cls: 'glass-badge-blue', label: 'Ronin' },
  apprentice: { cls: 'glass-badge-gray', label: 'Apprentice' },
};

const agentColors = ['#F5A623', '#00D4AA', '#5B8DEF', '#A78BFA', '#FF6B8A', '#4AEDC4', '#7BA4F7'];

function getAgentColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return agentColors[Math.abs(hash) % agentColors.length];
}

const formatUptime = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
};

export const AgentCard = ({ agent, models, onModelChanged }: AgentCardProps) => {
  const navigate = useNavigate();
  const [changingModel, setChangingModel] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmTerminate, setConfirmTerminate] = useState(false);
  const [senseiRole, setSenseiRole] = useState<string | null>(null);

  useEffect(() => {
    if (agent.classification === 'sensei') {
      getSenseiRoles().then(roles => {
        setSenseiRole(roles[agent.id] ?? null);
      });
    }
  }, [agent.id, agent.classification]);

  const cls = classificationBadge[agent.classification] ?? classificationBadge.apprentice;
  const color = getAgentColor(agent.id);

  const handleModelChange = async (modelId: string) => {
    setSaving(true);
    const result = await api.setAgentModel(agent.id, modelId);
    if (result.ok) onModelChanged();
    setSaving(false);
    setChangingModel(false);
  };

  const isWorking = agent.status === 'working';
  const isError = agent.status === 'error';

  const cardContent = (
    <div
      onClick={() => navigate(`/agents/${agent.id}`)}
      draggable={agent.classification !== 'sensei'}
      onDragStart={(e) => {
        if (agent.classification === 'sensei') { e.preventDefault(); return; }
        e.dataTransfer.setData('agent-id', agent.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      className={`glass-card glass-card-hover p-5 cursor-pointer group relative ${
        agent.status === 'terminated' ? 'opacity-50' : ''
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold"
            style={{ background: `${color}20`, color }}>
            {agent.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className={`glass-badge ${cls.cls}`}>{cls.label}</span>
              <h3 className="text-base font-semibold text-white">{agent.name}</h3>
            </div>
            {senseiRole && <p className="text-[10px] text-white/40 mt-0.5">{senseiRole}</p>}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <StatusBadge status={agent.status} />
          {agent.classification !== 'sensei' && agent.status !== 'terminated' && (
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmTerminate(true); }}
              className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-cp-coral transition-all p-0.5"
              title="Dismiss agent"
            >
              &times;
            </button>
          )}
        </div>
      </div>

      {/* Terminate confirmation */}
      {confirmTerminate && (
        <div className="absolute inset-0 bg-black/80 rounded-2xl flex items-center justify-center gap-2 z-10"
          onClick={(e) => e.stopPropagation()}>
          <span className="text-xs text-white/70">Dismiss {agent.name} from the dojo?</span>
          <button
            onClick={async (e) => { e.stopPropagation(); await api.terminateAgent(agent.id); onModelChanged(); setConfirmTerminate(false); }}
            className="glass-btn glass-btn-destructive text-xs py-1 px-2"
          >Yes</button>
          <button onClick={(e) => { e.stopPropagation(); setConfirmTerminate(false); }}
            className="glass-btn glass-btn-ghost text-xs py-1 px-2"
          >No</button>
        </div>
      )}

      {/* Info rows */}
      <div className="space-y-2.5 text-sm">
        <div className="flex justify-between items-center">
          <span style={{ color: 'var(--text-secondary)' }}>Model</span>
          {changingModel ? (
            <select
              value={(agent.config as Record<string, unknown>)?.autoRouted ? 'auto' : (agent.modelId ?? '')}
              onChange={(e) => { e.stopPropagation(); handleModelChange(e.target.value); }}
              disabled={saving}
              autoFocus
              onBlur={() => !saving && setChangingModel(false)}
              onClick={(e) => e.stopPropagation()}
              className="glass-select text-xs py-1 px-2 w-40"
            >
              <option value="auto">Auto (Smart Router)</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setChangingModel(true); }}
              className="text-white/80 hover:text-cp-amber transition-colors text-right truncate max-w-[160px]"
            >
              {(agent.config as Record<string, unknown>)?.autoRouted
                ? <span className="text-cp-purple">Auto (Router)</span>
                : agent.model?.name || <span className="text-cp-amber">Not set</span>}
            </button>
          )}
        </div>

        <div className="flex justify-between">
          <span style={{ color: 'var(--text-secondary)' }}>Uptime</span>
          <span className="text-white/80">{formatUptime(agent.uptime)}</span>
        </div>
        <div className="flex justify-between">
          <span style={{ color: 'var(--text-secondary)' }}>Messages</span>
          <span className="text-white/80">{agent.messageCount.toLocaleString()}</span>
        </div>

        {/* Delete for terminated non-permanent */}
        {agent.status === 'terminated' && agent.classification !== 'sensei' && (
          <div className="pt-2 mt-2 border-t border-white/[0.06]">
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-cp-coral">Delete permanently?</span>
                <button
                  onClick={async (e) => { e.stopPropagation(); const r = await api.purgeAgent(agent.id); if (r.ok) onModelChanged(); setConfirmDelete(false); }}
                  className="glass-btn glass-btn-destructive text-xs py-1 px-2"
                >Yes</button>
                <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                  className="glass-btn glass-btn-ghost text-xs py-1 px-2"
                >Cancel</button>
              </div>
            ) : (
              <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                className="text-xs text-cp-coral hover:text-cp-coral/80 transition-colors"
              >Delete agent</button>
            )}
          </div>
        )}
      </div>
    </div>
  );

  if (isWorking || isError) {
    return (
      <div className={isWorking ? 'card-working-wrap' : ''}>
        {isWorking && (
          <>
            <div className="card-working-glow card-glow-amber" />
            <div className="card-working-border card-glow-amber" />
          </>
        )}
        {isError && <div className="card-error-glow" />}
        {cardContent}
      </div>
    );
  }

  return cardContent;
};
