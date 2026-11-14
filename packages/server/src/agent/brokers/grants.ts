// A grant is rows {effect_kind, mode, pattern} read ORDER BY mode DESC: deny-wins is a
// property of the query, not of discipline. The rows are a PROJECTION of the manifest,
// stamped with its fingerprint. The global deny stays hard-coded in deny.ts, never a row: a row
// is deletable, and that would make the platform's strongest protection removable.

import { createHash } from 'node:crypto';
import type { PermissionManifest } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { getAgentPermissions } from '../manifest.js';
import { matchAgentPathGlob, matchAgentGlob } from '../path-resolve.js';

const logger = createLogger('brokers/grants');

/** Effect kinds a `grant_rule` row speaks. proc and shell are a SPLIT of the old exec
 *  kind, not new authority; applescript is its own class, not a system_control string. */
export type GrantEffectKind =
  | 'fs_read' | 'fs_write'
  | 'proc' | 'shell' | 'applescript'
  | 'net' | 'spawn' | 'system_control';

export type GrantMode = 'allow' | 'deny';

export interface GrantRule {
  readonly effectKind: GrantEffectKind;
  readonly mode: GrantMode;
  readonly pattern: string;
  readonly source: 'manifest';
}

export interface Grant {
  readonly agentId: string;
  readonly manifest: PermissionManifest;
  readonly rules: readonly GrantRule[];
  readonly fingerprint: string;
}

/** Stable fingerprint, key order sorted: a re-ordered JSON blob is the same grant. */
export function manifestFingerprint(manifest: PermissionManifest): string {
  const stable = JSON.stringify(manifest, Object.keys(manifest as unknown as Record<string, unknown>).sort());
  return createHash('sha256').update(stable).digest('hex').slice(0, 32);
}

/** THE PROJECTION: the only thing that turns a manifest into rows; every branch
 *  reproduces a `permissions.ts` check* branch, held by `broker-contract.test.ts`. */
export function projectManifestToRules(manifest: PermissionManifest): GrantRule[] {
  const rules: GrantRule[] = [];
  const push = (effectKind: GrantEffectKind, mode: GrantMode, pattern: string): void => {
    rules.push({ effectKind, mode, pattern, source: 'manifest' });
  };

  // '*' or a pattern list; anything else yields no allow rows: checkFileAccess's
  // "not configured for this agent" branch expressed as an absence.
  for (const [field, kind] of [['file_read', 'fs_read'], ['file_write', 'fs_write']] as const) {
    const value = manifest[field];
    if (value === '*') push(kind, 'allow', '*');
    else if (Array.isArray(value)) for (const p of value) push(kind, 'allow', p);
  }

  // `exec_allow` projects to BOTH kinds: the one exec door predates the split and WAS
  // a shell (its checks read only each inner command's base), so dropping the shell
  // side would delete live reach; declared shell_* rows REPLACE the shell projection.
  const shellAllow = manifest.shell_allow ?? manifest.exec_allow ?? [];
  const shellDeny = manifest.shell_deny ?? manifest.exec_deny ?? [];
  for (const p of manifest.exec_deny ?? []) push('proc', 'deny', p);
  for (const p of manifest.exec_allow ?? []) push('proc', 'allow', p);
  for (const p of shellDeny) push('shell', 'deny', p);
  for (const p of shellAllow) push('shell', 'allow', p);

  const net = manifest.network_domains;
  if (net === '*') push('net', 'allow', '*');
  else if (Array.isArray(net)) for (const d of net) push('net', 'allow', d);

  if (manifest.can_spawn_agents) push('spawn', 'allow', '*');

  // Typed string[] but a stored manifest may hold '*': read it both ways, as the ladder did.
  const control = manifest.system_control as string[] | '*' | undefined;
  if (control === '*') push('system_control', 'allow', '*');
  else if (Array.isArray(control)) for (const c of control) push('system_control', 'allow', c);

  // applescript is its own class: only a LIST naming it (or applescript_run) projects
  // rows here; the system_control rows above are unchanged and cover their own categories.
  if (Array.isArray(control)) {
    for (const c of control) {
      if (c === 'applescript' || c === 'applescript_run') push('applescript', 'allow', c);
    }
  }

  return rules;
}

/** A grant from a manifest alone, no database: the pure path the fallback uses (see grantFor). */
export function grantForManifest(agentId: string, manifest: PermissionManifest): Grant {
  return {
    agentId,
    manifest,
    rules: projectManifestToRules(manifest),
    fingerprint: manifestFingerprint(manifest),
  };
}


interface GrantRuleRow {
  effect_kind: string;
  mode: string;
  pattern: string;
  source: string;
  manifest_fingerprint: string;
}

const memo = new Map<string, { fingerprint: string; grant: Grant }>();

export function forgetGrant(agentId?: string): void {
  if (agentId) memo.delete(agentId); else memo.clear();
}

/** Write this agent's rows to match `manifest`, in one transaction. Idempotent:
 *  running it twice leaves the same rows. Returns the number of rows written. */
export function syncGrantRules(agentId: string, manifest: PermissionManifest): number {
  const rules = projectManifestToRules(manifest);
  const fingerprint = manifestFingerprint(manifest);
  const db = getDb();
  const write = db.transaction(() => {
    db.prepare('DELETE FROM grant_rule WHERE agent_id = ?').run(agentId);
    const insert = db.prepare(
      `INSERT INTO grant_rule (agent_id, effect_kind, mode, pattern, source, manifest_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rules) insert.run(agentId, r.effectKind, r.mode, r.pattern, r.source, fingerprint);
  });
  write();
  return rules.length;
}

/** THE GRANT THE BROKERS AUTHORIZE AGAINST: rows read ORDER BY mode DESC (deny before
 *  allow, by the query), re-projected whenever the stored fingerprint differs, so never
 *  stale. A database failure NEVER narrows: it falls back to the manifest projection, logged. */
export function grantFor(agentId: string): Grant {
  const manifest = getAgentPermissions(agentId);
  const fingerprint = manifestFingerprint(manifest);

  const cached = memo.get(agentId);
  if (cached && cached.fingerprint === fingerprint) return cached.grant;

  let rules: GrantRule[];
  try {
    const db = getDb();
    let rows = db.prepare(
      `SELECT effect_kind, mode, pattern, source, manifest_fingerprint
         FROM grant_rule WHERE agent_id = ? ORDER BY mode DESC, id ASC`,
    ).all(agentId) as GrantRuleRow[];

    if (rows.length === 0 || rows.some((r) => r.manifest_fingerprint !== fingerprint)) {
      syncGrantRules(agentId, manifest);
      rows = db.prepare(
        `SELECT effect_kind, mode, pattern, source, manifest_fingerprint
           FROM grant_rule WHERE agent_id = ? ORDER BY mode DESC, id ASC`,
      ).all(agentId) as GrantRuleRow[];
    }

    rules = rows.map((r) => ({
      effectKind: r.effect_kind as GrantEffectKind,
      mode: r.mode as GrantMode,
      pattern: r.pattern,
      source: 'manifest' as const,
    }));
  } catch (err) {
    logger.warn('grant_rule unavailable; authorizing from the manifest projection directly', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    rules = projectManifestToRules(manifest);
  }

  const grant: Grant = { agentId, manifest, rules, fingerprint };
  memo.set(agentId, { fingerprint, grant });
  return grant;
}


export type RuleVerdict =
  | { readonly decided: true; readonly allowed: false; readonly pattern: string }
  | { readonly decided: true; readonly allowed: true; readonly pattern: string }
  | { readonly decided: false };

/** One effect kind's rows against a candidate, deny first. `match` comes from the
 *  caller: paths fold and glob, commands glob, domains suffix-match; they differ. */
export function evaluateRules(
  grant: Grant,
  effectKind: GrantEffectKind,
  match: (pattern: string, mode: GrantMode) => boolean,
): RuleVerdict {
  const forKind = grant.rules.filter((r) => r.effectKind === effectKind);
  // deny before allow, restating the SQL order so the pure path cannot disagree.
  for (const rule of forKind.filter((r) => r.mode === 'deny')) {
    if (match(rule.pattern, 'deny')) return { decided: true, allowed: false, pattern: rule.pattern };
  }
  for (const rule of forKind.filter((r) => r.mode === 'allow')) {
    if (match(rule.pattern, 'allow')) return { decided: true, allowed: true, pattern: rule.pattern };
  }
  return { decided: false };
}

/** Path matching, verbatim `permissions.ts:matchesAny` semantics. */
export function matchPathPattern(pattern: string, absPath: string): boolean {
  return pattern === '*' || matchAgentPathGlob(pattern, absPath);
}

/** Domain matching, verbatim `checkNetworkPermission` semantics. */
export function matchDomainPattern(pattern: string, domain: string): boolean {
  return pattern === '*' || domain === pattern || domain.endsWith('.' + pattern);
}

/** Command matching: glob on the line or the base command, a star spanning any text. */
export function matchCommandPattern(pattern: string, trimmed: string, baseCommand: string): boolean {
  return pattern === '*' || matchAgentGlob(pattern, trimmed, true) || matchAgentGlob(pattern, baseCommand, true);
}

/** The deny-side command shape; a `"prefix *"` row also denies the bare prefix. */
export function matchCommandDenyPattern(pattern: string, trimmed: string): boolean {
  return matchAgentGlob(pattern, trimmed, true) || (pattern.endsWith(' *') && trimmed === pattern.slice(0, -2));
}
