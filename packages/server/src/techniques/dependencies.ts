// ════════════════════════════════════════
// Technique Dependencies & File-Reference Validation
// ════════════════════════════════════════
//
// Two related concerns live here:
//
// (1) `dependencies.json` — a structured manifest the trainer agent
//     populates listing every external thing a technique needs that
//     isn't a file in the technique's own support directory: system
//     packages (brew / apt), language packages (npm / pip), git repos
//     to clone, model files to download, and manual setup steps.
//
//     The manifest exists so a shared technique stays portable. When a
//     user on another machine imports the package, their trainer agent
//     reads this manifest and either runs the install commands or
//     hands the user instructions to do so.
//
// (2) File-reference validation — scans TECHNIQUE.md for paths that
//     look like file references and verifies each one resolves either
//     to a file inside the technique's support dir OR appears in the
//     dependency manifest's `repos` / `models_or_assets` / `manual_steps`
//     sections.
//
//     This catches the failure shape the system was originally bitten
//     by: an agent builds a custom script somewhere arbitrary
//     (~/Documents/random.py), references it from TECHNIQUE.md as
//     `python ~/Documents/random.py`, then shares the technique — the
//     receiver gets the .md but not the script, and the technique
//     silently breaks.
//
//     Enforcement runs at save time (`createTechnique` / update path)
//     and at export time (before the .dojo zip is produced). A failed
//     save returns a structured refusal listing every offending
//     reference and what to do about each.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEPENDENCY_MANIFEST_FILENAME = 'dependencies.json';
export const DEPENDENCY_MANIFEST_VERSION = 1;

// ── Manifest schema ──

export interface SystemPackageDep {
  /** Package manager: 'brew', 'apt', 'choco', 'winget', etc. */
  manager: string;
  package: string;
  /** Optional version constraint expressed in the manager's native form. */
  version?: string;
  /** Human-readable note for the importing trainer (e.g. why this is needed). */
  note?: string;
}

export interface LanguagePackageDep {
  manager: 'npm' | 'pip' | 'gem' | 'cargo' | 'go' | string;
  package: string;
  version?: string;
  /**
   * Optional: which directory to install into (relative to the
   * imported technique's dir). Defaults to global install for the
   * manager.
   */
  install_in?: string;
  note?: string;
}

export interface RepoDep {
  url: string;
  /** Branch / tag / commit. Defaults to manager default. */
  ref?: string;
  /**
   * Path inside the technique dir to clone INTO (relative). If omitted,
   * the importing trainer can pick.
   */
  install_to?: string;
  note?: string;
}

export interface AssetDep {
  /** URL to download from. */
  url: string;
  /**
   * Path inside the technique dir to save to (relative). Required —
   * without this the importing trainer has no idea where to drop the
   * asset.
   */
  destination: string;
  /** Optional sha256 for integrity check. */
  sha256?: string;
  note?: string;
}

export interface DependencyManifest {
  version: typeof DEPENDENCY_MANIFEST_VERSION;
  system_packages: SystemPackageDep[];
  language_packages: LanguagePackageDep[];
  repos: RepoDep[];
  models_or_assets: AssetDep[];
  /**
   * Free-text steps the importing trainer must walk the user through
   * because they can't be automated (creating a cloud account, signing
   * in to a service, hardware setup, etc.).
   */
  manual_steps: string[];
}

export function emptyDependencyManifest(): DependencyManifest {
  return {
    version: DEPENDENCY_MANIFEST_VERSION,
    system_packages: [],
    language_packages: [],
    repos: [],
    models_or_assets: [],
    manual_steps: [],
  };
}

/**
 * Read the manifest from a technique directory. Returns an empty
 * manifest if the file doesn't exist (techniques created before this
 * feature shipped won't have one — the migration audit asks the
 * trainer to populate them, but until then the empty manifest keeps
 * reads working).
 */
export function readDependencyManifest(dirPath: string): DependencyManifest {
  const filePath = path.join(dirPath, DEPENDENCY_MANIFEST_FILENAME);
  if (!fs.existsSync(filePath)) return emptyDependencyManifest();
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DependencyManifest>;
    return {
      version: parsed.version ?? DEPENDENCY_MANIFEST_VERSION,
      system_packages: Array.isArray(parsed.system_packages) ? parsed.system_packages : [],
      language_packages: Array.isArray(parsed.language_packages) ? parsed.language_packages : [],
      repos: Array.isArray(parsed.repos) ? parsed.repos : [],
      models_or_assets: Array.isArray(parsed.models_or_assets) ? parsed.models_or_assets : [],
      manual_steps: Array.isArray(parsed.manual_steps) ? parsed.manual_steps : [],
    };
  } catch {
    // Corrupt manifest — fall back to empty so the technique still loads.
    return emptyDependencyManifest();
  }
}

export function writeDependencyManifest(dirPath: string, manifest: DependencyManifest): void {
  const filePath = path.join(dirPath, DEPENDENCY_MANIFEST_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

// ── File-reference extraction ──
//
// Heuristic scan of TECHNIQUE.md (and any markdown support file) for
// paths the document is asking the reader / agent to use. Tighter
// than "any token that looks file-y" — we restrict to four shapes
// people actually use to reference files in docs:
//
//   1. Markdown links: [label](path)             — non-URL paths only
//   2. Fenced code blocks with shell-like content
//   3. Backtick-quoted inline paths: `./foo.py`, `support/x.json`
//   4. "Files Included" bullet lists: lines starting with `- ` followed
//      by a backtick-quoted path
//
// Any path that contains '..' (parent-dir traversal) is flagged
// separately as a security issue, not a missing-file issue.

const URL_LIKE_RE = /^(?:https?:|mailto:|ftp:|file:|data:|tel:)/i;

// Matches paths with at least one extension (e.g. `foo.py`, `dir/bar.json`)
// OR explicit-relative shell paths (`./script`, `../tool`).
// Used inside the four contexts below; kept permissive on purpose since
// the contexts narrow false positives.
const PATH_LIKE_RE = /(?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-]+\.[A-Za-z0-9]+|\.{1,2}\/[A-Za-z0-9_.-]+/g;

const MARKDOWN_LINK_RE = /\[([^\]]*?)\]\(([^)\s]+)\)/g;
const INLINE_CODE_RE = /`([^`]+?)`/g;
// Capture the language tag too — shell-ish fences are full of argv tokens
// that look pathy (`python3 foo.py`, `node bin/x.js`) but aren't file
// declarations; we treat those tokens more strictly than tokens in
// non-shell fences (json, yaml, etc., where path strings ARE references).
const FENCED_BLOCK_RE = /```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```/g;

export interface FileReference {
  raw: string;
  /** Where in the document the reference was found. */
  source: 'markdown_link' | 'inline_code' | 'code_fence' | 'files_list';
  /** Best-effort line excerpt for the refusal message. */
  excerpt: string;
}

export function extractFileReferences(markdownContent: string): FileReference[] {
  const refs: FileReference[] = [];
  const seen = new Set<string>();

  const push = (raw: string, source: FileReference['source'], excerpt: string): void => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (URL_LIKE_RE.test(trimmed)) return;
    // Strip surrounding quotes if any.
    const cleaned = trimmed.replace(/^["']+|["']+$/g, '');
    // Strip a trailing punctuation char that might be part of prose.
    const stripped = cleaned.replace(/[.,;:]+$/g, '');
    if (!stripped) return;
    // Filter: must be path-y. Either an extension, or starts with ./ or ../
    const looksPathy = /\.[A-Za-z0-9]+$/.test(stripped) || /^\.{1,2}\//.test(stripped);
    if (!looksPathy) return;
    // Common false-positive: bare version numbers like "1.2.3", "v2.0".
    if (/^v?\d+(\.\d+)+$/.test(stripped)) return;
    // De-dupe by raw string within source kind.
    const key = `${source}::${stripped}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ raw: stripped, source, excerpt: excerpt.slice(0, 140) });
  };

  // Bare basename-with-extension tokens (`send_email.py`, `config.json`)
  // in inline backticks are usually prose flourish, not authoritative
  // path declarations. Require an explicit directory marker (`./x.py`,
  // `support/x.json`) for inline-code references to count.
  const looksLikeArgvToken = (token: string): boolean => {
    if (token.startsWith('./') || token.startsWith('../') || token.startsWith('/')) return false;
    if (token.includes('/')) return false;
    return true;
  };

  // (1) Markdown links.
  for (const match of markdownContent.matchAll(MARKDOWN_LINK_RE)) {
    push(match[2], 'markdown_link', match[0]);
  }

  // (2) Fenced code blocks — DELIBERATELY NOT SCANNED (v2.7.4).
  //
  //     Earlier versions tried to extract file references from inside
  //     fences with progressively-tighter heuristics. They all failed
  //     because fence contents are *code*, not *declarations*, and the
  //     regex can't tell the difference between:
  //
  //       - `yaml.safe_load(f)` (Python attribute, .safe = "extension")
  //       - `campaign.get('schedule', [])` (Python method)
  //       - `date_parser.isoparse(x)` (Python method)
  //       - `lines.append(...)` (Python method)
  //       - `# e.g., "..."` (abbreviation in a comment)
  //       - `cornerp.in` (a domain, not a file)
  //       - `/tmp/campaign.yaml` (a path *used by the code*, not shipped)
  //       - `"/Users/david/documents/proposal.pdf"` (literal in argv data)
  //
  //     Every one of those would get flagged as "missing file" on a
  //     legitimate technique. The real M365 export failure was 14
  //     violations and 13 of them were noise of this exact shape.
  //
  //     A trainer who actually wants to declare a file ships it via:
  //       - a markdown link `[label](./path/to/file.py)` (section 1),
  //       - an inline backtick path with directory marker `` `./x.py` ``
  //         (section 3),
  //       - or an entry in dependencies.json.
  //
  //     All three are explicit author intent. Code blocks are not.

  // (3) Inline code references — only count ones that look like paths.
  //     Bare basenames in inline code (`run.py` in prose) are usually
  //     prose flourish, not authoritative path declarations. Require an
  //     explicit directory marker, matching the shell-fence rule.
  //
  //     INLINE_CODE_RE is unaware of fence boundaries — it'll happily
  //     pair the last ``` of an opening triple with the first ``` of the
  //     closing triple and capture the whole fence body as one "inline"
  //     match, which then corrupts every real single-backtick match
  //     that follows. Strip fenced blocks before scanning so inline
  //     extraction only sees the markdown between fences.
  const inlineScanSource = markdownContent.replace(FENCED_BLOCK_RE, '');
  for (const match of inlineScanSource.matchAll(INLINE_CODE_RE)) {
    const token = match[1];
    if (looksLikeArgvToken(token)) continue;
    push(token, 'inline_code', match[0]);
  }

  // (4) "Files Included" bullet lists — already covered by (3) when
  //     the bullet contains backticked paths. No separate pass needed.

  return refs;
}

// ── Validation ──

export interface ValidationViolation {
  reference: FileReference;
  reason:
    | 'absolute_outside_dir'
    | 'parent_traversal'
    | 'missing_in_dir'
    | 'home_relative'
    | 'tilde_home'
    | 'not_in_dir_or_manifest';
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: ValidationViolation[];
}

/**
 * Validate that every file reference in `markdownContent` resolves
 * either to a file inside `dirPath`, or appears in the dependency
 * manifest (so the importing trainer can produce / fetch it).
 *
 * Pure function — does not modify anything. Callers decide what to do
 * with the violations (refuse the save, refuse the export, log only).
 */
export function validateTechniqueFileReferences(
  dirPath: string,
  markdownContent: string,
  manifest: DependencyManifest,
): ValidationResult {
  const refs = extractFileReferences(markdownContent);
  const violations: ValidationViolation[] = [];

  // Build a set of acceptable references from the manifest: every
  // destination path declared in repos / assets is acceptable because
  // the importing trainer will populate it.
  //
  // Defensive null-coalesce: callers occasionally hand us partial
  // manifests (LLMs love to omit fields). Iterating a missing array
  // threw `TypeError: repos is not iterable` and the trainer interpreted
  // it as an engine fault rather than its own bad payload.
  const manifestPaths = new Set<string>();
  for (const r of manifest.repos ?? []) {
    if (r.install_to) manifestPaths.add(normalize(r.install_to));
  }
  for (const a of manifest.models_or_assets ?? []) {
    if (a.destination) manifestPaths.add(normalize(a.destination));
  }

  for (const ref of refs) {
    const raw = ref.raw;

    if (raw.startsWith('~')) {
      violations.push({ reference: ref, reason: 'tilde_home', detail: `Path "${raw}" references the home directory. Move the file into the technique support directory and reference it relatively (e.g., "./${path.basename(raw)}").` });
      continue;
    }
    if (path.isAbsolute(raw)) {
      violations.push({ reference: ref, reason: 'absolute_outside_dir', detail: `Path "${raw}" is absolute. Move the file into the technique support directory and reference it relatively.` });
      continue;
    }
    if (raw.split(/[\\/]/).includes('..')) {
      violations.push({ reference: ref, reason: 'parent_traversal', detail: `Path "${raw}" uses ".." to escape the technique directory. Move the file inside the support directory.` });
      continue;
    }

    const norm = normalize(raw);
    // Acceptable if file exists in the technique dir.
    const onDisk = path.join(dirPath, norm);
    if (fs.existsSync(onDisk)) continue;
    // Acceptable if the manifest declares this destination — the
    // importing trainer will create it.
    if (manifestPaths.has(norm)) continue;

    violations.push({
      reference: ref,
      reason: 'missing_in_dir',
      detail: `Path "${raw}" is referenced in TECHNIQUE.md but does NOT exist inside the technique directory and is NOT declared in dependencies.json. Either copy the file into the support directory, or add it to dependencies.json as a repo/asset that will be fetched at import time.`,
    });
  }

  return { ok: violations.length === 0, violations };
}

function normalize(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/');
}

// ── Auto-resolution (v2.7.5) ──
//
// Take the validator's violation list and try to RESOLVE each one
// instead of refusing the export. Three buckets:
//
//   1. The reference points to a real file on the author's disk
//      (absolute path, ~/ home-relative, or `..`-escape). If we can
//      safely read it, copy it into the export bundle and add an entry
//      to the manifest declaring its destination. The receiver's
//      trainer drops it back into the same destination at import.
//
//   2. The reference points to something that doesn't exist on the
//      author's disk either (e.g. `/tmp/campaign.yaml` — a runtime
//      file the technique tells the user to create). Add it to
//      manual_steps so the receiver's trainer can explain to the
//      importing user that they need to provide the file at runtime.
//
//   3. The reference is a relative path that's supposed to be inside
//      the technique dir but isn't (missing_in_dir). The author
//      intended to ship it; we can't fetch it from anywhere. Add to
//      manual_steps with a clear "MISSING — author needs to
//      re-export" note so the receiver knows the package is
//      incomplete and the export caller knows to fix it.
//
// Sensitive files (~/.ssh keys, secrets.yaml, .env, cloud creds) are
// never auto-bundled regardless of whether the reference resolves to
// them. They get bucket-2 treatment (manual step describing what the
// user must supply) so secrets never leak across the share boundary.
// The same blocklist used at file_read time gates this.

/** Max size of any single auto-bundled file (avoid bloating the zip). */
const AUTO_BUNDLE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/** Directory inside the export package where auto-bundled files land. */
const AUTO_BUNDLE_SUBDIR = 'bundled-assets';

/** Per-violation log of what happened during auto-resolution. */
export interface AutoResolution {
  reference: FileReference;
  action: 'bundled' | 'declared_as_manual_step';
  detail: string;
}

export interface AutoResolveResult {
  resolutions: AutoResolution[];
  patchedManifest: DependencyManifest;
  /** Files to copy into the export zip, in addition to the technique's own files. */
  filesToBundle: Array<{ relPath: string; absSourcePath: string }>;
}

/**
 * Minimal sensitive-path check duplicated here to avoid importing
 * from agent/tools.ts (which has a heavy dependency graph). Keep in
 * sync with isSensitivePath in that file. The cost of false negatives
 * is high (leaked secrets); the cost of false positives is low (one
 * extra manual_step entry).
 */
function isSensitiveForBundling(absPath: string): boolean {
  const base = path.basename(absPath);
  const SENSITIVE = new Set([
    'secrets.yaml', 'secrets.yml', 'secrets.json',
    '.env', '.env.local', '.env.production', '.env.development',
    'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
    'authorized_keys', 'known_hosts',
    '.npmrc', '.pypirc', '.netrc', 'credentials',
  ]);
  if (SENSITIVE.has(base)) return true;
  const home = os.homedir();
  if (absPath.startsWith(path.join(home, '.ssh') + path.sep) && !base.endsWith('.pub')) return true;
  if (absPath === path.join(home, '.aws', 'credentials')) return true;
  if (absPath.startsWith(path.join(home, '.config', 'gcloud') + path.sep)) return true;
  if (absPath === path.join(home, '.kube', 'config')) return true;
  if (absPath.startsWith(path.join(home, '.dojo') + path.sep) && base.startsWith('secret')) return true;
  return false;
}

/**
 * Resolve a raw reference string into an absolute source path on disk,
 * if possible. Returns null for references that don't point at a
 * locatable filesystem path (e.g. URL-like strings the extractor lets
 * through, or relative paths under the technique dir we already
 * know don't exist).
 */
function resolveSourcePath(raw: string, dirPath: string): string | null {
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  if (raw === '~') return os.homedir();
  if (path.isAbsolute(raw)) return raw;
  if (raw.split(/[\\/]/).includes('..')) return path.resolve(dirPath, raw);
  return null;
}

export function autoResolveViolations(
  dirPath: string,
  violations: ValidationViolation[],
  manifest: DependencyManifest,
): AutoResolveResult {
  // Deep-clone the manifest so callers' input stays untouched.
  const patchedManifest: DependencyManifest = {
    version: manifest.version,
    system_packages: [...(manifest.system_packages ?? [])],
    language_packages: [...(manifest.language_packages ?? [])],
    repos: [...(manifest.repos ?? [])],
    models_or_assets: [...(manifest.models_or_assets ?? [])],
    manual_steps: [...(manifest.manual_steps ?? [])],
  };
  const resolutions: AutoResolution[] = [];
  const filesToBundle: Array<{ relPath: string; absSourcePath: string }> = [];

  // Dedupe by the normalized destination path so the same file
  // mentioned three times in TECHNIQUE.md doesn't get three manifest
  // rows and three zip copies.
  const bundledDestinations = new Set<string>();
  const declaredManualSteps = new Set<string>();

  const addManualStep = (step: string): void => {
    if (declaredManualSteps.has(step)) return;
    declaredManualSteps.add(step);
    patchedManifest.manual_steps.push(step);
  };

  for (const v of violations) {
    const raw = v.reference.raw;
    const sourcePath = resolveSourcePath(raw, dirPath);

    // Try to bundle if we have a concrete source path.
    if (sourcePath) {
      if (isSensitiveForBundling(sourcePath)) {
        const step = `Provide value for "${raw}" at import time — original was on the sensitive-files blocklist and was deliberately NOT bundled with this technique.`;
        addManualStep(step);
        resolutions.push({ reference: v.reference, action: 'declared_as_manual_step', detail: step });
        continue;
      }

      try {
        const stat = fs.statSync(sourcePath);
        if (stat.isFile() && stat.size > 0 && stat.size <= AUTO_BUNDLE_MAX_BYTES) {
          const basename = path.basename(sourcePath);
          let destRel = `${AUTO_BUNDLE_SUBDIR}/${basename}`;
          // Disambiguate when two source paths share a basename.
          let n = 1;
          while (bundledDestinations.has(destRel)) {
            n++;
            const parsed = path.parse(basename);
            destRel = `${AUTO_BUNDLE_SUBDIR}/${parsed.name}-${n}${parsed.ext}`;
          }
          bundledDestinations.add(destRel);
          filesToBundle.push({ relPath: destRel, absSourcePath: sourcePath });
          patchedManifest.models_or_assets.push({
            url: `file://${sourcePath}`,
            destination: destRel,
            note: `Auto-bundled by share-export from ${sourcePath} (${stat.size} bytes). TECHNIQUE.md references this file at "${raw}"; receiving trainer drops the bundled copy at ${destRel} and updates the reference if needed.`,
          });
          resolutions.push({
            reference: v.reference,
            action: 'bundled',
            detail: `Bundled ${sourcePath} (${stat.size} bytes) → ${destRel}`,
          });
          continue;
        }
        if (stat.isFile() && stat.size > AUTO_BUNDLE_MAX_BYTES) {
          const step = `Provide file at "${raw}" (${(stat.size / 1024 / 1024).toFixed(1)}MB, exceeds the ${AUTO_BUNDLE_MAX_BYTES / 1024 / 1024}MB auto-bundle cap) — receiving user must supply manually at runtime.`;
          addManualStep(step);
          resolutions.push({ reference: v.reference, action: 'declared_as_manual_step', detail: step });
          continue;
        }
        // Directory or zero-byte file — describe rather than bundle.
        const step = `Provide path at "${raw}" — author had ${stat.isDirectory() ? 'a directory' : 'an empty file'} here at export time; receiving user supplies real contents.`;
        addManualStep(step);
        resolutions.push({ reference: v.reference, action: 'declared_as_manual_step', detail: step });
        continue;
      } catch {
        // ENOENT or perm issue — fall through to the "doesn't exist" path.
      }

      // Source path looked concrete but didn't exist (typical for
      // runtime paths like /tmp/campaign.yaml that the user creates
      // at use-time, not at author-time).
      const step = `User must supply file at "${raw}" at runtime — the technique's instructions reference this path, but no file was present on the author's machine at export. (Common for /tmp paths and other runtime artifacts.)`;
      addManualStep(step);
      resolutions.push({ reference: v.reference, action: 'declared_as_manual_step', detail: step });
      continue;
    }

    // No locatable source — typically a relative path the author meant
    // to ship inside the technique dir but didn't. Receiver can't
    // synthesize this; flag clearly so the original author knows to
    // re-export with the file included.
    const step = `MISSING file "${raw}" — the technique's TECHNIQUE.md references this path, but no such file exists in the technique directory and no source could be located on the author's machine. The original author should add the file and re-export.`;
    addManualStep(step);
    resolutions.push({ reference: v.reference, action: 'declared_as_manual_step', detail: step });
  }

  return { resolutions, patchedManifest, filesToBundle };
}

/**
 * Format a validation result into a single human-readable refusal
 * message suitable for returning to a calling agent.
 */
export function formatValidationRefusal(result: ValidationResult): string {
  if (result.ok) return '';
  const lines: string[] = [];
  lines.push(`Refused: technique file-reference validation found ${result.violations.length} issue(s):`);
  lines.push('');
  for (const v of result.violations) {
    lines.push(`  • [${v.reference.source}] ${v.reference.raw}`);
    lines.push(`    └─ ${v.detail}`);
    if (v.reference.excerpt && v.reference.excerpt !== v.reference.raw) {
      lines.push(`    └─ from: ${v.reference.excerpt}`);
    }
  }
  lines.push('');
  lines.push('Resolve each by EITHER (a) copying the file into the technique\'s support directory and updating TECHNIQUE.md to reference it relatively (e.g. "./script.py"), OR (b) adding it to dependencies.json under repos / models_or_assets / manual_steps so the importing trainer knows how to fetch or build it.');
  return lines.join('\n');
}
