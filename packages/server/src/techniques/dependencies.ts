// Technique dependency manifest and file-reference validation.
// (1) `dependencies.json`: what the trainer lists that a technique needs beyond its own support dir (system and
// language packages, git repos, downloaded models, manual steps), so an imported technique stays portable.
// (2) Validation: scans TECHNIQUE.md for file references and checks each resolves inside the support dir or is
// declared in the manifest, so a script left outside the dir cannot silently break a shared technique. It runs
// at save time and at export time; a failed save returns a refusal listing every offending reference.

import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../home.js';

export const DEPENDENCY_MANIFEST_FILENAME = 'dependencies.json';
export const DEPENDENCY_MANIFEST_VERSION = 1;


export interface SystemPackageDep {
  /** Package manager: 'brew', 'apt', 'choco', 'winget', etc. */
  manager: string;
  package: string;
  version?: string;
  note?: string;
}

export interface LanguagePackageDep {
  manager: 'npm' | 'pip' | 'gem' | 'cargo' | 'go' | string;
  package: string;
  version?: string;
  /** Directory to install into, relative to the technique dir; a global install if omitted. */
  install_in?: string;
  note?: string;
}

export interface RepoDep {
  url: string;
  /** Branch / tag / commit. Defaults to manager default. */
  ref?: string;
  /** Path inside the technique dir to clone INTO (relative); the importing trainer picks if omitted. */
  install_to?: string;
  note?: string;
}

export interface AssetDep {
  url: string;
  /** Path inside the technique dir to save to (relative); required, or the importer cannot place the asset. */
  destination: string;
  sha256?: string;
  note?: string;
}

export interface DependencyManifest {
  version: typeof DEPENDENCY_MANIFEST_VERSION;
  system_packages: SystemPackageDep[];
  language_packages: LanguagePackageDep[];
  repos: RepoDep[];
  models_or_assets: AssetDep[];
  /** Free-text steps the trainer walks the user through because they cannot be automated. */
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

// Reads the manifest; a missing file gives an empty one, so techniques without a manifest keep loading.
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
    // Corrupt manifest: fall back to empty so the technique still loads.
    return emptyDependencyManifest();
  }
}

export function writeDependencyManifest(dirPath: string, manifest: DependencyManifest): void {
  const filePath = path.join(dirPath, DEPENDENCY_MANIFEST_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

// Heuristic scan of TECHNIQUE.md for the file references an author declares: markdown links [label](path) and
// inline backtick paths with a directory marker (`./x.py`), which also covers "Files Included" bullet lists.
// A path containing '..' is reported as a traversal, not as a missing file.

const URL_LIKE_RE = /^(?:https?:|mailto:|ftp:|file:|data:|tel:)/i;

// A path with an extension, or an explicit-relative shell path; permissive on purpose, the contexts narrow it.
const PATH_LIKE_RE = /(?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-]+\.[A-Za-z0-9]+|\.{1,2}\/[A-Za-z0-9_.-]+/g;

const MARKDOWN_LINK_RE = /\[([^\]]*?)\]\(([^)\s]+)\)/g;
const INLINE_CODE_RE = /`([^`]+?)`/g;
// Fenced blocks are never scanned for references; they are only stripped before the inline scan.
const FENCED_BLOCK_RE = /```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```/g;

export interface FileReference {
  raw: string;
  /** Where in the document the reference was found. */
  source: 'markdown_link' | 'inline_code' | 'code_fence' | 'files_list';
  excerpt: string;
}

export function extractFileReferences(markdownContent: string): FileReference[] {
  const refs: FileReference[] = [];
  const seen = new Set<string>();

  const push = (raw: string, source: FileReference['source'], excerpt: string): void => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (URL_LIKE_RE.test(trimmed)) return;
    const cleaned = trimmed.replace(/^["']+|["']+$/g, '');
    const stripped = cleaned.replace(/[.,;:]+$/g, '');
    if (!stripped) return;
    // Filter: must be path-y. Either an extension, or starts with ./ or ../
    const looksPathy = /\.[A-Za-z0-9]+$/.test(stripped) || /^\.{1,2}\//.test(stripped);
    if (!looksPathy) return;
    // Common false-positive: bare version numbers like "1.2.3", "v2.0".
    if (/^v?\d+(\.\d+)+$/.test(stripped)) return;
    const key = `${source}::${stripped}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ raw: stripped, source, excerpt: excerpt.slice(0, 140) });
  };

  // An inline-code token with no directory marker (`run.py` in prose) is not a path declaration.
  const looksLikeArgvToken = (token: string): boolean => {
    if (token.startsWith('./') || token.startsWith('../') || token.startsWith('/')) return false;
    if (token.includes('/')) return false;
    return true;
  };

  for (const match of markdownContent.matchAll(MARKDOWN_LINK_RE)) {
    push(match[2], 'markdown_link', match[0]);
  }

  // Fenced code blocks are deliberately not scanned: their contents are code, not declarations (method calls
  // like `yaml.safe_load(f)`, domains, and paths the code uses at runtime all look like files), so scanning
  // flagged legitimate techniques. A file is declared by a markdown link, an inline path, or dependencies.json.

  // Inline code counts only with a directory marker. Fenced blocks are stripped first: INLINE_CODE_RE ignores
  // fence boundaries and would pair triple backticks, corrupting every real match after them.
  const inlineScanSource = markdownContent.replace(FENCED_BLOCK_RE, '');
  for (const match of inlineScanSource.matchAll(INLINE_CODE_RE)) {
    const token = match[1];
    if (looksLikeArgvToken(token)) continue;
    push(token, 'inline_code', match[0]);
  }


  return refs;
}


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

// Checks that every file reference in `markdownContent` resolves inside `dirPath` or appears in the manifest
// (the importing trainer will fetch it). Pure: callers decide whether to refuse the save or export, or only log.
export function validateTechniqueFileReferences(
  dirPath: string,
  markdownContent: string,
  manifest: DependencyManifest,
): ValidationResult {
  const refs = extractFileReferences(markdownContent);
  const violations: ValidationViolation[] = [];

  // Every destination path the manifest declares in repos / assets is acceptable (the importing trainer will
  // populate it). Null-coalesce: callers hand in partial manifests, and iterating a missing array would
  // surface as an engine fault rather than the caller's bad payload.
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
    const onDisk = path.join(dirPath, norm);
    if (fs.existsSync(onDisk)) continue;
    // Acceptable if the manifest declares this destination.
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

// Auto-resolution: try to resolve each violation instead of refusing the export. (1) A real file on the
// author's disk (absolute, ~/ or `..`-escape) is copied into the export bundle and declared in the manifest.
// (2) A path that exists nowhere (a runtime file such as /tmp/campaign.yaml) becomes a manual_step. (3) A
// relative path missing from the technique dir becomes a manual_step noting the author must re-export.
// Sensitive files (~/.ssh keys, secrets, .env, cloud creds) are never bundled whatever the reference points at:
// they get a manual step instead, so secrets never cross the share boundary.

/** Max size of any single auto-bundled file (avoid bloating the zip). */
const AUTO_BUNDLE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const AUTO_BUNDLE_SUBDIR = 'bundled-assets';

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

// Twin of `isSensitivePath` (agent/path-guards.ts); keep in sync. A false negative leaks secrets, a false
// positive only costs one extra manual_step entry.
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
  const home = homeDir();
  if (absPath.startsWith(path.join(home, '.ssh') + path.sep) && !base.endsWith('.pub')) return true;
  if (absPath === path.join(home, '.aws', 'credentials')) return true;
  if (absPath.startsWith(path.join(home, '.config', 'gcloud') + path.sep)) return true;
  if (absPath === path.join(home, '.kube', 'config')) return true;
  if (absPath.startsWith(path.join(home, '.dojo') + path.sep) && base.startsWith('secret')) return true;
  return false;
}

// Resolve a raw reference to an absolute source path on disk, or null when it does not point at a locatable
// path (a URL-like string, or a relative path under the technique dir that is already known to be missing).
function resolveSourcePath(raw: string, dirPath: string): string | null {
  if (raw.startsWith('~/')) return path.join(homeDir(), raw.slice(2));
  if (raw === '~') return homeDir();
  if (path.isAbsolute(raw)) return raw;
  if (raw.split(/[\\/]/).includes('..')) return path.resolve(dirPath, raw);
  return null;
}

export function autoResolveViolations(
  dirPath: string,
  violations: ValidationViolation[],
  manifest: DependencyManifest,
): AutoResolveResult {
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

  // Dedupe by normalized destination so a file mentioned repeatedly gets one manifest row and one zip copy.
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
        // Directory or zero-byte file: describe rather than bundle.
        const step = `Provide path at "${raw}" — author had ${stat.isDirectory() ? 'a directory' : 'an empty file'} here at export time; receiving user supplies real contents.`;
        addManualStep(step);
        resolutions.push({ reference: v.reference, action: 'declared_as_manual_step', detail: step });
        continue;
      } catch {
        // ENOENT or permission issue: fall through to the "doesn't exist" path.
      }

      // A concrete-looking path that does not exist (a runtime path the user creates at use time).
      const step = `User must supply file at "${raw}" at runtime — the technique's instructions reference this path, but no file was present on the author's machine at export. (Common for /tmp paths and other runtime artifacts.)`;
      addManualStep(step);
      resolutions.push({ reference: v.reference, action: 'declared_as_manual_step', detail: step });
      continue;
    }

    // No locatable source: usually a relative path the author meant to ship but did not; flag it so the
    // author re-exports with the file included.
    const step = `MISSING file "${raw}" — the technique's TECHNIQUE.md references this path, but no such file exists in the technique directory and no source could be located on the author's machine. The original author should add the file and re-export.`;
    addManualStep(step);
    resolutions.push({ reference: v.reference, action: 'declared_as_manual_step', detail: step });
  }

  return { resolutions, patchedManifest, filesToBundle };
}

// Format a validation result into one human-readable refusal message for the calling agent.
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
