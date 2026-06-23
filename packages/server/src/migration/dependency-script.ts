// ════════════════════════════════════════
// Dependency setup-script generator (migration)
//
// On export we walk every technique's dependencies.json and emit a single
// bash script that installs the external tools they rely on but that don't
// ship with DOJO: system packages (brew/apt/choco), language packages
// (npm/pip/gem/cargo/go), git repos, and downloadable assets. The script
// travels inside the archive and is run (user-triggered) on the new machine.
//
// SAFETY: the script is generated ONLY from the structured manifest fields,
// and every interpolated value is validated against a strict allow-list so a
// tampered manifest cannot inject arbitrary shell. Anything that fails
// validation is emitted as a commented-out warning, never executed. The script
// continues past failures and reports them at the end; each step is guarded so
// re-running is safe.
// ════════════════════════════════════════
import path from 'node:path';
import { getDb } from '../db/connection.js';
import { readDependencyManifest } from '../techniques/dependencies.js';
import { createLogger } from '../logger.js';

const logger = createLogger('dependency-script');

// Package names / refs: letters, digits, and a small set of safe punctuation.
const SAFE_TOKEN = /^[A-Za-z0-9._@/+:=~-]+$/;
// URLs: http(s) only, no shell metacharacters.
const SAFE_URL = /^https?:\/\/[^\s"'`$;&|<>()]+$/;
// Relative paths inside a technique dir: no absolute paths, no traversal, no
// shell metacharacters.
const SAFE_RELPATH = /^[A-Za-z0-9._/-]+$/;

function safeToken(v: string | undefined | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return SAFE_TOKEN.test(t) ? t : null;
}
function safeUrl(v: string | undefined | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return SAFE_URL.test(t) ? t : null;
}
function safeRel(v: string | undefined | null): string | null {
  if (!v) return null;
  const t = v.trim();
  if (t.includes('..')) return null;
  return SAFE_RELPATH.test(t) ? t : null;
}

function sysInstallCmd(manager: string, pkg: string): string | null {
  switch (manager) {
    case 'brew': return `brew install ${pkg}`;
    case 'apt': return `sudo apt-get install -y ${pkg}`;
    case 'choco': return `choco install -y ${pkg}`;
    case 'winget': return `winget install -e --id ${pkg}`;
    default: return null;
  }
}
function langInstallCmd(manager: string, pkg: string, local: boolean): string | null {
  switch (manager) {
    case 'npm': return local ? `npm install ${pkg}` : `npm install -g ${pkg}`;
    case 'pip':
    case 'pip3': return local ? `pip3 install --target . ${pkg}` : `pip3 install ${pkg}`;
    case 'gem': return `gem install ${pkg}`;
    case 'cargo': return `cargo install ${pkg}`;
    case 'go': return `go install ${pkg}`;
    default: return null;
  }
}

interface DepScriptResult {
  /** The bash script text, or null when no technique declares any dependency. */
  script: string | null;
  /** Count of techniques that contributed at least one step. */
  techniqueCount: number;
  /** Count of executable steps (installs/clones/downloads). */
  stepCount: number;
}

export function generateDependencySetupScript(exportedAtIso: string): DepScriptResult {
  let techs: Array<{ name: string; directory_path: string | null }> = [];
  try {
    techs = getDb()
      .prepare('SELECT name, directory_path FROM techniques WHERE directory_path IS NOT NULL ORDER BY name')
      .all() as Array<{ name: string; directory_path: string | null }>;
  } catch {
    return { script: null, techniqueCount: 0, stepCount: 0 };
  }

  const blocks: string[] = [];
  let techniqueCount = 0;
  let stepCount = 0;

  for (const t of techs) {
    if (!t.directory_path) continue;
    // The technique dir resolves under $HOME on the NEW machine.
    const techBase = `"$HOME/.dojo/techniques/${path.basename(t.directory_path)}"`;
    const dir = t.directory_path.startsWith('~/')
      ? path.join(process.env.HOME ?? '', t.directory_path.slice(2))
      : t.directory_path;
    let manifest;
    try {
      manifest = readDependencyManifest(dir);
    } catch {
      continue;
    }

    const lines: string[] = [];

    for (const p of manifest.system_packages) {
      const pkg = safeToken(p.package);
      if (!pkg) { lines.push(`# SKIPPED unsafe system package name: ${JSON.stringify(p.package)}`); continue; }
      const cmd = sysInstallCmd(p.manager, pkg);
      if (!cmd) { lines.push(`# MANUAL: install system package "${pkg}" via ${p.manager} (manager not auto-handled)`); continue; }
      lines.push(`run ${cmd}`);
      stepCount++;
    }
    for (const p of manifest.language_packages) {
      const pkg = safeToken(p.package);
      if (!pkg) { lines.push(`# SKIPPED unsafe package name: ${JSON.stringify(p.package)}`); continue; }
      const installIn = safeRel(p.install_in);
      const cmd = langInstallCmd(p.manager, pkg, !!installIn);
      if (!cmd) { lines.push(`# MANUAL: install ${p.manager} package "${pkg}" (manager not auto-handled)`); continue; }
      if (installIn) {
        lines.push(`( cd ${techBase}/${installIn} 2>/dev/null && run ${cmd} ) || echo "  ! dir missing: ${installIn}"`);
      } else {
        lines.push(`run ${cmd}`);
      }
      stepCount++;
    }
    for (const r of manifest.repos) {
      const url = safeUrl(r.url);
      if (!url) { lines.push(`# SKIPPED unsafe repo url: ${JSON.stringify(r.url)}`); continue; }
      const into = safeRel(r.install_to) ?? path.basename(url).replace(/\.git$/, '');
      const ref = safeToken(r.ref);
      const dest = `${techBase}/${into}`;
      const clone = ref ? `git clone --branch ${ref} ${url} ${dest}` : `git clone ${url} ${dest}`;
      lines.push(`[ -d ${dest} ] || run ${clone}`);
      stepCount++;
    }
    for (const a of manifest.models_or_assets) {
      const url = safeUrl(a.url);
      const dest = safeRel(a.destination);
      if (!url || !dest) { lines.push(`# SKIPPED unsafe asset (url/destination): ${JSON.stringify(a.url)}`); continue; }
      const target = `${techBase}/${dest}`;
      lines.push(`[ -f ${target} ] || run curl -fL ${url} -o ${target}`);
      stepCount++;
    }
    for (const step of manifest.manual_steps) {
      lines.push(`echo "  MANUAL: ${step.replace(/"/g, "'").replace(/[$`\\]/g, '')}"`);
    }

    if (lines.length === 0) continue;
    techniqueCount++;
    blocks.push(`note ${JSON.stringify(t.name)}\n${lines.join('\n')}`);
  }

  if (blocks.length === 0) {
    return { script: null, techniqueCount: 0, stepCount: 0 };
  }

  const header = [
    '#!/usr/bin/env bash',
    '# ─────────────────────────────────────────────────────────────────────',
    '# DOJO technique dependencies installer',
    `# Auto-generated by the DOJO export on ${exportedAtIso}.`,
    '# Installs external tools your techniques rely on that do not ship with',
    '# DOJO. Review before running. Safe to re-run: each step is guarded and',
    '# errors do not stop the rest.',
    '# ─────────────────────────────────────────────────────────────────────',
    'set -u',
    'FAILED=0',
    'note() { printf "\\n=== %s ===\\n" "$1"; }',
    'run()  { echo "+ $*"; eval "$@" || { echo "  ! FAILED: $*"; FAILED=1; }; }',
    '',
    'echo "Installing technique dependencies for your migrated dojo..."',
    '',
  ].join('\n');

  const footer = [
    '',
    'if [ "$FAILED" = "1" ]; then',
    '  echo "";  echo "Some steps failed (see ! lines above). Install those manually, then re-run."',
    '  exit 1',
    'else',
    '  echo ""; echo "All dependency steps completed."',
    'fi',
    '',
  ].join('\n');

  const script = `${header}\n${blocks.join('\n\n')}\n${footer}`;
  logger.info('Generated dependency setup script', { techniqueCount, stepCount });
  return { script, techniqueCount, stepCount };
}

// ── Combined installer (run at import time on the NEW machine) ──
//
// Wraps the bundled per-technique installer with a guarded preamble that brings
// up the core tools the migrated dojo needs but that aren't technique deps:
// Ollama (if the dojo uses local models) and cloudflared (if a tunnel is
// configured). Each install is guarded by `command -v`, so re-running is a
// no-op. Ollama MODEL downloads are intentionally left out — those run in the
// background via runPostMigrationChecks once Ollama is on PATH. Output flows
// through the same stdout/stderr the run-dependency-setup route streams.
export function buildCombinedInstaller(): string {
  let needOllama = false;
  let needCloudflared = false;
  try {
    const db = getDb();
    // Ollama: any provider of type 'ollama' (or named ollama) in the restored db.
    const ollamaRow = db
      .prepare("SELECT 1 FROM providers WHERE type = 'ollama' OR lower(name) LIKE '%ollama%' LIMIT 1")
      .get();
    needOllama = !!ollamaRow;
    // cloudflared: a tunnel was enabled on the source machine.
    const tunnelRow = db
      .prepare("SELECT value FROM config WHERE key = 'tunnel_enabled'")
      .get() as { value: string } | undefined;
    needCloudflared = tunnelRow?.value === 'true';
  } catch { /* fresh/partial db — install nothing extra */ }

  const pre: string[] = [];
  if (needOllama || needCloudflared) {
    pre.push('note "Core tools"');
    pre.push('if ! command -v brew >/dev/null 2>&1; then');
    pre.push('  echo "  ! Homebrew not found — install it from https://brew.sh, then re-run."; FAILED=1');
    pre.push('fi');
    if (needOllama) {
      pre.push('command -v ollama >/dev/null 2>&1 || run brew install ollama');
    }
    if (needCloudflared) {
      pre.push('command -v cloudflared >/dev/null 2>&1 || run brew install cloudflared');
    }
  }

  const header = [
    '#!/usr/bin/env bash',
    '# DOJO combined dependency installer (core tools + technique deps).',
    'set -u',
    'FAILED=0',
    'note() { printf "\\n=== %s ===\\n" "$1"; }',
    'run()  { echo "+ $*"; eval "$@" || { echo "  ! FAILED: $*"; FAILED=1; }; }',
    '',
    'echo "Setting up your migrated dojo..."',
    '',
  ].join('\n');

  // The bundled per-technique installer is self-contained; invoke it as a child
  // so its own guards/exit handling stay intact. Its output streams up too.
  const techniques = [
    '',
    'note "Technique dependencies"',
    'if [ -f "$HOME/.dojo/setup-dependencies.sh" ]; then',
    '  bash "$HOME/.dojo/setup-dependencies.sh" || FAILED=1',
    'else',
    '  echo "  (no technique dependency installer was bundled with this export)"',
    'fi',
  ].join('\n');

  const footer = [
    '',
    'if [ "$FAILED" = "1" ]; then',
    '  echo ""; echo "Some steps failed (see ! lines above). Install those manually, then re-run."',
    '  exit 1',
    'else',
    '  echo ""; echo "All setup steps completed."',
    'fi',
    '',
  ].join('\n');

  return `${header}\n${pre.join('\n')}\n${techniques}\n${footer}`;
}
