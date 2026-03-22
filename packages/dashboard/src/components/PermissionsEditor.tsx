import { useState, useEffect, useCallback, useRef } from 'react';
import type { PermissionManifest } from '@dojo/shared';

// ════════════════════════════════════════
// Permissions Editor — Toggle-based UI
// Maps friendly toggles to PermissionManifest
// ════════════════════════════════════════

interface PermissionsEditorProps {
  permissions: Partial<PermissionManifest>;
  toolsPolicy?: { allow: string[]; deny: string[] };
  shareUserProfile?: boolean;
  onChange: (perms: Partial<PermissionManifest>, toolsPolicy: { allow: string[]; deny: string[] }, shareUserProfile: boolean) => void;
  compact?: boolean;
}

// ── Helpers ──

function hasPath(val: unknown): boolean {
  if (val === '*') return true;
  if (Array.isArray(val) && val.length > 0) return true;
  return false;
}

function isAll(val: unknown): boolean {
  return val === '*' || (Array.isArray(val) && val.includes('*'));
}

function toList(val: unknown): string {
  if (Array.isArray(val)) return val.filter(v => v !== '*').join(', ');
  return '';
}

function hasSysControl(perms: Partial<PermissionManifest>, key: string): boolean {
  const sc = perms.system_control;
  if (!Array.isArray(sc)) return false;
  return sc.includes('*') || sc.includes(key);
}

function hasExecAll(perms: Partial<PermissionManifest>): boolean {
  return Array.isArray(perms.exec_allow) && perms.exec_allow.includes('*');
}

function hasToolAccess(policy: { allow?: string[]; deny?: string[] } | undefined | null, tool: string): boolean {
  if (!policy) return true; // no policy = all tools
  const deny = policy.deny ?? [];
  const allow = policy.allow ?? [];
  if (deny.includes(tool)) return false;
  if (allow.length === 0) return true; // empty allow = all
  return allow.includes(tool);
}

// ── Toggle Switch ──

const Toggle = ({
  enabled,
  onChange,
  color = 'blue',
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
  color?: 'blue' | 'red' | 'green';
}) => {
  const bg = enabled
    ? color === 'red' ? 'bg-red-500' : color === 'green' ? 'bg-green-500' : 'bg-blue-500'
    : 'bg-white/[0.12]';

  return (
    <button
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${bg}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
          enabled ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
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
          <span className="text-sm font-medium white/90">{label}</span>
          {warning && enabled && (
            <span className="text-orange-400 text-xs" title="This permission can be dangerous">&#9888;</span>
          )}
        </div>
        <p className="text-xs white/40 mt-0.5">{description}</p>
      </div>
      <Toggle enabled={enabled} onChange={onToggle} color={warning && enabled ? 'red' : 'blue'} />
    </div>
    {enabled && children && (
      <div className="mt-2 ml-1 pl-3 border-l-2 white/[0.08] overflow-hidden transition-all duration-200">
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
          className="text-blue-500 bg-white/[0.05] white/[0.10] focus:ring-blue-500 focus:ring-offset-0"
        />
        <span className="text-xs white/70">{allLabel}</span>
      </label>
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input
          type="radio"
          checked={!isAll}
          onChange={() => onAllChange(false)}
          className="text-blue-500 bg-white/[0.05] white/[0.10] focus:ring-blue-500 focus:ring-offset-0"
        />
        <span className="text-xs white/70">{specificLabel}</span>
      </label>
    </div>
    {!isAll && (
      <input
        value={list}
        onChange={(e) => onListChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-1.5 bg-white/[0.04] border white/[0.08] rounded-lg text-xs white/90 font-mono placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    )}
  </div>
);

// ── Section Header ──

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div>
    <h4 className="text-[10px] font-bold white/40 uppercase tracking-widest mb-1 px-1">{title}</h4>
    <div className="divide-y divide-gray-800">{children}</div>
  </div>
);

// ════════════════════════════════════════
// Main Component
// ════════════════════════════════════════

export const PermissionsEditor = ({ permissions, toolsPolicy, shareUserProfile: initialShareProfile, onChange, compact }: PermissionsEditorProps) => {
  // Suppress onChange during initial mount
  const mountedRef = useRef(false);

  // ── Files ──
  const [readOn, setReadOn] = useState(hasPath(permissions.file_read));
  const [readAll, setReadAll] = useState(isAll(permissions.file_read));
  const [readList, setReadList] = useState(toList(permissions.file_read));

  const [writeOn, setWriteOn] = useState(hasPath(permissions.file_write));
  const [writeAll, setWriteAll] = useState(isAll(permissions.file_write));
  const [writeList, setWriteList] = useState(toList(permissions.file_write));

  const [deleteOn, setDeleteOn] = useState(hasPath(permissions.file_delete) && permissions.file_delete !== 'none');
  const [deleteAll, setDeleteAll] = useState(false); // delete never defaults to all
  const [deleteList, setDeleteList] = useState(toList(permissions.file_delete));

  // ── Exec ──
  const [execOn, setExecOn] = useState(Array.isArray(permissions.exec_allow) && permissions.exec_allow.length > 0);
  const [execAll, setExecAll] = useState(hasExecAll(permissions));
  const [execList, setExecList] = useState(
    Array.isArray(permissions.exec_allow) ? permissions.exec_allow.filter(c => c !== '*').join(', ') : '',
  );

  // ── Web ──
  const [webSearchOn, setWebSearchOn] = useState(
    hasToolAccess(toolsPolicy, 'web_search') && hasToolAccess(toolsPolicy, 'web_fetch'),
  );
  const [webBrowseOn, setWebBrowseOn] = useState(
    hasSysControl(permissions, 'web_browse') || hasToolAccess(toolsPolicy, 'web_browse'),
  );
  const [webDomainsAll, setWebDomainsAll] = useState(isAll(permissions.network_domains) || permissions.network_domains === '*');
  const [webDomainsList, setWebDomainsList] = useState(toList(permissions.network_domains));

  // ── System Control ──
  const [screenOn, setScreenOn] = useState(hasSysControl(permissions, 'screen'));
  const [mouseOn, setMouseOn] = useState(hasSysControl(permissions, 'mouse'));
  const [keyboardOn, setKeyboardOn] = useState(hasSysControl(permissions, 'keyboard'));
  const [applescriptOn, setApplescriptOn] = useState(hasSysControl(permissions, 'applescript'));

  // ── Communication & Delegation ──
  const [imessageOn, setImessageOn] = useState(hasToolAccess(toolsPolicy, 'imessage_send'));
  const [spawnOn, setSpawnOn] = useState(permissions.can_spawn_agents ?? false);
  const [assignPermsOn, setAssignPermsOn] = useState(permissions.can_assign_permissions ?? false);
  const [shareProfile, setShareProfile] = useState(initialShareProfile ?? false);

  // ── Advanced ──
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [execDeny, setExecDeny] = useState((permissions.exec_deny ?? []).join(', '));
  const [maxProcesses, setMaxProcesses] = useState(permissions.max_processes ?? 3);
  const [rawToolsAllow, setRawToolsAllow] = useState((toolsPolicy?.allow ?? []).join(', '));
  const [rawToolsDeny, setRawToolsDeny] = useState((toolsPolicy?.deny ?? []).join(', '));

  // ── Build PermissionManifest + ToolsPolicy from toggle state ──

  const buildOutput = useCallback(() => {
    // File permissions
    const file_read: string[] | '*' = !readOn ? ([] as string[]) : readAll ? '*' : readList.split(',').map(s => s.trim()).filter(Boolean);
    const file_write: string[] | '*' = !writeOn ? ([] as string[]) : writeAll ? '*' : writeList.split(',').map(s => s.trim()).filter(Boolean);
    const file_delete: string[] | 'none' = !deleteOn ? 'none' : deleteAll ? ['/tmp/**'] : deleteList.split(',').map(s => s.trim()).filter(Boolean);

    // Exec
    const exec_allow: string[] = !execOn ? [] : execAll ? ['*'] : execList.split(',').map(s => s.trim()).filter(Boolean);
    const exec_deny: string[] = execDeny.split(',').map(s => s.trim()).filter(Boolean);

    // Network — ON if web search or web browse is on
    const anyWeb = webSearchOn || webBrowseOn;
    const network_domains: string[] | '*' | 'none' = !anyWeb ? 'none' : webDomainsAll ? '*' : webDomainsList.split(',').map(s => s.trim()).filter(Boolean);

    // System control
    const system_control: string[] = [];
    if (screenOn) system_control.push('screen');
    if (mouseOn) system_control.push('mouse');
    if (keyboardOn) system_control.push('keyboard');
    if (applescriptOn) system_control.push('applescript');
    if (webBrowseOn) system_control.push('web_browse');

    const perms: Partial<PermissionManifest> = {
      file_read,
      file_write,
      file_delete,
      exec_allow,
      exec_deny,
      network_domains,
      max_processes: maxProcesses,
      can_spawn_agents: spawnOn,
      can_assign_permissions: assignPermsOn,
      system_control,
    };

    // Tools policy — build deny list from toggles
    const toolsDeny: string[] = [];
    if (!webSearchOn) { toolsDeny.push('web_search', 'web_fetch'); }
    if (!webBrowseOn) { toolsDeny.push('web_browse'); }
    if (!imessageOn) { toolsDeny.push('imessage_send'); }

    // Merge with raw advanced overrides
    const advAllow = rawToolsAllow.split(',').map(s => s.trim()).filter(Boolean);
    const advDeny = rawToolsDeny.split(',').map(s => s.trim()).filter(Boolean);
    const mergedDeny = [...new Set([...toolsDeny, ...advDeny])];

    return { perms, tools: { allow: advAllow, deny: mergedDeny }, shareProfile };
  }, [
    readOn, readAll, readList, writeOn, writeAll, writeList, deleteOn, deleteAll, deleteList,
    execOn, execAll, execList, execDeny, webSearchOn, webBrowseOn, webDomainsAll, webDomainsList,
    screenOn, mouseOn, keyboardOn, applescriptOn, imessageOn, spawnOn, assignPermsOn,
    maxProcesses, rawToolsAllow, rawToolsDeny, shareProfile,
  ]);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    const { perms, tools, shareProfile: sp } = buildOutput();
    onChange(perms, tools, sp);
  }, [buildOutput]);

  const gap = compact ? 'space-y-4' : 'space-y-5';

  return (
    <div className={gap}>
      {/* ── Files ── */}
      <Section title="Files">
        <PermRow label="Read Files" description="Allow this agent to read files on disk" enabled={readOn} onToggle={setReadOn}>
          <SubOption allLabel="All files" specificLabel="Specific folders" isAll={readAll} list={readList}
            onAllChange={setReadAll} onListChange={setReadList} placeholder="~/Projects/**, /tmp/**, ~/Desktop/*" />
        </PermRow>
        <PermRow label="Write Files" description="Allow this agent to create and modify files" enabled={writeOn} onToggle={setWriteOn}>
          <SubOption allLabel="All files" specificLabel="Specific folders" isAll={writeAll} list={writeList}
            onAllChange={setWriteAll} onListChange={setWriteList} placeholder="~/Projects/**, /tmp/**" />
        </PermRow>
        <PermRow label="Delete Files" description="Allow this agent to permanently delete files" enabled={deleteOn} onToggle={setDeleteOn} warning>
          <SubOption allLabel="All files" specificLabel="Specific folders" isAll={deleteAll} list={deleteList}
            onAllChange={setDeleteAll} onListChange={setDeleteList} placeholder="/tmp/**" />
        </PermRow>
      </Section>

      {/* ── Commands ── */}
      <Section title="Commands">
        <PermRow label="Run Terminal Commands" description="Allow this agent to execute shell commands" enabled={execOn} onToggle={setExecOn} warning>
          <SubOption allLabel="All commands" specificLabel="Only these commands" isAll={execAll} list={execList}
            onAllChange={setExecAll} onListChange={setExecList} placeholder="ls, cat, node, npm, git, grep, find" />
        </PermRow>
      </Section>

      {/* ── Web Access ── */}
      <Section title="Web Access">
        <PermRow label="Web Search" description="Search the web using Brave Search" enabled={webSearchOn} onToggle={setWebSearchOn} />
        <PermRow label="Web Browsing" description="Open a headless browser to interact with web pages" enabled={webBrowseOn} onToggle={setWebBrowseOn}>
          <SubOption allLabel="All websites" specificLabel="Only these domains" isAll={webDomainsAll} list={webDomainsList}
            onAllChange={setWebDomainsAll} onListChange={setWebDomainsList} placeholder="github.com, docs.python.org, ..." />
        </PermRow>
      </Section>

      {/* ── System Control ── */}
      <Section title="System Control">
        <PermRow label="View the Screen" description="Take screenshots and read screen contents" enabled={screenOn} onToggle={setScreenOn} />
        <PermRow label="Control the Mouse" description="Move and click the mouse cursor" enabled={mouseOn} onToggle={setMouseOn} />
        <PermRow label="Control the Keyboard" description="Type text and press keyboard shortcuts" enabled={keyboardOn} onToggle={setKeyboardOn} />
        <PermRow label="Run AppleScripts" description="Automate macOS apps and system features" enabled={applescriptOn} onToggle={setApplescriptOn} warning />
      </Section>

      {/* ── Communication & Delegation ── */}
      <Section title="Communication & Delegation">
        <PermRow label="Send iMessages" description="Send messages via iMessage to approved contacts" enabled={imessageOn} onToggle={setImessageOn} />
        <PermRow label="Create Sub-Agents" description="Spawn new agents to delegate work" enabled={spawnOn} onToggle={setSpawnOn} />
        <PermRow label="Assign Permissions" description="Set and change permissions for other agents it creates or manages" enabled={assignPermsOn} onToggle={setAssignPermsOn} />
        <PermRow label="Share User Profile" description="Include your profile (About You) in this agent's context so it knows who you are" enabled={shareProfile} onToggle={setShareProfile} />
      </Section>

      {/* ── Advanced ── */}
      <div className="pt-2">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-2 text-xs white/40 hover:white/55 transition-colors"
        >
          <span>{showAdvanced ? '\u25BC' : '\u25B6'}</span>
          <span>Advanced (for power users)</span>
        </button>
        {showAdvanced && (
          <div className="mt-3 space-y-3 pl-1">
            <div>
              <label className="text-[10px] font-semibold white/40 uppercase tracking-wide block mb-1">Blocked Commands</label>
              <input
                value={execDeny}
                onChange={(e) => setExecDeny(e.target.value)}
                placeholder="rm -rf *, sudo *, ..."
                className="w-full px-3 py-1.5 bg-white/[0.04] border white/[0.08] rounded-lg text-xs white/90 font-mono placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <p className="text-[10px] white/30 mt-0.5">Global deny (rm -rf /, sudo *, chmod 777 *) always enforced.</p>
            </div>
            <div>
              <label className="text-[10px] font-semibold white/40 uppercase tracking-wide block mb-1">Max Processes</label>
              <input
                type="number"
                min={1}
                max={50}
                value={maxProcesses}
                onChange={(e) => setMaxProcesses(Number(e.target.value))}
                className="w-20 px-3 py-1.5 bg-white/[0.04] border white/[0.08] rounded-lg text-xs white/90 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold white/40 uppercase tracking-wide block mb-1">Network Domains (raw)</label>
              <input
                value={webDomainsAll ? '*' : webDomainsList}
                onChange={(e) => {
                  if (e.target.value === '*') { setWebDomainsAll(true); }
                  else { setWebDomainsAll(false); setWebDomainsList(e.target.value); }
                }}
                placeholder="* for all, or comma-separated domains"
                className="w-full px-3 py-1.5 bg-white/[0.04] border white/[0.08] rounded-lg text-xs white/90 font-mono placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-semibold white/40 uppercase tracking-wide block mb-1">Allowed Tools (raw)</label>
                <input
                  value={rawToolsAllow}
                  onChange={(e) => setRawToolsAllow(e.target.value)}
                  placeholder="empty = all tools"
                  className="w-full px-3 py-1.5 bg-white/[0.04] border white/[0.08] rounded-lg text-xs white/90 font-mono placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold white/40 uppercase tracking-wide block mb-1">Denied Tools (raw)</label>
                <input
                  value={rawToolsDeny}
                  onChange={(e) => setRawToolsDeny(e.target.value)}
                  placeholder="spawn_agent, kill_agent, ..."
                  className="w-full px-3 py-1.5 bg-white/[0.04] border white/[0.08] rounded-lg text-xs white/90 font-mono placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Default Permissions for new sub-agents (read only) ──

export const DEFAULT_SUBAGENT_PERMISSIONS: Partial<PermissionManifest> = {
  file_read: ['~/Projects/**', '/tmp/**'],
  file_write: [],
  file_delete: 'none',
  exec_allow: [],
  exec_deny: [],
  network_domains: 'none',
  max_processes: 3,
  can_spawn_agents: false,
  can_assign_permissions: false,
  system_control: [],
};

export const DEFAULT_SUBAGENT_TOOLS_POLICY = {
  allow: [] as string[],
  deny: ['web_browse', 'imessage_send'] as string[],
};
