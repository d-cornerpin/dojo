// One deny table; each row names the tiers it shuts. A tier's answer must stay
// byte-for-byte what its pre-merge list gave, so the merge adds no refusal anywhere.

import path from 'node:path';
import { foldPath } from '../fs-case.js';
import { homeDir } from '../../home.js';
import { resolveHomePath } from '../path-resolve.js';
import { lexShellLine } from './shell-words.js';

/** The doors a rule can shut. One row may shut several. */
export type DenyTier = 'sensitive' | 'global_read' | 'global_write';

/** Where a rule came from: the pre-merge lists, or a row added after them. */
export type DenyProvenance = 'legacy' | 'added';

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
  /** A discipline row: it binds every agent EXCEPT the one named, who reads the path like any file. */
  readonly exceptFor?: 'main';
  readonly test: (ctx: DenyMatchContext) => boolean;
}

/** Who is asking, as far as a scoped row cares. Omitted means unknown and the row then
 *  applies, conservatively. A function viewer is asked only when a scoped row's path matches. */
export type DenyViewer = 'main' | 'healer' | 'other';
export type DenyViewerArg = DenyViewer | (() => DenyViewer);

// Entries are lower-case: every comparison runs through foldPath.
export const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set<string>([
  'secrets.yaml',
  'secrets.yml',
  'secrets.json',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'authorized_keys',
  'known_hosts',
  '.pypirc',
  '.netrc',
  'credentials',
]);

/** A project's own settings files: the main agent works with them, every other agent and every share does not. */
const PROJECT_KEY_FILES: ReadonlySet<string> = new Set(['.env', '.env.local', '.env.production', '.env.development', '.npmrc']);

/** No glob matcher lives here: importing permissions.ts's would close a cycle, so the
 *  rows below express containment with plain string ops that match each legacy glob. */
function underDir(folded: string, dir: string): boolean {
  return folded === dir || folded.startsWith(dir + path.sep);
}

/** `~/.dojo/data/<one segment>.db` and its `-wal`, `-shm` and `-journal` files, the same database's bytes. */
function isDojoDbFile(folded: string, home: string): boolean {
  const dataDir = path.join(home, '.dojo', 'data');
  if (!folded.startsWith(dataDir + path.sep)) return false;
  const rest = folded.slice(dataDir.length + 1);
  return !rest.includes(path.sep) && /\.db(?:-wal|-shm|-journal)?$/.test(rest);
}

/** The folders under ~/.dojo holding whole copies of the platform database; the shell door reads them too. */
export const DOJO_BACKUP_DIRS: readonly string[] = ['data/backups', 'backups'];

export const DENY_RULES: readonly DenyRule[] = [
  {
    id: 'dojo-secrets-store',
    tiers: ['sensitive', 'global_read'],
    since: 'legacy',
    reason: '~/.dojo/secrets.yaml holds the platform API keys as plaintext, protected only by 0600 and by this deny: '
      + 'a read would return the keys in the clear into the conversation.',
    test: ({ folded, home }) => folded === path.join(home, '.dojo', 'secrets.yaml'),
  },
  {
    id: 'dojo-secrets-writes',
    tiers: ['global_write'],
    since: 'legacy',
    exceptFor: 'main',
    reason: 'overwriting the secrets file loses every saved key. The main agent is warned instead.',
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
      'secrets files, SSH private keys, pypi/netrc credentials: secrets never appear in message content, tool results or summaries.',
    test: ({ base }) => SENSITIVE_BASENAMES.has(base),
  },
  {
    id: 'project-key-lookalikes',
    tiers: ['sensitive'],
    since: 'legacy',
    exceptFor: 'main',
    reason: 'dotenv and .npmrc files often hold a project\'s keys: the main agent works with them, no other agent reads them and no door sends them off the Mac.',
    test: ({ base }) => PROJECT_KEY_FILES.has(base),
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
  {
    id: 'plaud-and-cloudflare-tokens',
    tiers: ['sensitive'],
    since: 'added',
    reason: '~/.plaud/tokens.json and ~/.cloudflared hold account and tunnel credentials.',
    test: ({ folded, home }) => folded === path.join(home, '.plaud', 'tokens.json') || underDir(folded, path.join(home, '.cloudflared')),
  },
  {
    id: 'healer-log',
    tiers: ['global_read'],
    since: 'legacy',
    exceptFor: 'main',
    reason:
      'the Healer may ASK ABOUT its history but not via raw file reads — those bypass the engine helpers ' +
      'that cap response size and would choke its prompt. Use healer_recent_actions / healer_action_detail.',
    test: ({ folded, home }) => folded === path.join(home, '.dojo', 'logs', 'healer.log'),
  },
  {
    id: 'healer-report-log',
    tiers: ['global_read'],
    since: 'legacy',
    exceptFor: 'main',
    reason: 'same log discipline as healer.log.',
    test: ({ folded, home }) => folded === path.join(home, '.dojo', 'logs', 'healer-report.log'),
  },
  {
    id: 'healer-archives',
    tiers: ['global_read'],
    since: 'legacy',
    exceptFor: 'main',
    reason: 'same log discipline as healer.log, for the rotated archive tree.',
    test: ({ folded, home }) => folded.startsWith(path.join(home, '.dojo', 'logs', 'healer-archives') + path.sep),
  },
  {
    id: 'dojo-database-files',
    tiers: ['global_read'],
    since: 'legacy',
    reason: 'reading the platform database raw hands over its credential tables.',
    test: ({ folded, home }) => isDojoDbFile(folded, home),
  },
  {
    id: 'dojo-database-writes',
    tiers: ['global_write'],
    since: 'legacy',
    exceptFor: 'main',
    reason: 'the platform database is the spine: writing it directly corrupts every other guarantee. The main agent is warned instead.',
    test: ({ folded, home }) => isDojoDbFile(folded, home),
  },
  {
    id: 'dojo-database-backups',
    tiers: ['global_read'],
    since: 'added',
    reason: 'the backup folders hold whole copies of the platform database, credential tables included.',
    test: ({ folded, home }) => DOJO_BACKUP_DIRS.some((dir) => underDir(folded, path.join(home, '.dojo', dir))),
  },
  {
    id: 'soul-files',
    tiers: ['global_write'],
    since: 'legacy',
    exceptFor: 'main',
    reason:
      'only the main agent edits a Dojo soul; the glob covers every sensei soul ' +
      '(PM/TRAINER/HEALER/DREAMER-SOUL.md), not only SOUL.md.',
    // Folding the pattern as well as the value keeps the legacy behaviour on a
    // case-SENSITIVE volume, where only the exact spelling matched.
    // The Dojo's own souls only, under ~/.dojo/prompts (assembler.ts PROMPTS_DIR): a
    // SOUL.md in a project folder is an ordinary file and stays writable.
    test: ({ folded, base, home }) =>
      folded.startsWith(path.join(home, '.dojo', 'prompts') + path.sep)
      && (base === foldPath('SOUL.md') || base.endsWith(foldPath('-SOUL.md'))),
  },
];

/** Whether a command line names the secrets file, whatever its shape: a file_write deny cannot see a shell redirect. */
export const namesSecretsFile = (text: string): boolean => foldPath(text).includes('secrets.yaml');

function contextFor(absPath: string): DenyMatchContext {
  return {
    folded: foldPath(absPath),
    base: foldPath(path.basename(absPath)),
    home: foldPath(homeDir()),
  };
}

/** Does this rule bind this viewer? Unscoped rows bind all; an unknown viewer stays bound. */
const bindsViewer = (rule: DenyRule, viewer?: DenyViewerArg): boolean =>
  !rule.exceptFor || viewer === undefined || (typeof viewer === 'function' ? viewer() : viewer) !== rule.exceptFor;

/** Sensitive by name, but they list public keys only: a read returns them, every other door keeps them shut. */
const SSH_PUBLIC_LISTS: ReadonlySet<string> = new Set(['known_hosts', 'authorized_keys']);

/** The first rule that shuts `tier` on `absPath`, or null. */
export function denyRuleFor(absPath: string, tier: DenyTier, viewer?: DenyViewerArg, reading = false): DenyRule | null {
  const ctx = contextFor(absPath);
  if (reading && tier === 'sensitive' && SSH_PUBLIC_LISTS.has(ctx.base)) return null;
  for (const rule of DENY_RULES) {
    if (rule.tiers.includes(tier) && rule.test(ctx) && bindsViewer(rule, viewer)) return rule;
  }
  return null;
}

// The tier readers: the only deny shapes the rest of the tree uses.

/** Files that must NEVER appear in tool output or a published share URL.
 *  `path-guards.ts` re-exports this so none of its call sites had to move. */
export function isSensitivePath(absPath: string): boolean {
  return denyRuleFor(absPath, 'sensitive') !== null;
}

/** A file that lets someone sign in to this Mac: what the ~/.ssh deny row covers. */
const SSH_ROW = DENY_RULES.find((r) => r.id === 'ssh-directory-except-public-keys') as DenyRule;
export const isLoginKeyFile = (absPath: string): boolean => SSH_ROW.test(contextFor(absPath));

/** Rows deny files by name; a folder holding one is named whole by a recursive read
 *  like `grep -r`, so the reader scan refuses these too. A test pairs each entry with a row. */
export const SENSITIVE_LOCATIONS: readonly string[] = ['.dojo/secrets.yaml', '.ssh', '.aws/credentials', '.config/gcloud', '.kube/config', '.plaud/tokens.json', '.cloudflared'];

/** Is this path one of the fixed sensitive locations, or a folder that contains one? */
export function containsSensitiveLocation(absPath: string): boolean {
  const here = foldPath(path.resolve(absPath));
  const prefix = here.endsWith(path.sep) ? here : here + path.sep;
  return SENSITIVE_LOCATIONS.some((rel) => {
    const loc = foldPath(path.join(homeDir(), rel));
    return loc === here || loc.startsWith(prefix);
  });
}

/** Whether a word of the line, as the shell unquotes it, is the Dojo's own keys file: by `~`, `$HOME`, an
 *  absolute path, or a relative one against the call's working directory when it is known. */
export function lineNamesKeysFile(line: string, cwd?: string): boolean {
  const keys = foldPath(path.join(homeDir(), '.dojo', 'secrets.yaml'));
  const words = lexShellLine(line)?.segments.flatMap((seg) => seg.words.map((w) => w.value)) ?? [line];
  // A word is split where a script inside it may start a path: quotes, parentheses, `=`, `,` and `:`.
  return words.flatMap((w) => w.split(/[\s'"()=,:]+/)).filter(Boolean).some((word) => {
    const expanded = resolveHomePath(word.replace(/^\$\{?HOME\}?(?=\/|$)/, homeDir()));
    if (!path.isAbsolute(expanded) && !cwd) return false;
    return foldPath(path.resolve(cwd ?? '/', expanded)) === keys;
  });
}

/** True when the id names a resource denied for EVERY agent regardless of manifest.
 *  No production caller; the census in `__tests__/staged-set.test.ts` uses it so a new
 *  `bypass-hardening` id cannot silently become a narrowing nobody agreed to. */
export function isGlobalDenyRule(ruleId: string): boolean {
  // A global deny is NEVER staged: an exec deny missing here would run log-only
  // for a sub-agent, exactly what every other agent is refused outright.
  if (ruleId.startsWith('global-exec-deny:') || ruleId.startsWith('global-exec-substring:')) return true;
  // The sensitive tier reached by a non-path route is a global deny too, however the door gets there.
  if (ruleId === 'exec-sensitive-read' || ruleId === 'applescript-shell-sensitive-read' || ruleId === 'sensitive-share') return true;
  return DENY_RULES.some((r) => r.id === ruleId);
}

/** Which tiers an effect kind consults. Stated once so the brokers cannot drift. */
export function tiersForKind(kind: 'fs_read' | 'fs_write'): readonly DenyTier[] {
  switch (kind) {
    case 'fs_read': return ['global_read', 'sensitive'];
    // The sensitive tier stays out of fs_write on purpose: widening it here would
    // refuse writes the platform allows today.
    case 'fs_write': return ['global_write'];
  }
}
