// ════════════════════════════════════════════════════════════════════════════════════════
// WHICH CONFIG KEYS DOES A SHIPPED BOX NEED THAT NO MIGRATION AND NO CONSTANT PROVIDES?
// (BACKLOG line 28, verbatim, built as t111-D. Its sibling half is the single-accessor rule.)
// ════════════════════════════════════════════════════════════════════════════════════════
//
// ── WHY THIS EXISTS: THE HAND-SET-ON-ONE-BOX CLASS ────────────────────────────────────
// `github/account.ts`'s own header records the incident this census generalises. T4 Step 8 set
// `config.github_client_id` BY HAND on the development box. Every door then worked perfectly
// there and NOWHERE ELSE: on a user's box the row was absent, `githubClientId()` answered null,
// and Settings → Integrations → GitHub offered no connect path at all. The feature was
// unreachable on every shipped build, and nothing failed, because the box the developer tested
// on was the one box that had been given the value.
//
// A key a shipped box NEEDS must therefore come from somewhere that ships: a MIGRATION that
// seeds it, a CONSTANT floor in code, or the SETUP flow that writes it. "A developer set it
// once" is not a provider. §3 is that census.
//
// ── AND ITS SIBLING, WHICH IS THE HALF THAT WENT GREEN ────────────────────────────────
// The backlog line records that the gh review "planted a second hardcoded client-id reader and
// everything stayed green". That is the drift risk of the very class just fixed: a value with a
// RESOLUTION ORDER (stored override wins, shipped constant is the floor) is correct only while
// ONE function resolves it. A second reader that queries the row directly gets null on a box
// with no override — reintroducing the original defect one module away from the fix, with the
// fix still in place and still passing its own tests. §1 and §2 are that guard.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DECIDE ───────────────────────────────────────
// Whether a given key is PRODUCT-OFFICIAL (identical on every install) or GENUINELY PER-BOX is
// a product ruling, not a test's call. The obvious ones are classified below from the resolution
// code itself; the genuinely ambiguous ones are listed in the lane report for the owner rather
// than guessed at here. This census asks only the mechanical question — does a provider exist —
// and names the keys where the answer is no.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(SRC, 'db', 'migrations');

// ── the reader ──────────────────────────────────────────────────────────────────────────

const STRIP_CACHE = new Map<string, string>();

/** t99's AST comment stripper: a census that reads comments is testing the comments (G4). */
function stripComments(code: string, kind: ts.ScriptKind = ts.ScriptKind.TS): string {
  const cached = STRIP_CACHE.get(code);
  if (cached !== undefined) return cached;
  const source = ts.createSourceFile(
    kind === ts.ScriptKind.TSX ? 'census.tsx' : 'census.ts',
    code, ts.ScriptTarget.Latest, false, kind,
  );
  const chars = code.split('');
  const blanked = new Set<string>();
  const blank = (range: ts.CommentRange): void => {
    const key = `${range.pos}:${range.end}`;
    if (blanked.has(key)) return;
    blanked.add(key);
    for (let i = range.pos; i < range.end && i < chars.length; i += 1) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  };
  const triviaAt = (pos: number): void => {
    ts.getLeadingCommentRanges(code, pos)?.forEach(blank);
    ts.getTrailingCommentRanges(code, pos)?.forEach(blank);
  };
  const visit = (node: ts.Node): void => {
    triviaAt(node.pos); triviaAt(node.end); ts.forEachChild(node, visit);
  };
  visit(source);
  triviaAt(source.endOfFileToken.pos);
  const out = chars.join('');
  STRIP_CACHE.set(code, out);
  return out;
}

/** Every PRODUCTION module under `src`, comment-stripped, keyed by its path relative to `src`. */
function productionModules(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__tests__') continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(e.name) || /\.(?:test|spec)\./.test(e.name)) continue;
      const rel = path.relative(SRC, full);
      out.set(rel, stripComments(fs.readFileSync(full, 'utf-8'),
        e.name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
    }
  };
  walk(SRC);
  return out;
}

const MODULES = productionModules();

/**
 * The BATCHED read door. `config/platform.ts` fetches twenty keys in one
 * `WHERE key IN ('a', 'b', …)` and serves them from a cache, so a reader that only knows
 * `WHERE key = '…'` cannot see any of them. This census found that itself: `owner_name` came
 * back "read NOWHERE in production", which is the clause demanding to be taught rather than a
 * key being dead. A door a census cannot see is a door it cannot police.
 */
const inClauseKeys = (code: string): Set<string> => {
  const out = new Set<string>();
  for (const m of code.matchAll(/config\s+WHERE\s+key\s+IN\s*\(([^)]*)\)/gi)) {
    for (const k of m[1].matchAll(/'([a-z0-9_]+)'/gi)) out.add(k[1]);
  }
  return out;
};

/** Every module naming this config key as a literal, in a SQL read/write or a helper call. */
function modulesNaming(key: string): string[] {
  const needles = [
    new RegExp(`config\\s+WHERE\\s+key\\s*=\\s*'${key}'`, 'i'),
    new RegExp(`\\bgetConfig(?:Value)?\\(\\s*'${key}'`),
    new RegExp(`\\bsetConfig(?:Value)?\\(\\s*'${key}'`),
  ];
  return [...MODULES]
    .filter(([, code]) => needles.some((re) => re.test(code)) || inClauseKeys(code).has(key))
    .map(([rel]) => rel).sort();
}

// ── §1 + §2: RESOLVED IDENTIFIERS HAVE ONE ACCESSOR ─────────────────────────────────────

/**
 * A RESOLVED IDENTIFIER: a config key whose correct value is not the row, but the row RESOLVED
 * against a shipped floor. These are the keys where a second reader is a defect rather than a
 * duplication — it cannot see the fallback, so it answers null exactly on the boxes that have
 * no override, which is every shipped box.
 *
 * `accessor` is the ONE module allowed to name the key. `constant` is the shipped floor whose
 * literal must appear exactly once in the tree.
 */
const RESOLVED_IDENTIFIERS: readonly {
  key: string; accessor: string; resolver: string; constant?: { name: string; module: string };
}[] = [
  {
    key: 'github_client_id',
    accessor: 'github/account.ts',
    resolver: 'resolveGithubClientId',
    constant: { name: 'GITHUB_OAUTH_CLIENT_ID_DEFAULT', module: 'github/account.ts' },
  },
];

describe('§1 a resolved identifier has exactly ONE accessor', () => {
  it.each(RESOLVED_IDENTIFIERS)('`$key` is named by $accessor and by nothing else', (entry) => {
    const namers = modulesNaming(entry.key);
    expect(
      namers,
      `\`${entry.key}\` has a RESOLUTION ORDER (stored override wins, shipped constant is the `
      + `floor) and ${entry.resolver} is where that order lives. A second module naming the key `
      + 'reads the row directly, so it answers null on every box with no override — the exact '
      + 'defect the constant was introduced to fix, reintroduced one module away from the fix. '
      + `Call ${entry.accessor}'s accessor instead of querying the key.`,
    ).toEqual([entry.accessor]);
  });

  it.each(RESOLVED_IDENTIFIERS.filter((e) => e.constant))(
    'the shipped floor for `$key` is one named constant, written once',
    (entry) => {
      const c = entry.constant!;
      // The constant is DECLARED where it belongs...
      const home = MODULES.get(c.module);
      expect(home, `${c.module} is not a production module`).toBeDefined();
      expect(home!, `${c.name} must be declared in ${c.module}`).toContain(`export const ${c.name}`);

      // ...and its VALUE is not re-typed anywhere. A second literal is a second floor that the
      // resolver cannot update, which is how the two silently disagree.
      const value = /export const [A-Z_]+ = '([^']+)'/.exec(
        home!.slice(home!.indexOf(`export const ${c.name}`)),
      )?.[1];
      expect(value, `could not read ${c.name}'s literal value`).toBeTruthy();
      const carriers = [...MODULES].filter(([, code]) => code.includes(value!)).map(([rel]) => rel);
      expect(
        carriers,
        `the shipped value of ${c.name} is written as a literal in more than one module `
        + `(${carriers.join(', ')}). One floor, one spelling — a second copy is a value the `
        + 'resolver cannot change.',
      ).toEqual([c.module]);
    },
  );
});

// ── §3: EVERY KEY A SHIPPED BOX NEEDS HAS A PROVIDER ────────────────────────────────────

/** Keys a MIGRATION seeds, read from the migration SQL rather than from a list kept by hand. */
function migrationSeededKeys(): Set<string> {
  const out = new Set<string>();
  for (const f of fs.readdirSync(MIGRATIONS)) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf-8');
    for (const m of sql.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+config[^;]*?'([a-z0-9_]+)'/gi)) {
      out.add(m[1]);
    }
  }
  return out;
}

/** Every config key named as a literal anywhere in production. */
function allKeysRead(): Set<string> {
  const out = new Set<string>();
  for (const code of MODULES.values()) {
    for (const m of code.matchAll(/config\s+WHERE\s+key\s*=\s*'([a-z0-9_]+)'/gi)) out.add(m[1]);
    for (const m of code.matchAll(/\bgetConfig(?:Value)?\(\s*'([a-z0-9_]+)'/g)) out.add(m[1]);
    for (const m of code.matchAll(/\bsetConfig(?:Value)?\(\s*'([a-z0-9_]+)'/g)) out.add(m[1]);
    for (const k of inClauseKeys(code)) out.add(k);
  }
  return out;
}

/**
 * Keys with NO migration seed, declared with the reason a shipped box is fine without one.
 *
 * Every entry is one of three honest shapes:
 *   WRITTEN   — setup, a Settings route or the platform itself writes it before anything reads it
 *   OPTIONAL  — the read has a code-side default, so an absent row is a working configuration
 *   PER-BOX   — it is a genuine per-installation choice and absence is the correct initial state
 *
 * A key that is none of those is the defect this census exists for: something a shipped box
 * needs that nothing on a shipped box provides.
 */
const PROVIDED_WITHOUT_A_MIGRATION: Readonly<Record<string, string>> = {
  // ── product-official values with a shipped CONSTANT floor ──
  github_client_id: 'OPTIONAL — `resolveGithubClientId` falls back to GITHUB_OAUTH_CLIENT_ID_DEFAULT; the row is a fork override',

  // ── written by setup / a Settings route before any read depends on them ──
  owner_name: 'WRITTEN — the OOBE profile step; `ownerNameIsSet()` asks the ROW and the prompt says "not recorded yet" until then',
  user_name: 'WRITTEN — the OOBE profile step; read only to seed USER.md',
  imessage_recipient: 'PER-BOX — the owner\'s own handle; iMessage stays off until it is set',
  imessage_enabled: 'OPTIONAL — an absent row reads as off, which is the correct state for a box that never configured iMessage',
  imessage_approved_senders: 'OPTIONAL — absent reads as an empty allowlist, which is deny-by-default',

  // ── optional dials, all with code-side defaults ──
  tunnel_mode: 'OPTIONAL — absent reads as the default mode',
  tunnel_enabled: 'OPTIONAL — an absent row reads as off; a tunnel is opt-in on every box',
  tunnel_named_url: 'OPTIONAL — only meaningful when a named tunnel is configured',
  dreaming_mode: 'OPTIONAL — absent reads as the default cadence',
  dreaming_model_id: 'OPTIONAL — falls back to the box\'s configured model',
  pm_agent_model: 'OPTIONAL — falls back to the box\'s configured model',
  trainer_agent_model: 'OPTIONAL — falls back to the box\'s configured model',
  multistep_config: 'OPTIONAL — absent reads as the shipped classifier defaults',
  context_receipt_mode: 'OPTIONAL — absent reads as the default receipt mode',

  // ── the platform's own role identities: migration 1xx seeds the PRIMARY/PM/healer/dreamer
  //    set; the TRAINER and IMAGINER rows are not seeded and do not need to be, because
  //    `config/platform.ts` resolves each through `get(key, FALLBACK)` with a shipped default.
  trainer_agent_id: 'OPTIONAL — `config/platform.ts` resolves it through get() with a shipped default id',
  trainer_agent_name: 'OPTIONAL — `config/platform.ts` resolves it through get() with a shipped default name',
  trainer_agent_enabled: 'OPTIONAL — an absent row reads as the shipped enablement default',
  imaginer_agent_id: 'OPTIONAL — `config/platform.ts` resolves it through get() with a shipped default id',
  imaginer_agent_name: 'OPTIONAL — `config/platform.ts` resolves it through get() with a shipped default name',
  imaginer_enabled: 'OPTIONAL — an absent row reads as the shipped enablement default',
  household_agent_ids: 'OPTIONAL — an absent row reads as an empty allow-list, which shares nothing; sharing is opt-in',
  sudo_policy: 'OPTIONAL — an absent row reads as the shipped default policy, which is the cautious one',

  // ── model choices: every one falls back to the box's configured model ──
  compaction_model_id: 'OPTIONAL — `memory/compaction.ts` uses it only `if (explicit && isUsableTextModel)`, else resolves a model itself',
  healer_model_id: 'OPTIONAL — falls back to the box\'s configured model',
  healer_mode: 'OPTIONAL — an absent row reads as the shipped healer cadence',
  healer_time: 'OPTIONAL — an absent row reads as the shipped healer schedule',
  healer_report_recipient: 'PER-BOX — who gets a healer report is a per-installation choice; absent means nobody is notified',
  imaginer_brain_model: 'OPTIONAL — falls back to the box\'s configured model',
  imaginer_image_model: 'OPTIONAL — falls back to the box\'s configured image model',
  embedding_config: 'OPTIONAL — `memory/embeddings.ts` reads it `if (row)` and otherwise uses the shipped embedding defaults',
  dreaming_time: 'OPTIONAL — an absent row reads as the shipped dreaming schedule',

  // ── integration state, written by the connect flow that creates it ──
  gws_connected: 'WRITTEN — the Google connect flow writes it; absent means not connected, which is the correct initial state',
  gws_account_email: 'WRITTEN — the Google connect flow writes it alongside the token; absent means not connected',
  ms_connected: 'WRITTEN — the Microsoft connect flow writes it; absent means not connected',
  imessage_default_sender: 'PER-BOX — a handle on this machine; absent means the bridge picks no default sender',

  // ── platform-written bookkeeping: the engine writes these itself, so absence is day one ──
  imessage_last_rowid: 'WRITTEN — the bridge\'s own high-water mark; `row ? parseInt(row.value, 10) : 0` makes day one a cold start',
  migration_checks: 'WRITTEN — `migration/checks.ts` INSERT OR REPLACEs it after a migration run',
  migration_dismissed: 'WRITTEN — set when the user dismisses the migration card and deleted when checks re-run',
  router_last_train_at: 'WRITTEN — the router writes it after training; `lastAtStr ? Date.parse(...) : 0` makes absence "never trained"',
  router_last_train_count: 'WRITTEN — written beside router_last_train_at by the same pass',
  user_presence: 'WRITTEN — the presence service writes it; absent reads as unknown presence',
  ollama_max_concurrent_models: 'OPTIONAL — `services/ollama-lock.ts` keeps its built-in cap unless a row gives a value > 0',

  // ── spend alerting: thresholds and their one-shot "already alerted" latches ──
  openrouter_warning_threshold: 'OPTIONAL — absent means no warning threshold is armed for this box',
  openrouter_threshold_alerted: 'WRITTEN — the one-shot latch the alert sets so it fires once; absent means not yet alerted',
  deepseek_warning_threshold: 'OPTIONAL — absent means no warning threshold is armed for this box',
  deepseek_threshold_alerted: 'WRITTEN — the one-shot latch the alert sets so it fires once; absent means not yet alerted',
};

describe('§3 every config key a shipped box needs comes from something that ships', () => {
  it('⚠ every key read in production is seeded by a migration or declared with its reason', () => {
    const seeded = migrationSeededKeys();
    const keys = [...allKeysRead()].sort();
    expect(keys.length, 'the key reader found nothing — the census is measuring air').toBeGreaterThan(20);

    const unprovided = keys.filter((k) => !seeded.has(k) && !(k in PROVIDED_WITHOUT_A_MIGRATION));
    expect(
      unprovided,
      'config key(s) a shipped box may need that NO migration seeds and nothing here explains: '
      + `${unprovided.join(', ')}. This is the hand-set-on-one-box class (see this file's header: `
      + '`github_client_id` worked on exactly one machine for months). Either seed it in a '
      + 'migration, give its read a code-side default, or add it above with which of '
      + 'WRITTEN / OPTIONAL / PER-BOX it is and why.',
    ).toEqual([]);
  });

  it('⚠ THE OTHER DIRECTION: no declaration here is stale', () => {
    // A presence-only census rots into a list of lies. A key that has since GAINED a migration
    // seed, or stopped being read at all, must leave this list — or the next reader trusts a
    // reason that no longer describes the code.
    const seeded = migrationSeededKeys();
    const read = allKeysRead();
    const declared = Object.keys(PROVIDED_WITHOUT_A_MIGRATION);

    const nowSeeded = declared.filter((k) => seeded.has(k));
    expect(
      nowSeeded,
      `declared as having no migration, but a migration now seeds: ${nowSeeded.join(', ')}. `
      + 'Remove the declaration — the migration is the provider now.',
    ).toEqual([]);

    const unread = declared.filter((k) => !read.has(k));
    expect(
      unread,
      `declared here but read NOWHERE in production: ${unread.join(', ')}. Either the key is `
      + 'dead and the entry goes, or a read moved behind a helper this census cannot see — in '
      + 'which case teach the reader, because a key it cannot see is a key it cannot police.',
    ).toEqual([]);
  });

  it('every declaration says which of WRITTEN / OPTIONAL / PER-BOX it is, and why', () => {
    for (const [key, reason] of Object.entries(PROVIDED_WITHOUT_A_MIGRATION)) {
      expect(reason, `${key}'s reason must name its shape`).toMatch(/^(WRITTEN|OPTIONAL|PER-BOX) — /);
      expect(reason.length, `${key}'s reason is too short to be a reason`).toBeGreaterThan(30);
    }
  });
});
