// The manifest's toggle math for the Access panel and the new-agent form: pure functions, no React.
// The values stay in PermissionManifest, the tools_policy column and config.

import type { PermissionManifest } from '@dojo/shared';
import { SEARCH_HOST, stableGrantsText } from '@dojo/shared';

export interface ToolsPolicy { allow: string[]; deny: string[] }

/** The tool names the web toggles OWN. Anything else in the deny list belongs to
 *  the advanced field, and the two must not both claim one name. */
const WEB_TOOLS = ['web_search', 'web_fetch', 'web_browse'];

/** The editor's toggle state, one object. */
export interface LegacyAccess {
  readOn: boolean; readAll: boolean; readList: string;
  writeOn: boolean; writeAll: boolean; writeList: string;
  execOn: boolean; execAll: boolean; execList: string; execDeny: string;
  searchOn: boolean; browseOn: boolean; domainsAll: boolean; domainsList: string;
  screenOn: boolean; mouseOn: boolean; keyboardOn: boolean; applescriptOn: boolean;
  spawnOn: boolean; assignOn: boolean;
  shareProfile: boolean;
  rawAllow: string; rawDeny: string;
}


const hasPath = (v: unknown): boolean => v === '*' || (Array.isArray(v) && v.length > 0);
const isAll = (v: unknown): boolean => v === '*' || (Array.isArray(v) && v.includes('*'));
const toList = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => x !== '*').join(', ') : '');
const hasSys = (p: Partial<PermissionManifest>, key: string): boolean =>
  Array.isArray(p.system_control) && (p.system_control.includes('*') || p.system_control.includes(key));

/** No policy meant "all tools", which is why an agent with none reads the web toggles as ON.
 *  Kept exactly: changing it would flip a toggle for every agent whose column is `{}`. */
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
  return {
    readOn: hasPath(p.file_read), readAll: isAll(p.file_read), readList: toList(p.file_read),
    writeOn: hasPath(p.file_write), writeAll: isAll(p.file_write), writeList: toList(p.file_write),
    execOn: Array.isArray(p.exec_allow) && p.exec_allow.length > 0,
    execAll: Array.isArray(p.exec_allow) && p.exec_allow.includes('*'),
    execList: Array.isArray(p.exec_allow) ? p.exec_allow.filter((c) => c !== '*').join(', ') : '',
    execDeny: (p.exec_deny ?? []).join(', '),
    searchOn: hasTool(tools, 'web_search') && hasTool(tools, 'web_fetch'),
    // Browsing needs the system-control grant; an undenied tool alone cannot open a page.
    browseOn: hasSys(p, 'web_browse') && hasTool(tools, 'web_browse'),
    domainsAll: isAll(p.network_domains) || p.network_domains === '*',
    domainsList: toList(p.network_domains),
    screenOn: hasSys(p, 'screen'), mouseOn: hasSys(p, 'mouse'),
    keyboardOn: hasSys(p, 'keyboard'), applescriptOn: hasSys(p, 'applescript'),
    spawnOn: p.can_spawn_agents ?? false, assignOn: p.can_assign_permissions ?? false,
    shareProfile,
    rawAllow: (tools?.allow ?? []).join(', '),
    // Only denies no toggle owns: seeding the toggles' own denies here makes a web toggle one-way.
    rawDeny: (tools?.deny ?? []).filter((t) => !WEB_TOOLS.includes(t)).join(', '),
  };
}

// ── Build ──

/** The eight keys the editor writes, named so the identity is checkable. */
export interface LegacyManifest {
  file_read: string[] | '*'; file_write: string[] | '*';
  exec_allow: string[]; exec_deny: string[];
  network_domains: string[] | '*' | 'none';
  can_spawn_agents: boolean; can_assign_permissions: boolean;
  system_control: string[];
}

export interface LegacyDocument {
  permissions: LegacyManifest;
  toolsPolicy: ToolsPolicy;
  shareUserProfile: boolean;
}

/** Keys it never writes (`shell_allow`, artifact paths) stay absent; the reader fills them on read.
 *  Search on adds the search host to a domain list, since search is reach to that host. */
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
      exec_allow: !s.execOn ? [] : s.execAll ? ['*'] : split(s.execList),
      exec_deny: split(s.execDeny),
      network_domains: !anyWeb ? 'none' : s.domainsAll ? '*' : [...new Set([...split(s.domainsList), ...(s.searchOn ? [SEARCH_HOST] : [])])],
      can_spawn_agents: s.spawnOn,
      can_assign_permissions: s.assignOn,
      system_control,
    },
    toolsPolicy: { allow: split(s.rawAllow), deny: [...new Set([...deny, ...split(s.rawDeny)])] },
    shareUserProfile: s.shareProfile,
  };
}

/** Compared on the BUILT document, not the state: a difference that writes the same bytes
 *  (", ls" vs "ls") must never send a PUT or write an audit row. */
export function legacyDirty(original: LegacyAccess, draft: LegacyAccess): boolean {
  return stableGrantsText(buildLegacyAccess(original)) !== stableGrantsText(buildLegacyAccess(draft));
}


/** The new-agent form's access fields: none when no toggle moved, so the server's one helper default applies. */
export function createAgentAccess(initial: LegacyAccess, access: LegacyAccess): Partial<LegacyDocument> {
  if (!legacyDirty(initial, access)) return {};
  const { permissions, toolsPolicy, shareUserProfile } = buildLegacyAccess(access);
  return { permissions, toolsPolicy, shareUserProfile };
}

/** Asked of the BUILT document, not the switch: the exec switch turns on with an empty list, which
 *  grants nothing; a summary reading the switch would promise programs an agent is refused. */
export function legacyReachSummary(s: LegacyAccess): { web: boolean; programs: boolean } {
  const built = buildLegacyAccess(s);
  return { web: s.searchOn || s.browseOn, programs: built.permissions.exec_allow.length > 0 };
}

/** The switch is on and the list is empty: on screen, nothing is granted. */
export const programsAreEmpty = (s: LegacyAccess): boolean =>
  s.execOn && buildLegacyAccess(s).permissions.exec_allow.length === 0;

/** The folded state line for "What it may manage". */
export function manageSummary(s: LegacyAccess): string {
  const parts: string[] = [];
  if (s.readOn || s.writeOn) parts.push('Your files');
  if (s.screenOn || s.mouseOn || s.keyboardOn || s.applescriptOn) parts.push('this Mac');
  if (s.spawnOn || s.assignOn) parts.push('other agents');
  return parts.length === 0 ? 'Nothing' : parts.join(', ');
}
