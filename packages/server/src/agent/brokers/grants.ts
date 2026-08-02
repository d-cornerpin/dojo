// ════════════════════════════════════════════════════════════════════════════
// GRANTS AS ROWS (PHASE-5 T2 Step 2) — `grant_rule`, precedence by construction.
//
// A grant used to be a shape: `PermissionManifest`, ten fields of four different
// kinds, each read by its own `check*` function with its own hand-written order
// of operations. That ordering is where the bugs lived — FA-P5's comment in
// `permissions.ts` records one exactly: the squad-workspace fallback re-opened a
// path the global deny had already shut, and the fix was to remember to re-apply
// the deny inside the fallback. "Remember to re-apply the deny" is not a design.
//
// Here a grant is a list of ROWS, each `{effect_kind, mode, pattern}`, read
// `ORDER BY mode DESC` — `'deny' > 'allow'` lexicographically, so every deny row
// is evaluated before every allow row and **deny-wins is a property of the
// query, not of anybody's discipline.**
//
// ── WHAT LIVES IN ROWS AND WHAT DELIBERATELY DOES NOT (RULING P5-R5) ──
// The per-agent grant lives in rows. The GLOBAL deny list does NOT: it is
// `agent/brokers/deny.ts`, hard-coded and unoverridable, exactly as its two
// pre-merge twins were. Putting `secrets.yaml` in a table would make the
// platform's strongest protection a row somebody can DELETE — a capability
// change in the dangerous direction, which this phase's posture refuses.
//
// ── THE MANIFEST IS STILL THE SOURCE OF TRUTH, AND THAT IS ON PURPOSE ──
// T5 owns validating manifests and migrating `agents.permissions` into the
// validated shape (plan T5 Step 3). Until then two stores would be two truths,
// so the rows are a PROJECTION of the manifest, stamped with a fingerprint of
// the manifest they came from. `grantFor()` re-projects the moment the
// fingerprint differs, so the rows cannot drift from the manifest by
// construction — there is no window in which the table answers a stale
// question. The table is what T5 migrates INTO, and what makes precedence a
// query today.
// ════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import type { PermissionManifest } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { getAgentPermissions } from '../manifest.js';
import { matchAgentPathGlob, matchAgentGlob } from '../path-resolve.js';

const logger = createLogger('brokers/grants');

/**
 * The effect kinds a `grant_rule` row can speak about.
 *
 * PHASE-5 T3 added `proc` and `applescript`, and both are SPLITS of a kind that
 * was already here rather than new authority:
 *   `proc`        `exec({argv})` — a program, no shell. Projected from
 *                 `exec_allow`/`exec_deny`, the same field that authorized the
 *                 one exec door before there were two.
 *   `shell`       `shell({script})` — the /bin/zsh door. Projected from
 *                 `shell_allow` when the manifest declares it and from
 *                 `exec_allow` when it does not, which is what makes the split
 *                 cost no agent any reach it has today.
 *   `applescript` `applescript_run` — osascript is a second interpreter, so it
 *                 gets its own row instead of riding inside `system_control`.
 *                 Projected from `system_control` (a `'*'` grant still covers
 *                 it, a LIST must name it — which is exactly what the ladder's
 *                 category derivation already did).
 */
export type GrantEffectKind =
  | 'fs_read' | 'fs_write' | 'fs_delete'
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

/** Stable fingerprint of a manifest — key order included, because a re-ordered
 *  JSON blob is the same grant and must not force a re-projection. */
export function manifestFingerprint(manifest: PermissionManifest): string {
  const stable = JSON.stringify(manifest, Object.keys(manifest as unknown as Record<string, unknown>).sort());
  return createHash('sha256').update(stable).digest('hex').slice(0, 32);
}

/**
 * THE PROJECTION. One function, and it is the only thing that turns a manifest
 * into rows — the migration's backfill calls it, the lazy refresh calls it, and
 * the pure `grantForManifest()` calls it.
 *
 * Every branch below reproduces a branch of `permissions.ts`'s `check*`
 * functions exactly; `broker-contract.test.ts` holds them side by side.
 */
export function projectManifestToRules(manifest: PermissionManifest): GrantRule[] {
  const rules: GrantRule[] = [];
  const push = (effectKind: GrantEffectKind, mode: GrantMode, pattern: string): void => {
    rules.push({ effectKind, mode, pattern, source: 'manifest' });
  };

  // file_read / file_write: '*' or a pattern list. Anything else (a malformed
  // manifest) yields no allow rows, which is `checkFileAccess`'s final
  // `not configured for this agent` branch expressed as an absence.
  for (const [field, kind] of [['file_read', 'fs_read'], ['file_write', 'fs_write']] as const) {
    const value = manifest[field];
    if (value === '*') push(kind, 'allow', '*');
    else if (Array.isArray(value)) for (const p of value) push(kind, 'allow', p);
  }

  // file_delete: 'none' | string[]. 'none' produces no allow rows.
  if (Array.isArray(manifest.file_delete)) {
    for (const p of manifest.file_delete) push('fs_delete', 'allow', p);
  }

  // exec / shell: deny list FIRST in the table's own order for readability,
  // though the ORDER BY is what actually guarantees precedence.
  //
  // TWO DOORS, ONE MANIFEST FIELD UNTIL SOMEBODY SAYS OTHERWISE (PHASE-5 T3).
  // `exec_allow` projects to BOTH kinds, because until T3 there was one exec
  // door and it WAS a shell: an agent holding `exec_allow:['ls','git *']` could
  // already run `ls | wc -l` and `for f in …; do git show $f; done`, since the
  // per-command check only ever looked at the base command of each inner
  // command. Projecting that field to `proc` alone would delete a capability
  // every agent on the box has right now, which the phase's posture forbids.
  // `shell_allow`/`shell_deny`, when the manifest declares them, REPLACE the
  // shell side — that is how the class is withheld deliberately.
  const shellAllow = manifest.shell_allow ?? manifest.exec_allow ?? [];
  const shellDeny = manifest.shell_deny ?? manifest.exec_deny ?? [];
  for (const p of manifest.exec_deny ?? []) push('proc', 'deny', p);
  for (const p of manifest.exec_allow ?? []) push('proc', 'allow', p);
  for (const p of shellDeny) push('shell', 'deny', p);
  for (const p of shellAllow) push('shell', 'allow', p);

  // network_domains: '*' | 'none' | string[]. 'none' produces no allow rows.
  const net = manifest.network_domains;
  if (net === '*') push('net', 'allow', '*');
  else if (Array.isArray(net)) for (const d of net) push('net', 'allow', d);

  if (manifest.can_spawn_agents) push('spawn', 'allow', '*');

  // `system_control` is typed `string[]` but a stored manifest can legitimately
  // hold the string `'*'` — the ladder's own branch 14/15 read it both ways
  // (`Array.isArray(controlPerms) ? … : controlPerms === '*'`), so the
  // projection reads it both ways too rather than narrowing what a live
  // manifest is allowed to say.
  const control = manifest.system_control as string[] | '*' | undefined;
  if (control === '*') push('system_control', 'allow', '*');
  else if (Array.isArray(control)) for (const c of control) push('system_control', 'allow', c);

  // ── `applescript` AS ITS OWN CLASS (PHASE-5 T3 Step 2) ──
  // osascript is a second interpreter with no allowlist of its own, so it gets
  // its own rows and its own broker call rather than being one string compare
  // inside `system_control`. The DERIVATION is deliberately parity-preserving:
  // a `'*'` grant still covers it (narrowing the primary's own agent is an
  // OWNER decision, not a worker's), and a LIST must name `applescript` or
  // `applescript_run` — which is precisely what the ladder's category
  // derivation already required, so no live manifest changes meaning.
  if (control === '*') push('applescript', 'allow', '*');
  else if (Array.isArray(control)) {
    for (const c of control) {
      if (c === '*' || c === 'applescript' || c === 'applescript_run') push('applescript', 'allow', c);
    }
  }

  return rules;
}

/** A grant built purely from a manifest, with no database anywhere near it.
 *  This is what the unit corpus uses, and what the DB-backed reader falls back
 *  to if the table is unavailable — see `grantFor`. */
export function grantForManifest(agentId: string, manifest: PermissionManifest): Grant {
  return {
    agentId,
    manifest,
    rules: projectManifestToRules(manifest),
    fingerprint: manifestFingerprint(manifest),
  };
}

// ── The `grant_rule` table ──

interface GrantRuleRow {
  effect_kind: string;
  mode: string;
  pattern: string;
  source: string;
  manifest_fingerprint: string;
}

/** In-process memo so a tool call does not re-hash and re-query per effect. */
const memo = new Map<string, { fingerprint: string; grant: Grant }>();

/** Test seam + the hook a manifest write calls; forgetting is always safe. */
export function forgetGrant(agentId?: string): void {
  if (agentId) memo.delete(agentId); else memo.clear();
}

/**
 * Write this agent's rows to match `manifest`, in one transaction. Idempotent:
 * running it twice leaves the same rows. Returns the number of rows written.
 */
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

/**
 * THE GRANT THE BROKERS AUTHORIZE AGAINST.
 *
 * Reads rows `ORDER BY mode DESC` — deny before allow, by the query. Re-projects
 * whenever the stored fingerprint does not match the manifest's, so the rows are
 * never a stale answer.
 *
 * A DATABASE FAILURE NEVER NARROWS: if the table cannot be read or written the
 * grant falls back to the pure projection of the same manifest. Failing closed
 * here would refuse every file read on a box whose disk hiccuped, which is a
 * capability loss caused by infrastructure — precisely what the phase's posture
 * forbids. The fallback is logged, not silent.
 */
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

// ── Rule evaluation ──

export type RuleVerdict =
  | { readonly decided: true; readonly allowed: false; readonly pattern: string }
  | { readonly decided: true; readonly allowed: true; readonly pattern: string }
  | { readonly decided: false };

/**
 * Evaluate the rows of one effect kind against a candidate, deny first.
 *
 * `match` is supplied by the caller because the three resource families compare
 * differently and always have: paths through the case-folding glob matcher,
 * commands through the glob-plus-prefix shape `checkExecCommand` uses, and
 * domains through suffix matching.
 */
export function evaluateRules(
  grant: Grant,
  effectKind: GrantEffectKind,
  match: (pattern: string, mode: GrantMode) => boolean,
): RuleVerdict {
  const forKind = grant.rules.filter((r) => r.effectKind === effectKind);
  // deny before allow — the same order the SQL hands back, restated here so the
  // pure (DB-free) path cannot disagree with the row path.
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

/** Command matching, verbatim `checkExecCommand` semantics (glob on the whole
 *  line OR on the base command, plus the `"sudo *"` prefix shape). */
export function matchCommandPattern(pattern: string, trimmed: string, baseCommand: string): boolean {
  if (pattern === '*') return true;
  if (matchAgentGlob(pattern, trimmed) || matchAgentGlob(pattern, baseCommand)) return true;
  return false;
}

/** The deny-side command shape, which additionally honours a `"prefix *"` row. */
export function matchCommandDenyPattern(pattern: string, trimmed: string): boolean {
  if (matchAgentGlob(pattern, trimmed)) return true;
  if (pattern.endsWith(' *')) {
    const prefix = pattern.slice(0, -2);
    if (trimmed === prefix || trimmed.startsWith(prefix + ' ')) return true;
  }
  return false;
}
