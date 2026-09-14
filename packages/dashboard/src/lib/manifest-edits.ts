// ════════════════════════════════════════════════════════════════════════════
// THE LEGACY MANIFEST'S PANEL MATH (UX-ACCESS A6) — pure, no React.
//
// The owner's A6 design folds the agent editor's Permissions card INTO the
// Access panel: "Run programs on this Mac" and the two web toggles join the
// "What it can reach" row, and files / this Mac / other agents become the "What
// it may manage" row. The card is then removed, which leaves ONE door on the
// agent editor instead of two.
//
// ── THIS IS A REPOINTING, NOT A MIGRATION ──
// Every value here still lives exactly where it always lived: the
// `PermissionManifest` inside `agents.permissions`, the `agents.tools_policy`
// column, and `config.shareUserProfile`. Nothing moves into the grants object
// this phase. So the load-bearing property of this module is an IDENTITY —
// `buildLegacyAccess(readLegacyAccess(x))` produces the same document
// `PermissionsEditor.buildOutput` produced from the same `x` — and it is a test,
// not an intention. Anything else would be a model change wearing a UI change's
// clothes, and the brief says stop and propose instead.
//
// The state shape is the old editor's own toggle state, deliberately: that is
// what makes the identity checkable line by line. The old component keeps it in
// twenty `useState` hooks and rebuilds the manifest in a `useCallback`; here it
// is one object and one function, so the panel can ask "did anything move?"
// without re-deriving the answer at six call sites.
//
// TWO DEFECTS WERE FOUND WHILE PORTING AND ARE FIXED HERE, both named in the
// tests beside their clause:
//   1. THE WEB TOGGLES WERE ONE-WAY. `rawToolsDeny` was seeded from the STORED
//      deny — which already carried `web_search` when the toggle was off — and
//      the build merged it back in, so the toggle could be switched off and
//      never on again. The advanced field now carries only the denies no toggle
//      owns, which is also the only way the two controls can stop disagreeing.
//   2. THE DELETE SUB-OPTION SAID "All files" AND WROTE `['/tmp/**']`. The write
//      is unchanged; the label and the read-back now agree with it.
// ════════════════════════════════════════════════════════════════════════════

import type { PermissionManifest } from '@dojo/shared';
import { stableGrantsText } from '@dojo/shared';

export interface ToolsPolicy { allow: string[]; deny: string[] }

/** What the "All files" delete option has always actually written. */
const DELETE_TMP = '/tmp/**';

/** The tool names the web toggles OWN. Anything else in the deny list belongs to
 *  the advanced field, and the two must not both claim one name. */
const WEB_TOOLS = ['web_search', 'web_fetch', 'web_browse'];

/** The old editor's toggle state, one object. */
export interface LegacyAccess {
  readOn: boolean; readAll: boolean; readList: string;
  writeOn: boolean; writeAll: boolean; writeList: string;
  deleteOn: boolean; deleteTmp: boolean; deleteList: string;
  execOn: boolean; execAll: boolean; execList: string; execDeny: string;
  searchOn: boolean; browseOn: boolean; domainsAll: boolean; domainsList: string;
  screenOn: boolean; mouseOn: boolean; keyboardOn: boolean; applescriptOn: boolean;
  spawnOn: boolean; assignOn: boolean;
  shareProfile: boolean;
  maxProcesses: number; rawAllow: string; rawDeny: string;
}

// ── The old editor's readers, carried across verbatim ──

const hasPath = (v: unknown): boolean => v === '*' || (Array.isArray(v) && v.length > 0);
const isAll = (v: unknown): boolean => v === '*' || (Array.isArray(v) && v.includes('*'));
const toList = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => x !== '*').join(', ') : '');
const hasSys = (p: Partial<PermissionManifest>, key: string): boolean =>
  Array.isArray(p.system_control) && (p.system_control.includes('*') || p.system_control.includes(key));

/** No policy meant "all tools", which is why an agent with none reads the web
 *  toggles as ON. Kept exactly, because changing it would flip a toggle for
 *  every agent whose column is `{}`. */
const hasTool = (policy: ToolsPolicy | null | undefined, tool: string): boolean => {
  if (!policy) return true;
  const deny = policy.deny ?? [];
  const allow = policy.allow ?? [];
  if (deny.includes(tool)) return false;
  if (allow.length === 0) return true;
  return allow.includes(tool);
};

const split = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

// ── Read ──

export function readLegacyAccess(
  perms: Partial<PermissionManifest> | null | undefined,
  tools: ToolsPolicy | null | undefined,
  shareProfile: boolean,
): LegacyAccess {
  const p = perms ?? {};
  const del = p.file_delete;
  return {
    readOn: hasPath(p.file_read), readAll: isAll(p.file_read), readList: toList(p.file_read),
    writeOn: hasPath(p.file_write), writeAll: isAll(p.file_write), writeList: toList(p.file_write),
    deleteOn: hasPath(del) && del !== 'none',
    deleteTmp: Array.isArray(del) && del.length === 1 && del[0] === DELETE_TMP,
    deleteList: toList(del),
    execOn: Array.isArray(p.exec_allow) && p.exec_allow.length > 0,
    execAll: Array.isArray(p.exec_allow) && p.exec_allow.includes('*'),
    execList: Array.isArray(p.exec_allow) ? p.exec_allow.filter((c) => c !== '*').join(', ') : '',
    execDeny: (p.exec_deny ?? []).join(', '),
    searchOn: hasTool(tools, 'web_search') && hasTool(tools, 'web_fetch'),
    browseOn: hasSys(p, 'web_browse') || hasTool(tools, 'web_browse'),
    domainsAll: isAll(p.network_domains) || p.network_domains === '*',
    domainsList: toList(p.network_domains),
    screenOn: hasSys(p, 'screen'), mouseOn: hasSys(p, 'mouse'),
    keyboardOn: hasSys(p, 'keyboard'), applescriptOn: hasSys(p, 'applescript'),
    spawnOn: p.can_spawn_agents ?? false, assignOn: p.can_assign_permissions ?? false,
    shareProfile,
    maxProcesses: p.max_processes ?? 3,
    rawAllow: (tools?.allow ?? []).join(', '),
    rawDeny: (tools?.deny ?? []).filter((t) => !WEB_TOOLS.includes(t)).join(', '),
  };
}

// ── Build ──

export interface LegacyDocument {
  permissions: Record<string, unknown>;
  toolsPolicy: ToolsPolicy;
  shareUserProfile: boolean;
}

/** The same ten keys `PermissionsEditor.buildOutput` wrote, from the same rules.
 *  Keys it never wrote (`shell_allow`, artifact paths) are still absent, and the
 *  manifest reader still fills them the way it always has. */
export function buildLegacyAccess(s: LegacyAccess): LegacyDocument {
  const anyWeb = s.searchOn || s.browseOn;
  const system_control: string[] = [];
  if (s.screenOn) system_control.push('screen');
  if (s.mouseOn) system_control.push('mouse');
  if (s.keyboardOn) system_control.push('keyboard');
  if (s.applescriptOn) system_control.push('applescript');
  if (s.browseOn) system_control.push('web_browse');

  const deny: string[] = [];
  if (!s.searchOn) deny.push('web_search', 'web_fetch');
  if (!s.browseOn) deny.push('web_browse');

  return {
    permissions: {
      file_read: !s.readOn ? [] : s.readAll ? '*' : split(s.readList),
      file_write: !s.writeOn ? [] : s.writeAll ? '*' : split(s.writeList),
      file_delete: !s.deleteOn ? 'none' : s.deleteTmp ? [DELETE_TMP] : split(s.deleteList),
      exec_allow: !s.execOn ? [] : s.execAll ? ['*'] : split(s.execList),
      exec_deny: split(s.execDeny),
      network_domains: !anyWeb ? 'none' : s.domainsAll ? '*' : split(s.domainsList),
      max_processes: s.maxProcesses,
      can_spawn_agents: s.spawnOn,
      can_assign_permissions: s.assignOn,
      system_control,
    },
    toolsPolicy: { allow: split(s.rawAllow), deny: [...new Set([...deny, ...split(s.rawDeny)])] },
    shareUserProfile: s.shareProfile,
  };
}

/** Did anything the owner can see actually MOVE? Compared on the built document
 *  rather than on the state, so a cosmetic difference that writes the same bytes
 *  (", ls" vs "ls") never sends a PUT or writes an audit row. */
export function legacyDirty(original: LegacyAccess, draft: LegacyAccess): boolean {
  return stableGrantsText(buildLegacyAccess(original)) !== stableGrantsText(buildLegacyAccess(draft));
}

// ── The words the panel says about this half ──

/** Which of the two legacy items in "What it can reach" are on. */
export function legacyReachSummary(s: LegacyAccess): { web: boolean; programs: boolean } {
  return { web: s.searchOn || s.browseOn, programs: s.execOn };
}

/** The folded state line for "What it may manage". */
export function manageSummary(s: LegacyAccess): string {
  const parts: string[] = [];
  if (s.readOn || s.writeOn || s.deleteOn) parts.push('Your files');
  if (s.screenOn || s.mouseOn || s.keyboardOn || s.applescriptOn) parts.push('this Mac');
  if (s.spawnOn || s.assignOn) parts.push('other agents');
  return parts.length === 0 ? 'Nothing' : parts.join(', ');
}
