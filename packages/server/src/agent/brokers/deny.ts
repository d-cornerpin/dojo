// ════════════════════════════════════════════════════════════════════════════
// ONE DENY LIST (PHASE-5 T2 Step 2) — the merge of the two twins.
//
// Until this module there were two hard-coded lists that both answered "may an
// agent touch this file?", written years apart, never compared:
//
//   `isSensitivePath`        (agent/path-guards.ts:149 at `16bd0b8`) — basenames
//                            and directory containment; gated file_read,
//                            file_patch, the exec sensitive-file scan, and every
//                            share / pdf input path.
//   `GLOBAL_FILE_READ_DENY`  (agent/permissions.ts:86 at `16bd0b8`) — four globs
//                            read by `checkPermission({type:'file_read'})`.
//
// They are non-overlapping in CONTENT and identical in PURPOSE, which is exactly
// how a path ends up protected at one door and open at the next. Two more lists
// sat beside them with the same shape (`GLOBAL_FILE_WRITE_DENY`,
// `GLOBAL_FILE_DELETE_DENY`), so the merge takes all four.
//
// ── WHAT "MERGE" MEANS HERE, PRECISELY (RULING P5-R5) ──
// It is a DATA merge, not a behaviour merge. One table; every row names the
// TIERS it denies. `isSensitivePath` answers "does any row deny the sensitive
// tier"; the global read/write/delete checks answer the same question of their
// own tier. **The per-tier answers are byte-for-byte what they were**, so the
// merge adds no refusal anywhere — it only removes the second place a future
// secret file would have to be remembered. `negative-corpus.test.ts` §10 holds
// that as a test, with both legacy lists frozen in the test as the reference.
//
// ── THE ONE PLACE THIS TABLE IS DELIBERATELY WIDER THAN ITS TWINS ──
// Two rows carry `since: 'T2-hardening'`, and both are the corpus's own BYPASS
// classes rather than new policy:
//   * the `-wal` / `-shm` siblings of a globally write-denied database. They are
//     the same database's bytes mid-transaction and they slip `~/.dojo/data/*.db`
//     on the extension alone.
//   * the SYMLINK-resolved target on the READ tier. `checkGlobalDenyFileWrite`
//     already matched the resolved target (N3); the read tier never did, so a
//     link planted in an allowed directory read `secrets.yaml` in the clear.
// Both reach a resource that is ALREADY denied, which is the carve-out P5-R5
// states in so many words. Both are labelled `T2-hardening` so the staging
// window can SEE them — and both are then deliberately EXCLUDED from it by
// `isGlobalDenyRule` below, because a global deny is not a grant and no
// legitimate flow reads the secret store through a link or writes the
// database's journal. That exclusion was earned on the live box: without it a
// sub-agent read `secrets.yaml` through a planted symlink and a `file_write`
// corrupted `dojo.db-wal`. See `gate-eval.ts:logOnly`.
// ════════════════════════════════════════════════════════════════════════════

import os from 'node:os';
import path from 'node:path';
import { foldPath } from '../fs-case.js';

/** The doors a rule can shut. One row may shut several. */
export type DenyTier = 'sensitive' | 'global_read' | 'global_write' | 'global_delete';

export const DENY_TIERS: readonly DenyTier[] = ['sensitive', 'global_read', 'global_write', 'global_delete'];

/** Where a rule came from — parity with the pre-T2 tree, or T2's own bypass hardening. */
export type DenyProvenance = 'legacy' | 'T2-hardening';

export interface DenyMatchContext {
  /** Case-folded absolute path (folded only where the filesystem folds). */
  readonly folded: string;
  /** Case-folded basename. */
  readonly base: string;
  /** Case-folded home directory. */
  readonly home: string;
}

export interface DenyRule {
  /** Stable identifier; it is what a refusal names, so it must survive edits. */
  readonly id: string;
  readonly tiers: readonly DenyTier[];
  readonly since: DenyProvenance;
  /** What this row protects, in the words a removal would have to argue with. */
  readonly reason: string;
  readonly test: (ctx: DenyMatchContext) => boolean;
}

// ── The basenames the sensitive tier has always carried (verbatim from
//    path-guards.ts's SENSITIVE_BASENAMES at `16bd0b8`; entries are lower-case
//    because every comparison runs through foldPath). ──
export const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set<string>([
  'secrets.yaml',
  'secrets.yml',
  'secrets.json',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'authorized_keys',
  'known_hosts',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials',
]);

/**
 * Simple glob matcher supporting `**` (any number of segments), `*` (within one
 * segment) and `?`. Duplicated from `permissions.ts:matchGlob` deliberately? No —
 * it is NOT duplicated: `permissions.ts` re-exports its matcher and this module
 * would close a cycle importing it, so the deny rows below express containment
 * with plain string operations instead of globs. Every legacy glob is
 * reproduced exactly; `negative-corpus.test.ts` §10 is the proof, and it holds
 * the legacy patterns as literals so a drift fails naming the pattern.
 */
function underDir(folded: string, dir: string): boolean {
  return folded === dir || folded.startsWith(dir + path.sep);
}

/** `~/.dojo/data/<one segment>.db` — the legacy `~/.dojo/data/*.db` glob. */
function isDojoDbFile(folded: string, home: string): boolean {
  const dataDir = path.join(home, '.dojo', 'data');
  if (!folded.startsWith(dataDir + path.sep)) return false;
  const rest = folded.slice(dataDir.length + 1);
  return !rest.includes(path.sep) && rest.endsWith('.db');
}

export const DENY_RULES: readonly DenyRule[] = [
  // ── from GLOBAL_FILE_READ_DENY + GLOBAL_FILE_WRITE_DENY + isSensitivePath ──
  {
    id: 'dojo-secrets-store',
    tiers: ['sensitive', 'global_read', 'global_write', 'global_delete'],
    since: 'legacy',
    reason:
      '~/.dojo/secrets.yaml holds the platform API keys as PLAINTEXT on disk (owner decision 2026-07-04), ' +
      'protected only by 0600 and by this deny. It is the actual protection, not a fallback: a read would ' +
      'return the keys in the clear into the conversation.',
    test: ({ folded, home }) => folded === path.join(home, '.dojo', 'secrets.yaml'),
  },
  {
    id: 'dojo-secret-prefixed-files',
    tiers: ['sensitive'],
    since: 'legacy',
    reason: 'anything under ~/.dojo whose basename starts with "secret" is the same store under another name.',
    test: ({ folded, base, home }) => underDir(folded, path.join(home, '.dojo')) && base.startsWith('secret'),
  },
  {
    id: 'sensitive-basenames',
    tiers: ['sensitive'],
    since: 'legacy',
    reason:
      'secrets files, dotenv files, SSH private keys, npm/pypi/netrc credentials — CLAUDE.md: "Secrets never ' +
      'enter the database or memory DAG… they never appear in message content, tool results, or summaries".',
    test: ({ base }) => SENSITIVE_BASENAMES.has(base),
  },
  {
    id: 'ssh-directory-except-public-keys',
    tiers: ['sensitive'],
    since: 'legacy',
    reason: 'everything under ~/.ssh is private key material except the .pub half of a key pair.',
    test: ({ folded, base, home }) =>
      folded.startsWith(path.join(home, '.ssh') + path.sep) && !base.endsWith('.pub'),
  },
  {
    id: 'aws-credentials',
    tiers: ['sensitive'],
    since: 'legacy',
    reason: '~/.aws/credentials is a cloud credential file.',
    test: ({ folded, home }) => folded === path.join(home, '.aws', 'credentials'),
  },
  {
    id: 'gcloud-config',
    tiers: ['sensitive'],
    since: 'legacy',
    reason: '~/.config/gcloud holds Google Cloud application-default credentials.',
    test: ({ folded, home }) => folded.startsWith(path.join(home, '.config', 'gcloud') + path.sep),
  },
  {
    id: 'kube-config',
    tiers: ['sensitive'],
    since: 'legacy',
    reason: '~/.kube/config holds cluster credentials.',
    test: ({ folded, home }) => folded === path.join(home, '.kube', 'config'),
  },
  // ── the rest of GLOBAL_FILE_READ_DENY: Dreamer-style log discipline ──
  {
    id: 'healer-log',
    tiers: ['global_read'],
    since: 'legacy',
    reason:
      'the Healer may ASK ABOUT its history but not via raw file reads — those bypass the engine helpers ' +
      'that cap response size and would choke its prompt. Use healer_recent_actions / healer_action_detail.',
    test: ({ folded, home }) => folded === path.join(home, '.dojo', 'logs', 'healer.log'),
  },
  {
    id: 'healer-report-log',
    tiers: ['global_read'],
    since: 'legacy',
    reason: 'same log discipline as healer.log.',
    test: ({ folded, home }) => folded === path.join(home, '.dojo', 'logs', 'healer-report.log'),
  },
  {
    id: 'healer-archives',
    tiers: ['global_read'],
    since: 'legacy',
    reason: 'same log discipline as healer.log, for the rotated archive tree.',
    test: ({ folded, home }) => folded.startsWith(path.join(home, '.dojo', 'logs', 'healer-archives') + path.sep),
  },
  // ── the rest of GLOBAL_FILE_WRITE_DENY ──
  {
    id: 'dojo-database-files',
    tiers: ['global_write'],
    since: 'legacy',
    reason: 'the platform database is the spine; an agent writing it directly corrupts every other guarantee.',
    test: ({ folded, home }) => isDojoDbFile(folded, home),
  },
  {
    id: 'dojo-database-journal-siblings',
    tiers: ['global_write'],
    since: 'T2-hardening',
    reason:
      'BYPASS CLASS (T2 corpus): `dojo.db-wal` / `dojo.db-shm` are the SAME database\'s bytes mid-transaction ' +
      'and slip the legacy `~/.dojo/data/*.db` glob on the extension alone. Writing them rewrites a file that ' +
      'is already globally denied, so this is guard strengthening (RULING P5-R5), never a new policy.',
    test: ({ folded, home }) => {
      const dataDir = path.join(home, '.dojo', 'data');
      if (!folded.startsWith(dataDir + path.sep)) return false;
      const rest = folded.slice(dataDir.length + 1);
      return !rest.includes(path.sep) && (rest.endsWith('.db-wal') || rest.endsWith('.db-shm') || rest.endsWith('.db-journal'));
    },
  },
  {
    id: 'soul-files',
    tiers: ['global_write'],
    since: 'legacy',
    reason:
      '"never modify your own system prompt" is engine-enforced. The glob covers every sensei soul ' +
      '(PM/TRAINER/HEALER/DREAMER/IMAGINER-SOUL.md), not only SOUL.md — the old pair left the rest writable.',
    // The legacy matcher folded BOTH the pattern and the value, so on a
    // case-SENSITIVE volume only the exact spelling matched. Folding the
    // pattern here keeps that true in both directions.
    test: ({ base }) => base === foldPath('SOUL.md') || base.endsWith(foldPath('-SOUL.md')),
  },
  // ── GLOBAL_FILE_DELETE_DENY ──
  {
    id: 'dojo-tree-undeletable',
    tiers: ['global_delete'],
    since: 'legacy',
    reason: 'nothing under ~/.dojo is an agent\'s to delete — it is the platform\'s own state directory.',
    test: ({ folded, home }) => underDir(folded, path.join(home, '.dojo')),
  },
];

/**
 * Substrings that are denied inside a COMMAND LINE, regardless of the command's
 * shape (read, write, redirect, pipe, substitution). Moved verbatim from
 * `permissions.ts:GLOBAL_EXEC_DENY_SUBSTRINGS` so the one deny list owns the
 * exec spelling of the same protection too.
 *
 * v2.3.19 (Scenario 3 finding): `echo '...' >> ~/.dojo/secrets.yaml` went through
 * cleanly, because a file_write deny cannot see a shell redirect. The substring
 * catches every path form — tilde, absolute, `$HOME`, bare basename.
 */
export const GLOBAL_EXEC_DENY_SUBSTRINGS: readonly string[] = ['secrets.yaml'];

function contextFor(absPath: string): DenyMatchContext {
  return {
    folded: foldPath(absPath),
    base: foldPath(path.basename(absPath)),
    home: foldPath(os.homedir()),
  };
}

/** Every tier on which `absPath` is denied, in table order. */
export function deniedTiers(absPath: string): DenyTier[] {
  const ctx = contextFor(absPath);
  const out = new Set<DenyTier>();
  for (const rule of DENY_RULES) {
    if (!rule.test(ctx)) continue;
    for (const tier of rule.tiers) out.add(tier);
  }
  return DENY_TIERS.filter((t) => out.has(t));
}

/** The first rule that shuts `tier` on `absPath`, or null. */
export function denyRuleFor(absPath: string, tier: DenyTier): DenyRule | null {
  const ctx = contextFor(absPath);
  for (const rule of DENY_RULES) {
    if (rule.tiers.includes(tier) && rule.test(ctx)) return rule;
  }
  return null;
}

// ── The tier readers. These are the ONLY shapes the rest of the tree uses, and
//    each is byte-for-byte the answer its pre-merge twin gave. ──

/**
 * Files that must NEVER appear in tool output and must never be published to a
 * share URL. This is `path-guards.ts`'s `isSensitivePath`, now a reader of the
 * merged table; `path-guards.ts` re-exports it so no call site moved.
 */
export function isSensitivePath(absPath: string): boolean {
  return denyRuleFor(absPath, 'sensitive') !== null;
}

/** `permissions.ts`'s `GLOBAL_FILE_READ_DENY`, as a reader of the merged table. */
export function isGlobalReadDenied(absPath: string): boolean {
  return denyRuleFor(absPath, 'global_read') !== null;
}

/** `permissions.ts`'s `GLOBAL_FILE_WRITE_DENY`, as a reader of the merged table. */
export function isGlobalWriteDenied(absPath: string): boolean {
  return denyRuleFor(absPath, 'global_write') !== null;
}

/** `permissions.ts`'s `GLOBAL_FILE_DELETE_DENY`, as a reader of the merged table. */
export function isGlobalDeleteDenied(absPath: string): boolean {
  return denyRuleFor(absPath, 'global_delete') !== null;
}

/**
 * The broker-facing question: is this resource denied for this effect kind,
 * on ANY tier the kind consults? `fs_read` consults the read tier AND the
 * sensitive tier, because both doors existed on the read path before the merge
 * (`checkGlobalDenyFileRead` in permissions.ts, `isSensitivePath` in the
 * file_read handler body) — this is the union those two already formed, not a
 * new one.
 */
export function isDeniedResource(absPath: string, kind: 'fs_read' | 'fs_write' | 'fs_delete'): boolean {
  return tiersForKind(kind).some((tier) => denyRuleFor(absPath, tier) !== null);
}

/**
 * IS THIS VERDICT A GLOBAL DENY?
 *
 * The staging window (T2 Step 4) must never cover one, and this is how it asks.
 * Every id in the table above names a resource that is protected for EVERY
 * agent regardless of manifest — `secrets.yaml`, the SSH keys, the platform
 * database, the sensei souls. A log-only window exists so a NEW refusal does not
 * break a legitimate flow that a stale sub-agent manifest cannot express; no
 * legitimate flow reads the secret store through a symlink or writes the
 * database's journal.
 */
export function isGlobalDenyRule(ruleId: string): boolean {
  // PHASE-5 T3: the EXEC global denies join this answer, and the omission was
  // latent rather than harmless. RULING P5-R6's carve-out is *"a global deny is
  // NEVER staged"*, and `gate-eval.ts:logOnly` asks this function to recognise
  // one. At T2 every exec refusal carried `basis:'ladder-parity'`, which the
  // staging window excludes anyway, so no exec deny ever reached this check. T3
  // adds the first exec refusal with a `bypass-hardening` basis (the
  // basename-normalised `/bin/rm -rf /` spelling), and without this line a
  // SUB-AGENT would have run it log-only — the exact shape of the incident that
  // earned P5-R6 on the filesystem side.
  if (ruleId.startsWith('global-exec-deny:') || ruleId.startsWith('global-exec-substring:')) return true;
  return DENY_RULES.some((r) => r.id === ruleId);
}

/** Which tiers an effect kind consults. Stated once so the brokers cannot drift. */
export function tiersForKind(kind: 'fs_read' | 'fs_write' | 'fs_delete'): readonly DenyTier[] {
  switch (kind) {
    // The file_read door has always consulted both: `checkGlobalDenyFileRead`
    // inside checkPermission AND `isSensitivePath` inside the handler body.
    case 'fs_read': return ['global_read', 'sensitive'];
    // The file_write door consulted the write globals; `file_patch` additionally
    // consulted the sensitive list in its own handler body, and file_write /
    // file_append did not. Kept exactly that way — widening file_write to the
    // sensitive tier would refuse writes the platform allows today (P5-R5).
    case 'fs_write': return ['global_write'];
    case 'fs_delete': return ['global_delete'];
  }
}
