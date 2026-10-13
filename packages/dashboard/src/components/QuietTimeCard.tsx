import { useState, useEffect } from 'react';
import type { AgentDetail } from '@dojo/shared';
import * as api from '../lib/api';
import { useToast } from '../hooks/useToast';

// t143 (OR-LONG-JOBS): how long this agent may show no sign of work at all — no tokens in or out,
// no request open, no tool started or finished — before the owner is told it has gone silent.
// Empty means the default, 2 hours. A known-slow agent can be given longer; there is no upper
// limit. Same settings-card primitives as the Memory card beside it.
export const DEFAULT_QUIET_MINUTES = 120;

export const QuietTimeCard = ({ agent, onUpdated }: { agent: AgentDetail; onUpdated: () => void }) => {
  const [value, setValue] = useState(agent.silentWindowMinutes == null ? '' : String(agent.silentWindowMinutes));
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setValue(agent.silentWindowMinutes == null ? '' : String(agent.silentWindowMinutes));
  }, [agent.silentWindowMinutes]);

  const save = async () => {
    const trimmed = value.trim();
    const minutes = trimmed === '' ? null : Number(trimmed);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1)) {
      toast.error('Enter a whole number of minutes (1 or more), or leave it empty for 2 hours.');
      return;
    }
    setSaving(true);
    const result = await api.updateAgentConfig(agent.id, { silentWindowMinutes: minutes });
    setSaving(false);
    if (result.ok) {
      toast.success(minutes === null ? 'Quiet time back to the 2-hour default' : `Quiet time set to ${minutes} minutes`);
      onUpdated();
    } else {
      toast.error(result.error || 'Could not save the quiet time.');
    }
  };

  return (
    <div className="tile">
      <div className="scard__title">Long jobs</div>
      <div className="scard__desc">
        This agent is left alone to work for as long as a job takes. You are told only if it shows no sign of
        work at all for this long. Give a slow agent more time; leave it empty for the default of 2 hours.
      </div>
      <label className="flabel" htmlFor={`quiet-${agent.id}`}>Quiet time before you are told (minutes)</label>
      <div className="srow">
        <input
          id={`quiet-${agent.id}`}
          type="number"
          min={1}
          step={1}
          placeholder={String(DEFAULT_QUIET_MINUTES)}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="finput"
        />
        <button type="button" onClick={save} disabled={saving} className="btn btn--primary btn--sm">
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
};
