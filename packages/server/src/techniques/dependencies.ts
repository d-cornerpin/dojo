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

  // (1) Markdown links.
  for (const match of markdownContent.matchAll(MARKDOWN_LINK_RE)) {
    push(match[2], 'markdown_link', match[0]);
  }

  // (2) Fenced code blocks — scan the inner text for path-like tokens.
  for (const match of markdownContent.matchAll(FENCED_BLOCK_RE)) {
    const body = match[1];
    for (const m of body.matchAll(PATH_LIKE_RE)) {
      // Find the line containing this token for the excerpt.
      const tokenStart = m.index ?? 0;
      const lineStart = body.lastIndexOf('\n', tokenStart) + 1;
      const lineEnd = body.indexOf('\n', tokenStart);
      const line = body.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      push(m[0], 'code_fence', line);
    }
  }

  // (3) Inline code references — only count ones that look like paths.
  for (const match of markdownContent.matchAll(INLINE_CODE_RE)) {
    push(match[1], 'inline_code', match[0]);
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
  const manifestPaths = new Set<string>();
  for (const r of manifest.repos) {
    if (r.install_to) manifestPaths.add(normalize(r.install_to));
  }
  for (const a of manifest.models_or_assets) {
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
