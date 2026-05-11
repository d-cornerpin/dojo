import { useState } from 'react';

/** Convert a Date to "YYYY-MM-DDTHH:MM" in the browser's local timezone (for datetime-local inputs) */
function toLocalIso(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export interface ScheduleConfig {
  scheduledStart: string | null;
  repeatInterval: number | null;
  repeatUnit: string | null;
  repeatEndType: string;
  repeatEndValue: string | null;
  /** v2.5.2 — CSV of day-of-week ints (0=Sun..6=Sat) for repeatUnit='specific_days'. */
  repeatDaysOfWeek: string | null;
}

const DAY_PILLS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

function parseDaysCSV(s: string | null): Set<number> {
  if (!s) return new Set();
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const n = parseInt(part.trim(), 10);
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
  }
  return out;
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
  repeatDaysOfWeek: null,
};

export const TaskScheduleForm = ({ value, onChange }: TaskScheduleFormProps) => {
  const [enabled, setEnabled] = useState(!!value.scheduledStart);
  // v2.5.2 — a recurring schedule is identified by repeatUnit (the unit drives
  // the engine; interval is ignored for specific_days). Keying off interval
  // alone hid the picker for agent-created specific_days tasks.
  const [repeatEnabled, setRepeatEnabled] = useState(!!value.repeatUnit || !!value.repeatInterval);

  const update = (partial: Partial<ScheduleConfig>) => {
    onChange({ ...value, ...partial });
  };

  const handleToggle = (on: boolean) => {
    setEnabled(on);
    if (!on) {
      onChange(DEFAULT_SCHEDULE);
    } else {
      // Default to 1 hour from now in LOCAL time (for the datetime-local input)
      const future = new Date(Date.now() + 3600000);
      const localIso = toLocalIso(future);
      update({ scheduledStart: future.toISOString() });
      // We store UTC but display local -- the dateTimeValue getter handles conversion
    }
  };

  // Convert a UTC ISO string from the server to a local datetime-local value
  // datetime-local inputs expect "YYYY-MM-DDTHH:MM" in LOCAL time
  const dateTimeValue = (() => {
    if (!value.scheduledStart) return '';
    // Parse as UTC (append Z if missing)
    const utcStr = value.scheduledStart.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(value.scheduledStart)
      ? value.scheduledStart
      : value.scheduledStart + 'Z';
    const d = new Date(utcStr);
    if (isNaN(d.getTime())) return '';
    return toLocalIso(d);
  })();

  return (
    <div className="space-y-3">
      {/* Toggle */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-ui/70">Schedule this task</span>
        <button
          onClick={() => handleToggle(!enabled)}
          className={`toggle-switch ${enabled ? 'toggle-on' : ''}`}
        >
          <span className="toggle-knob" />
        </button>
      </div>

      {enabled && (
        <div className="space-y-3 pl-2 border-l-2 border-ui/[0.06]">
          {/* Start date/time */}
          <div>
            <label className="text-xs text-ui/40 block mb-1">Start Date & Time</label>
            <input
              type="datetime-local"
              value={dateTimeValue}
              onChange={(e) => update({ scheduledStart: e.target.value ? new Date(e.target.value).toISOString() : null })}
              className="glass-input text-sm"
            />
          </div>

          {/* Repeat toggle */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-ui/55">Repeat</span>
            <button
              onClick={() => {
                setRepeatEnabled(!repeatEnabled);
                if (repeatEnabled) update({ repeatInterval: null, repeatUnit: null, repeatEndType: 'never', repeatEndValue: null });
                else update({ repeatInterval: 1, repeatUnit: 'days' });
              }}
              className={`toggle-switch ${repeatEnabled ? 'toggle-on' : ''}`}
            >
              <span className="toggle-knob" />
            </button>
          </div>

          {repeatEnabled && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                {value.repeatUnit !== 'specific_days' && (
                  <>
                    <span className="text-xs text-ui/40">Every</span>
                    <input
                      type="number"
                      min={1}
                      value={value.repeatInterval ?? 1}
                      onChange={(e) => update({ repeatInterval: Number(e.target.value) })}
                      className="glass-input w-16 text-sm text-center py-1"
                    />
                  </>
                )}
                <select
                  value={value.repeatUnit ?? 'days'}
                  onChange={(e) => {
                    const nextUnit = e.target.value;
                    if (nextUnit === 'specific_days') {
                      // Switching to specific_days: interval is fixed at 1, clear it from UI
                      update({ repeatUnit: nextUnit, repeatInterval: 1, repeatDaysOfWeek: value.repeatDaysOfWeek ?? '' });
                    } else {
                      update({ repeatUnit: nextUnit, repeatDaysOfWeek: null });
                    }
                  }}
                  className="glass-select text-sm py-1"
                >
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                  <option value="weekdays">Weekdays (Mon–Fri)</option>
                  <option value="weeks">Weeks</option>
                  <option value="months">Months</option>
                  <option value="specific_days">Specific days of week…</option>
                </select>
              </div>

              {value.repeatUnit === 'specific_days' && (
                <div>
                  <label className="text-xs text-ui/40 block mb-1">Days</label>
                  <div className="flex flex-wrap gap-1.5">
                    {DAY_PILLS.map((pill) => {
                      const selected = parseDaysCSV(value.repeatDaysOfWeek);
                      const isOn = selected.has(pill.value);
                      return (
                        <button
                          key={pill.value}
                          type="button"
                          onClick={() => {
                            const next = new Set(selected);
                            if (isOn) next.delete(pill.value);
                            else next.add(pill.value);
                            const csv = [...next].sort((a, b) => a - b).join(',');
                            update({ repeatDaysOfWeek: csv.length > 0 ? csv : '' });
                          }}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                            isOn
                              ? 'bg-cp-teal/20 text-cp-teal border border-cp-teal/40'
                              : 'bg-ui/[0.05] text-ui/55 border border-ui/[0.10] hover:bg-ui/[0.08]'
                          }`}
                        >
                          {pill.label}
                        </button>
                      );
                    })}
                  </div>
                  {!value.repeatDaysOfWeek && (
                    <p className="text-[11px] text-cp-coral/70 mt-1">Select at least one day.</p>
                  )}
                </div>
              )}

              {/* End condition */}
              <div>
                <label className="text-xs text-ui/40 block mb-1">End</label>
                <div className="space-y-1.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={value.repeatEndType === 'never'} onChange={() => update({ repeatEndType: 'never', repeatEndValue: null })}
                      className="text-cp-teal bg-ui/[0.05] border-ui/[0.15]" />
                    <span className="text-xs text-ui/55">Never</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={value.repeatEndType === 'after_count'} onChange={() => update({ repeatEndType: 'after_count', repeatEndValue: '10' })}
                      className="text-cp-teal bg-ui/[0.05] border-ui/[0.15]" />
                    <span className="text-xs text-ui/55">After</span>
                    {value.repeatEndType === 'after_count' && (
                      <input type="number" min={1} value={value.repeatEndValue ?? '10'}
                        onChange={(e) => update({ repeatEndValue: e.target.value })}
                        className="glass-input w-16 text-xs py-0.5 text-center" />
                    )}
                    <span className="text-xs text-ui/40">runs</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={value.repeatEndType === 'on_date'} onChange={() => update({ repeatEndType: 'on_date', repeatEndValue: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) })}
                      className="text-cp-teal bg-ui/[0.05] border-ui/[0.15]" />
                    <span className="text-xs text-ui/55">On</span>
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
