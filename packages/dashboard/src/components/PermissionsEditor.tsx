import { useState } from 'react';
import type { LegacyAccess } from '../lib/manifest-edits';

// The new-agent form's permission toggles. The state and its arithmetic are `lib/manifest-edits.ts`, the
// same the Access panel uses; this file only renders.

interface PermissionsEditorProps {
  state: LegacyAccess;
  onChange: (next: LegacyAccess) => void;
  compact?: boolean;
}

// ── Toggle Switch ──

const Toggle = ({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
  color?: string;
}) => {
  return (
    <button
      onClick={() => onChange(!enabled)}
      className={`toggle-switch ${enabled ? 'toggle-on' : ''}`}
    >
      <span className="toggle-knob" />
    </button>
  );
};

// ── Permission Row ──

const PermRow = ({
  label,
  description,
  enabled,
  onToggle,
  warning,
  children,
}: {
  label: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  warning?: boolean;
  children?: React.ReactNode;
}) => (
  <div className="py-3">
    <div className="flex items-center justify-between">
      <div className="flex-1 min-w-0 mr-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ui/90">{label}</span>
          {warning && enabled && (
            <span className="text-cp-amber-light text-xs" title="This permission can be dangerous">&#9888;</span>
          )}
        </div>
        <p className="text-xs text-ui/40 mt-0.5">{description}</p>
      </div>
      <Toggle enabled={enabled} onChange={onToggle} color={warning && enabled ? 'red' : 'blue'} />
    </div>
    {enabled && children && (
      <div className="mt-2 ml-1 pl-3 border-l-2 text-ui/25 overflow-hidden transition-all duration-200">
        {children}
      </div>
    )}
  </div>
);

// ── Sub-option: All vs Specific ──

const SubOption = ({
  allLabel,
  specificLabel,
  isAll,
  list,
  onAllChange,
  onListChange,
  placeholder,
}: {
  allLabel: string;
  specificLabel: string;
  isAll: boolean;
  list: string;
  onAllChange: (v: boolean) => void;
  onListChange: (v: string) => void;
  placeholder: string;
}) => (
  <div className="space-y-2">
    <div className="flex gap-3">
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input
          type="radio"
          checked={isAll}
          onChange={() => onAllChange(true)}
          className="text-cp-amber bg-ui/[0.05] text-ui/25 focus:ring-cp-amber focus:ring-offset-0"
        />
        <span className="text-xs text-ui/70">{allLabel}</span>
      </label>
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input
          type="radio"
          checked={!isAll}
          onChange={() => onAllChange(false)}
          className="text-cp-amber bg-ui/[0.05] text-ui/25 focus:ring-cp-amber focus:ring-offset-0"
        />
        <span className="text-xs text-ui/70">{specificLabel}</span>
      </label>
    </div>
    {!isAll && (
      <input
        value={list}
        onChange={(e) => onListChange(e.target.value)}
        placeholder={placeholder}
        className="glass-input w-full font-mono"
      />
    )}
  </div>
);

// ── Section Header ──

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div>
    <h4 className="text-[10px] font-bold text-ui/40 uppercase tracking-widest mb-1 px-1">{title}</h4>
    <div className="divide-y divide-gray-800">{children}</div>
  </div>
);

// ════════════════════════════════════════
// Main Component
// ════════════════════════════════════════

export const PermissionsEditor = ({ state, onChange, compact }: PermissionsEditorProps) => {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const set = (patch: Partial<LegacyAccess>) => onChange({ ...state, ...patch });
  const on = (key: keyof LegacyAccess) => (v: boolean) => set({ [key]: v });
  const gap = compact ? 'space-y-4' : 'space-y-5';

  return (
    <div className={gap}>
      {/* ── Files ── */}
      <Section title="Files">
        <PermRow label="Read Files" description="Allow this agent to read files on disk" enabled={state.readOn} onToggle={on('readOn')}>
          <SubOption allLabel="All files" specificLabel="Specific folders" isAll={state.readAll} list={state.readList}
            onAllChange={on('readAll')} onListChange={(v) => set({ readList: v })} placeholder="~/Projects/**, /tmp/**, ~/Desktop/*" />
        </PermRow>
        <PermRow label="Write Files" description="Allow this agent to create and modify files" enabled={state.writeOn} onToggle={on('writeOn')}>
          <SubOption allLabel="All files" specificLabel="Specific folders" isAll={state.writeAll} list={state.writeList}
            onAllChange={on('writeAll')} onListChange={(v) => set({ writeList: v })} placeholder="~/Projects/**, /tmp/**" />
        </PermRow>
      </Section>

      {/* ── Commands ── */}
      <Section title="Commands">
        <PermRow label="Run Terminal Commands" description="Allow this agent to execute shell commands" enabled={state.execOn} onToggle={on('execOn')} warning>
          <SubOption allLabel="All commands" specificLabel="Only these commands" isAll={state.execAll} list={state.execList}
            onAllChange={on('execAll')} onListChange={(v) => set({ execList: v })} placeholder="ls, cat, node, npm, git, grep, find" />
        </PermRow>
      </Section>

      {/* ── Web Access ── */}
      <Section title="Web Access">
        <PermRow label="Web Search" description="Search the web using Brave Search" enabled={state.searchOn} onToggle={on('searchOn')} />
        <PermRow label="Web Browsing" description="Open a headless browser to interact with web pages" enabled={state.browseOn} onToggle={on('browseOn')}>
          <SubOption allLabel="All websites" specificLabel="Only these domains" isAll={state.domainsAll} list={state.domainsList}
            onAllChange={on('domainsAll')} onListChange={(v) => set({ domainsList: v })} placeholder="github.com, docs.python.org, ..." />
        </PermRow>
      </Section>

      {/* ── System Control ── */}
      <Section title="System Control">
        <PermRow label="View the Screen" description="Take screenshots and read screen contents" enabled={state.screenOn} onToggle={on('screenOn')} />
        <PermRow label="Control the Mouse" description="Move and click the mouse cursor" enabled={state.mouseOn} onToggle={on('mouseOn')} />
        <PermRow label="Control the Keyboard" description="Type text and press keyboard shortcuts" enabled={state.keyboardOn} onToggle={on('keyboardOn')} />
        <PermRow label="Run AppleScripts" description="Automate macOS apps and system features" enabled={state.applescriptOn} onToggle={on('applescriptOn')} warning />
      </Section>

      {/* ── Delegation ── */}
      <Section title="Delegation">
        <PermRow label="Create Sub-Agents" description="Spawn new agents to delegate work" enabled={state.spawnOn} onToggle={on('spawnOn')} />
        <PermRow label="Assign Permissions" description="Set and change permissions for other agents it creates or manages" enabled={state.assignOn} onToggle={on('assignOn')} />
        <PermRow label="Share User Profile" description="Include your profile (About You) in this agent's context so it knows who you are" enabled={state.shareProfile} onToggle={on('shareProfile')} />
      </Section>

      {/* ── Advanced ── */}
      <div className="pt-2">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-2 text-xs text-ui/40 hover:text-ui/55 transition-colors"
        >
          <span>{showAdvanced ? '\u25BC' : '\u25B6'}</span>
          <span>Advanced (for power users)</span>
        </button>
        {showAdvanced && (
          <div className="mt-3 space-y-3 pl-1">
            <div>
              <label className="text-[10px] font-semibold text-ui/40 uppercase tracking-wide block mb-1">Blocked Commands</label>
              <input
                value={state.execDeny}
                onChange={(e) => set({ execDeny: e.target.value })}
                placeholder="rm -rf *, sudo *, ..."
                className="glass-input w-full font-mono"
              />
              <p className="text-[10px] text-ui/25 mt-0.5">Every agent but the main one is always refused rm -rf /, sudo and chmod 777.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-semibold text-ui/40 uppercase tracking-wide block mb-1">Allowed Tools (raw)</label>
                <input
                  value={state.rawAllow}
                  onChange={(e) => set({ rawAllow: e.target.value })}
                  placeholder="empty = all tools"
                  className="glass-input w-full font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-ui/40 uppercase tracking-wide block mb-1">Denied Tools (raw)</label>
                <input
                  value={state.rawDeny}
                  onChange={(e) => set({ rawDeny: e.target.value })}
                  placeholder="spawn_agent, kill_agent, ..."
                  className="glass-input w-full font-mono"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
