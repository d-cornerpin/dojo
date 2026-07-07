import { useNavigate } from 'react-router-dom';
import { useState, useEffect, type CSSProperties } from 'react';
import type { AgentDetail, Model } from '@dojo/shared';
import * as api from '../lib/api';
import { useActiveAgent } from './ActiveAgentProvider';
import { resolveAgentHue, ORB_PALETTE, CHAMPAGNE_HUE } from '../lib/agent-hue';

interface AgentCardProps {
  agent: AgentDetail;
  models: Model[];
  providerNameById: Record<string, string>;
  onModelChanged: () => void;
  /** Stagger index for the card-entry animation (sets --ci). */
  index?: number;
}

// Cached sensei role lookup
let _senseiRoles: Record<string, string> | null = null;
async function getSenseiRoles(): Promise<Record<string, string>> {
  if (_senseiRoles) return _senseiRoles;
  const [primary, pm, trainer, imaginer, healer, dreamer] = await Promise.all([
    api.getSetting('primary_agent_id'),
    api.getSetting('pm_agent_id'),
    api.getSetting('trainer_agent_id'),
    api.getSetting('imaginer_agent_id'),
    api.getSetting('healer_agent_id'),
    api.getSetting('dreamer_agent_id'),
  ]);
  _senseiRoles = {};
  if (primary.ok && primary.data.value) _senseiRoles[primary.data.value] = 'Dojo Master · Main Agent';
  if (pm.ok && pm.data.value) _senseiRoles[pm.data.value] = 'Dojo Planner · Task Agent';
  if (trainer.ok && trainer.data.value) _senseiRoles[trainer.data.value] = 'Dojo Trainer · Technique Agent';
  if (imaginer.ok && imaginer.data.value) _senseiRoles[imaginer.data.value] = 'Dojo Imaginer · Image Agent';
  if (healer.ok && healer.data.value) _senseiRoles[healer.data.value] = 'Dojo Healer · Health Agent';
  if (dreamer.ok && dreamer.data.value) _senseiRoles[dreamer.data.value] = 'Dojo Dreamer · Memory Agent';
  return _senseiRoles;
}

// Classification -> badge style + label. Apprentice reuses the ronin style.
const classificationBadge: Record<string, { cls: string; label: string }> = {
  sensei: { cls: 'badge--sensei', label: 'Sensei' },
  ronin: { cls: 'badge--ronin', label: 'Ronin' },
  apprentice: { cls: 'badge--ronin', label: 'Apprentice' },
};

// The avatar tint (--h) now comes from the shared resolver (lib/agent-hue), so
// the box and the orb always use the same hue. A small palette popover on the
// avatar lets the user pick a colour for any non-primary agent.

// Swatch palette popover anchored under an agent's avatar.
const ColorPicker = ({ current, onPick, onClose }: {
  current: number; onPick: (hue: number) => void; onClose: () => void;
}) => (
  <>
    <div className="agent-color-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }} />
    <div className="agent-color-pop" onClick={(e) => e.stopPropagation()} role="menu" aria-label="Agent colour">
      {ORB_PALETTE.map((c) => (
        <button
          key={c.hue}
          type="button"
          className={`agent-color-swatch${Math.round(current) === c.hue ? ' is-active' : ''}`}
          style={{ '--h': c.hue } as CSSProperties}
          title={c.name}
          aria-label={c.name}
          onClick={() => onPick(c.hue)}
        />
      ))}
    </div>
  </>
);

// Status pill: green "Ready" by default; override colour inline for the rest.
const statusPresentation: Record<string, { label: string; color?: string }> = {
  idle: { label: 'Ready' },
  paused: { label: 'Ready' },
  working: { label: 'Working', color: '#a4762e' },
  error: { label: 'Error', color: '#9c4434' },
  terminated: { label: 'Ended', color: 'var(--dojo3-ink-4)' },
};

const formatUptime = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
};

export const AgentCard = ({ agent, models, providerNameById, onModelChanged, index = 0 }: AgentCardProps) => {
  const navigate = useNavigate();
  const { selectAgent, agentId: activeAgentId, primaryId } = useActiveAgent();
  const [changingModel, setChangingModel] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmTerminate, setConfirmTerminate] = useState(false);
  const [senseiRole, setSenseiRole] = useState<string | null>(null);
  const [colorOpen, setColorOpen] = useState(false);
  // Local override so a freshly-picked colour shows immediately (the agent prop
  // only refreshes on reload). null = use the agent's stored/derived hue.
  const [localHue, setLocalHue] = useState<number | null>(null);

  useEffect(() => {
    if (agent.classification === 'sensei') {
      getSenseiRoles().then(roles => {
        setSenseiRole(roles[agent.id] ?? null);
      });
    }
  }, [agent.id, agent.classification]);

  const badge = classificationBadge[agent.classification] ?? classificationBadge.apprentice;
  const isThisPrimary = primaryId != null && agent.id === primaryId;
  // One hue for both the avatar box and the orb. Primary is always champagne.
  const hue = isThisPrimary ? CHAMPAGNE_HUE : (localHue ?? resolveAgentHue(agent, false));
  const status = statusPresentation[agent.status] ?? statusPresentation.idle;

  const pickColor = async (h: number) => {
    setLocalHue(h);
    setColorOpen(false);
    // Live-update the orb if this agent is the active one.
    if (activeAgentId === agent.id) selectAgent({ id: agent.id, name: agent.name, hue: h });
    await api.updateAgentConfig(agent.id, { config: { orbHue: h } });
  };
  const isAuto = agent.modelId === 'auto';

  const isWorking = agent.status === 'working';
  const isTerminated = agent.status === 'terminated';
  const canDismiss = agent.classification !== 'sensei' && !isTerminated;
  const canDelete = agent.classification !== 'sensei' && isTerminated;

  const handleModelChange = async (modelId: string) => {
    setSaving(true);
    const result = await api.setAgentModel(agent.id, modelId);
    if (result.ok) onModelChanged();
    setSaving(false);
    setChangingModel(false);
  };

  const cardStyle = {
    '--h': hue,
    '--ci': `${index * 35}ms`,
    position: 'relative',
    cursor: 'pointer',
    opacity: agent.status === 'terminated' ? 0.55 : 1,
  } as CSSProperties;

  // Light scrim for the confirm overlays, sized to the card radius.
  const scrimStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    borderRadius: 18,
    background: 'rgba(60,46,30,0.55)',
    color: '#fdf6ea',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    flexWrap: 'wrap',
    padding: '0 12px',
    zIndex: 10,
  };

  return (
    <article
      className="agent-card"
      style={cardStyle}
      onClick={() => { selectAgent({ id: agent.id, name: agent.name, hue: isThisPrimary ? undefined : hue }); navigate('/'); }}
      draggable={agent.classification !== 'sensei' && window.innerWidth >= 768}
      onDragStart={(e) => {
        if (agent.classification === 'sensei' || window.innerWidth < 768) { e.preventDefault(); return; }
        e.dataTransfer.setData('agent-id', agent.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      title={`Chat with ${agent.name}`}
    >
      <header className="agent-card__head">
        {isThisPrimary ? (
          <div className="agent-card__avatar" title="The dojo master keeps the signature champagne">
            {agent.name.charAt(0).toUpperCase()}
          </div>
        ) : (
          <div className="agent-card__avatar-wrap" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="agent-card__avatar agent-card__avatar--btn"
              onClick={() => setColorOpen((o) => !o)}
              title={`Set ${agent.name}'s colour`}
              aria-haspopup="menu"
              aria-expanded={colorOpen}
            >
              {agent.name.charAt(0).toUpperCase()}
            </button>
            {colorOpen && (
              <ColorPicker current={hue} onPick={pickColor} onClose={() => setColorOpen(false)} />
            )}
          </div>
        )}
        <div className="agent-card__id min-w-0">
          <div className="agent-card__name min-w-0">
            <span className={`badge ${badge.cls} shrink-0`}>{badge.label}</span>
            <span className="truncate" title={agent.name}>{agent.name}</span>
          </div>
          {senseiRole && <div className="agent-card__role">{senseiRole}</div>}
        </div>
        <span className="status" style={status.color ? { color: status.color } : undefined}>
          <i style={status.color ? { background: status.color, boxShadow: 'none' } : undefined} />
          {status.label}
        </span>
        <button
          type="button"
          className="agent-card__cog"
          title="Agent details and settings"
          aria-label={`${agent.name} details and settings`}
          onClick={(e) => { e.stopPropagation(); navigate(`/agents/${agent.id}`); }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </header>

      <dl className="agent-card__stats">
        <div>
          <dt>Model</dt>
          {changingModel ? (
            <dd>
              <select
                value={isAuto ? 'auto' : (agent.modelId ?? '')}
                onChange={(e) => { e.stopPropagation(); handleModelChange(e.target.value); }}
                disabled={saving}
                autoFocus
                onBlur={() => !saving && setChangingModel(false)}
                onClick={(e) => e.stopPropagation()}
                className="field field--select"
                style={{ height: 28, lineHeight: '26px', fontSize: 11, maxWidth: 170 }}
              >
                <option value="auto">Auto (Smart Router)</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {providerNameById[m.providerId] ? ` (${providerNameById[m.providerId]})` : ''}
                  </option>
                ))}
              </select>
            </dd>
          ) : (
            <dd
              className={isAuto ? 'acc' : undefined}
              onClick={(e) => { e.stopPropagation(); setChangingModel(true); }}
              style={{ cursor: 'pointer' }}
              title="Change model"
            >
              {isAuto
                ? 'Auto (Router)'
                : agent.model?.name || 'Not set'}
            </dd>
          )}
        </div>
        <div>
          <dt>Uptime</dt>
          <dd>{formatUptime(agent.uptime)}</dd>
        </div>
        <div>
          <dt>Messages</dt>
          <dd>{agent.messageCount.toLocaleString()}</dd>
        </div>
      </dl>

      {/* Inline actions: stop (working), dismiss (non-sensei active) */}
      {(isWorking || canDismiss) && (
        <div className="tagrow" style={{ marginTop: 11 }} onClick={(e) => e.stopPropagation()}>
          {isWorking && (
            <button
              type="button"
              className="group__action"
              onClick={async (e) => { e.stopPropagation(); await api.stopAgent(agent.id); onModelChanged(); }}
            >
              Stop
            </button>
          )}
          {canDismiss && (
            <button
              type="button"
              className="group__action"
              style={{ color: 'var(--dojo3-rust)' }}
              onClick={(e) => { e.stopPropagation(); setConfirmTerminate(true); }}
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Delete for terminated non-sensei */}
      {canDelete && (
        <div className="tagrow" style={{ marginTop: 11 }} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="group__action"
            style={{ color: 'var(--dojo3-rust)' }}
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
          >
            Delete agent
          </button>
        </div>
      )}

      {/* Dismiss/terminate confirm */}
      {confirmTerminate && (
        <div style={scrimStyle} onClick={(e) => e.stopPropagation()}>
          <span style={{ fontSize: 12 }}>Dismiss {agent.name}?</span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={async (e) => { e.stopPropagation(); await api.terminateAgent(agent.id); onModelChanged(); setConfirmTerminate(false); }}
          >
            Yes
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={(e) => { e.stopPropagation(); setConfirmTerminate(false); }}
          >
            No
          </button>
        </div>
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <div style={scrimStyle} onClick={(e) => e.stopPropagation()}>
          <span style={{ fontSize: 12 }}>Delete permanently?</span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={async (e) => { e.stopPropagation(); const r = await api.purgeAgent(agent.id); if (r.ok) onModelChanged(); setConfirmDelete(false); }}
          >
            Yes
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
          >
            Cancel
          </button>
        </div>
      )}
    </article>
  );
};
