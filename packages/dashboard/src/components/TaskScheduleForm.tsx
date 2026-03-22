import { useState } from 'react';

export interface ScheduleConfig {
  scheduledStart: string | null;
  repeatInterval: number | null;
  repeatUnit: string | null;
  repeatEndType: string;
  repeatEndValue: string | null;
}

interface TaskScheduleFormProps {
  value: ScheduleConfig;
  onChange: (config: ScheduleConfig) => void;
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  scheduledStart: null,
  repeatInterval: null,
  repeatUnit: null,
  repeatEndType: 'never',
  repeatEndValue: null,
};

export const TaskScheduleForm = ({ value, onChange }: TaskScheduleFormProps) => {
  const [enabled, setEnabled] = useState(!!value.scheduledStart);
  const [repeatEnabled, setRepeatEnabled] = useState(!!value.repeatInterval);

  const update = (partial: Partial<ScheduleConfig>) => {
    onChange({ ...value, ...partial });
  };

  const handleToggle = (on: boolean) => {
    setEnabled(on);
    if (!on) {
      onChange(DEFAULT_SCHEDULE);
    } else {
      // Default to 1 hour from now
      const defaultStart = new Date(Date.now() + 3600000).toISOString().slice(0, 16);
      update({ scheduledStart: defaultStart });
    }
  };

  // Format datetime-local value from ISO
  const dateTimeValue = value.scheduledStart
    ? value.scheduledStart.includes('T')
      ? value.scheduledStart.slice(0, 16)
      : value.scheduledStart
    : '';

  return (
    <div className="space-y-3">
      {/* Toggle */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-white/70">Schedule this task</span>
        <button
          onClick={() => handleToggle(!enabled)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${enabled ? 'bg-cp-teal' : 'bg-white/[0.12]'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {enabled && (
        <div className="space-y-3 pl-2 border-l-2 border-white/[0.06]">
          {/* Start date/time */}
          <div>
            <label className="text-xs text-white/40 block mb-1">Start Date & Time</label>
            <input
              type="datetime-local"
              value={dateTimeValue}
              onChange={(e) => update({ scheduledStart: e.target.value ? new Date(e.target.value).toISOString() : null })}
              className="glass-input text-sm"
            />
          </div>

          {/* Repeat toggle */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-white/50">Repeat</span>
            <button
              onClick={() => {
                setRepeatEnabled(!repeatEnabled);
                if (repeatEnabled) update({ repeatInterval: null, repeatUnit: null, repeatEndType: 'never', repeatEndValue: null });
                else update({ repeatInterval: 1, repeatUnit: 'days' });
              }}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 ${repeatEnabled ? 'bg-cp-teal' : 'bg-white/[0.12]'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform duration-200 ${repeatEnabled ? 'translate-x-[18px]' : 'translate-x-[2px]'}`} />
            </button>
          </div>

          {repeatEnabled && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-white/40">Every</span>
                <input
                  type="number"
                  min={1}
                  value={value.repeatInterval ?? 1}
                  onChange={(e) => update({ repeatInterval: Number(e.target.value) })}
                  className="glass-input w-16 text-sm text-center py-1"
                />
                <select
                  value={value.repeatUnit ?? 'days'}
                  onChange={(e) => update({ repeatUnit: e.target.value })}
                  className="glass-select text-sm py-1"
                >
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                  <option value="weeks">Weeks</option>
                  <option value="months">Months</option>
                </select>
              </div>

              {/* End condition */}
              <div>
                <label className="text-xs text-white/40 block mb-1">End</label>
                <div className="space-y-1.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={value.repeatEndType === 'never'} onChange={() => update({ repeatEndType: 'never', repeatEndValue: null })}
                      className="text-cp-teal bg-white/[0.05] border-white/[0.12]" />
                    <span className="text-xs text-white/60">Never</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={value.repeatEndType === 'after_count'} onChange={() => update({ repeatEndType: 'after_count', repeatEndValue: '10' })}
                      className="text-cp-teal bg-white/[0.05] border-white/[0.12]" />
                    <span className="text-xs text-white/60">After</span>
                    {value.repeatEndType === 'after_count' && (
                      <input type="number" min={1} value={value.repeatEndValue ?? '10'}
                        onChange={(e) => update({ repeatEndValue: e.target.value })}
                        className="glass-input w-16 text-xs py-0.5 text-center" />
                    )}
                    <span className="text-xs text-white/40">runs</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={value.repeatEndType === 'on_date'} onChange={() => update({ repeatEndType: 'on_date', repeatEndValue: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) })}
                      className="text-cp-teal bg-white/[0.05] border-white/[0.12]" />
                    <span className="text-xs text-white/60">On</span>
                    {value.repeatEndType === 'on_date' && (
                      <input type="date" value={value.repeatEndValue ?? ''}
                        onChange={(e) => update({ repeatEndValue: e.target.value })}
                        className="glass-input text-xs py-0.5" />
                    )}
                  </label>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
