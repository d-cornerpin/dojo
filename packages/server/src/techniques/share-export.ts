// ════════════════════════════════════════
// Technique Export (Share)
// ════════════════════════════════════════
//
// Packages a technique + its supporting files into a portable `.dojo`
// zip that another Dojo install can import. Secrets are stripped by
// scrub.ts and replaced with {{NEEDS_FROM_USER:LABEL}} placeholders;
// Yoshi (trainer) does a second pass to flag any patterns the
// deterministic scrubber missed and writes the README that walks the
// importer through setup.

import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { Readable, PassThrough } from 'node:stream';
// Readable is part of the return type so callers know they can pipe it.
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { getTechnique } from './store.js';
import { scrubFiles, isBinaryFile, type Redaction } from './scrub.js';
import { callModel } from '../agent/model.js';
import { getTrainerAgentId } from '../config/platform.js';
import {
  readDependencyManifest,
  validateTechniqueFileReferences,
  autoResolveViolations,
  type AutoResolution,
  type DependencyManifest,
} from './dependencies.js';

/**
 * Thrown when export-time validation finds TECHNIQUE.md references
 * that aren't satisfied by the support dir or the dependency manifest.
 * The HTTP route catches this and surfaces the refusal text as a 422
 * to the dashboard so the user gets a clear "ask your trainer to fix
 * technique X" message instead of a corrupt download.
 */
export class TechniqueExportValidationError extends Error {
  constructor(public refusalText: string) {
    super(refusalText);
    this.name = 'TechniqueExportValidationError';
  }
}

const logger = createLogger('technique-share-export');

const PACKAGE_FORMAT = 'dojo-technique';
const PACKAGE_FORMAT_VERSION = 1;

export interface ExportManifest {
  format: typeof PACKAGE_FORMAT;
  version: typeof PACKAGE_FORMAT_VERSION;
  technique: {
    id: string;            // original slug — importer may rename to avoid collisions
    name: string;          // display name
    description: string | null;
    tags: string[];
    version: number;
    author_agent_name: string | null;
  };
  exported_at: string;
  placeholders: Array<{ label: string; hint: string; files: string[] }>;
}

interface FileEntry {
  relPath: string;        // path within technique dir, forward slashes
  content?: string;        // text content (text files only)
  absSourcePath: string;   // absolute path on disk (for binary streaming)
  isBinary: boolean;
}

/**
 * Walk the technique directory and return every file we want in the
 * zip. Skips metadata.json (DB is the source of truth), and skips the
 * versions/ folder (snapshots are reconstructable from the latest
 * TECHNIQUE.md + version history — including them would bloat the
 * package and leak old un-scrubbed content).
 */
function collectTechniqueFiles(dirPath: string): FileEntry[] {
  const entries: FileEntry[] = [];

  function walk(absDir: string, relPrefix: string): void {
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirEntries) {
      const absPath = path.join(absDir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.name === 'metadata.json') continue;
      if (entry.name === 'versions') continue;
      if (entry.name === 'IMPORT_MANIFEST.json') continue; // only present on imported techniques

      if (entry.isDirectory()) {
        walk(absPath, relPath);
        continue;
      }

      const binary = isBinaryFile(relPath);
      if (binary) {
        entries.push({ relPath, absSourcePath: absPath, isBinary: true });
      } else {
        try {
          const content = fs.readFileSync(absPath, 'utf-8');
          entries.push({ relPath, absSourcePath: absPath, isBinary: false, content });
        } catch (err) {
          logger.warn('Failed to read technique file for export', { absPath, err: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  walk(dirPath, '');
  return entries;
}

/**
 * Run the deterministic scrubber over the text files in the package.
 * Returns the post-scrub view that will go into the zip (binary files
 * pass through untouched).
 */
function applyScrub(entries: FileEntry[]): { entries: FileEntry[]; redactions: Redaction[]; placeholders: Array<{ label: string; hint: string; files: string[] }> } {
  const textFiles = entries
    .filter((e): e is FileEntry & { content: string } => !e.isBinary && e.content !== undefined)
    .map(e => ({ path: e.relPath, content: e.content }));

  const result = scrubFiles(textFiles);

  // Build label → files map for the manifest
  const filesByLabel = new Map<string, Set<string>>();
  for (const r of result.redactions) {
    const set = filesByLabel.get(r.label) ?? new Set<string>();
    set.add(r.file);
    filesByLabel.set(r.label, set);
  }

  const placeholders = result.placeholders.map(p => ({
    label: p.label,
    hint: p.hint,
    files: Array.from(filesByLabel.get(p.label) ?? []),
  }));

  const next: FileEntry[] = entries.map(e => {
    if (e.isBinary || e.content === undefined) return e;
    const scrubbed = result.scrubbed.get(e.relPath);
    return scrubbed !== undefined ? { ...e, content: scrubbed } : e;
  });

  return { entries: next, redactions: result.redactions, placeholders };
}

/**
 * Ask Yoshi (the trainer model) to:
 *   1. Flag any remaining secret-shaped strings the regexes missed.
 *   2. Write a README.md that walks the importer through any setup
 *      steps (placeholders, manual steps, external accounts needed).
 *
 * Returns { readme, additionalRedactions }. additionalRedactions are
 * applied to the entries after Yoshi's pass.
 *
 * If the model call fails for any reason we fall back to a
 * deterministically-generated README so export still succeeds.
 */
async function runTrainerReviewPass(
  technique: { id: string; name: string; description: string | null },
  entries: FileEntry[],
  initialPlaceholders: Array<{ label: string; hint: string; files: string[] }>,
): Promise<{ readme: string; additionalRedactions: Array<{ file: string; value: string; label: string; hint: string }> }> {
  const db = getDb();
  const trainerId = getTrainerAgentId();

  // Pick a model — prefer the explicit trainer_agent_model, fall back to
  // the primary agent's model. If neither is set we skip the LLM pass
  // and emit a deterministic README.
  const trainerModelRow = db.prepare("SELECT value FROM config WHERE key = 'trainer_agent_model'").get() as { value: string } | undefined;
  let modelId = trainerModelRow?.value ?? null;
  if (!modelId) {
    const primaryRow = db.prepare("SELECT model_id FROM agents WHERE id = (SELECT value FROM config WHERE key = 'primary_agent_id')").get() as { model_id: string | null } | undefined;
    modelId = primaryRow?.model_id ?? null;
  }

  if (!modelId) {
    logger.warn('No model configured for Trainer review pass — falling back to deterministic README');
    return { readme: buildFallbackReadme(technique, entries, initialPlaceholders), additionalRedactions: [] };
  }

  // Build the package summary the model will review. We only include
  // text files — binary files don't need scrubbing and bloat the prompt.
  const textEntries = entries.filter(e => !e.isBinary && e.content !== undefined);
  const bundleForModel = textEntries.map(e => `### File: ${e.relPath}\n\`\`\`\n${e.content}\n\`\`\``).join('\n\n');

  const placeholderSummary = initialPlaceholders.length === 0
    ? '(none — the deterministic scrubber found no secrets)'
    : initialPlaceholders.map(p => `- ${p.label}: ${p.hint} (in: ${p.files.join(', ')})`).join('\n');

  const systemPrompt = `You are reviewing a technique package being exported from one Dojo agent platform to another, and writing the README that the receiving Dojo's trainer will follow to recreate the technique.

You have two jobs:

1. SECRET REVIEW. A deterministic scrubber has already replaced obvious API keys, tokens, and credentials with placeholders like {{NEEDS_FROM_USER:LABEL}}. Look at the files for anything secret-shaped it might have missed — unusual API key formats, long opaque strings near words like "key"/"token"/"secret", hardcoded passwords, private URLs that should be customized per install, etc. If you find any, list each one as JSON inside a <ADDITIONAL_REDACTIONS> block.

2. README. Write a README.md that the receiving trainer (also you, on the importing side) will use to recreate the technique. Cover:
   - One-paragraph summary of what the technique does.
   - Any external services or accounts required.
   - Each placeholder: what it is, where to get it.
   - Any manual setup steps (installing deps, granting permissions, etc.) that aren't already in TECHNIQUE.md.
   - Anything else a future trainer needs to know that isn't obvious from the files.

Output format — output EXACTLY this structure, nothing else:

<ADDITIONAL_REDACTIONS>
[
  {"file": "path/relative/to/technique", "value": "the literal string that should be redacted", "label": "PLACEHOLDER_LABEL", "hint": "human-readable hint for what this is"}
]
</ADDITIONAL_REDACTIONS>

<README>
# (full README markdown here)
</README>

If you find no additional redactions, the ADDITIONAL_REDACTIONS block should contain just []. Do not include any prose outside the two blocks.`;

  const userMessage = `Technique: ${technique.name} (id: ${technique.id})
Description: ${technique.description ?? '(none)'}

Placeholders the scrubber already identified:
${placeholderSummary}

Package contents (text files only):

${bundleForModel}`;

  try {
    const result = await callModel({
      agentId: trainerId,
      modelId,
      systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      tools: false,
    });

    const text = result.content || '';
    const redactBlock = text.match(/<ADDITIONAL_REDACTIONS>\s*([\s\S]*?)\s*<\/ADDITIONAL_REDACTIONS>/);
    const readmeBlock = text.match(/<README>\s*([\s\S]*?)\s*<\/README>/);

    let additionalRedactions: Array<{ file: string; value: string; label: string; hint: string }> = [];
    if (redactBlock) {
      try {
        const parsed = JSON.parse(redactBlock[1].trim());
        if (Array.isArray(parsed)) {
          additionalRedactions = parsed.filter((r): r is { file: string; value: string; label: string; hint: string } =>
            r && typeof r.file === 'string' && typeof r.value === 'string' && typeof r.label === 'string' && typeof r.hint === 'string',
          );
        }
      } catch (err) {
        logger.warn('Trainer returned non-JSON ADDITIONAL_REDACTIONS, ignoring', { err: err instanceof Error ? err.message : String(err) });
      }
    }

    const readme = readmeBlock ? readmeBlock[1].trim() : buildFallbackReadme(technique, entries, initialPlaceholders);
    return { readme, additionalRedactions };
  } catch (err) {
    logger.warn('Trainer review pass failed — falling back to deterministic README', { err: err instanceof Error ? err.message : String(err) });
    return { readme: buildFallbackReadme(technique, entries, initialPlaceholders), additionalRedactions: [] };
  }
}

function buildFallbackReadme(
  technique: { id: string; name: string; description: string | null },
  entries: FileEntry[],
  placeholders: Array<{ label: string; hint: string; files: string[] }>,
): string {
  const lines: string[] = [];
  lines.push(`# ${technique.name}`);
  lines.push('');
  if (technique.description) {
    lines.push(technique.description);
    lines.push('');
  }
  lines.push('This is a Dojo technique package. Import it via the Techniques page in your Dojo dashboard.');
  lines.push('');
  if (placeholders.length > 0) {
    lines.push('## Required Setup');
    lines.push('');
    lines.push('The exporter scrubbed the following secrets from the package. Your trainer will ask you for each one during import:');
    lines.push('');
    for (const p of placeholders) {
      lines.push(`- **${p.label}** — ${p.hint}`);
    }
    lines.push('');
  } else {
    lines.push('No secrets were detected by the scrubber. No setup placeholders to fill.');
    lines.push('');
  }
  lines.push('## Contents');
  lines.push('');
  for (const e of entries) {
    lines.push(`- \`${e.relPath}\`${e.isBinary ? ' (binary)' : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Build the technique package and return a Readable stream of the
 * resulting zip (so callers can pipe it to the HTTP response).
 *
 * The zip layout:
 *   manifest.json          — format identifier + technique meta + placeholder list
 *   README.md              — Yoshi-generated setup instructions
 *   TECHNIQUE.md           — the main instructions (scrubbed)
 *   <relative-paths>...   — every other supporting file (scrubbed if text)
 */
export async function exportTechnique(
  techniqueId: string,
): Promise<{ stream: Readable; filename: string; autoResolutions: AutoResolution[] }> {
  const technique = getTechnique(techniqueId);
  if (!technique) {
    throw new Error(`Technique "${techniqueId}" not found`);
  }

  // ── Auto-resolve file references (v2.7.5) ──
  // Pre-v2.7.5 this path refused the export when TECHNIQUE.md
  // referenced anything not on disk and not declared in
  // dependencies.json. That was wrong: agents don't fix techniques,
  // they author them — and the user shouldn't have to play
  // dependency-manifest-whack-a-mole every time they want to share.
  //
  // Now: run validation, then try to RESOLVE each violation —
  //   • Concrete source paths (absolute, ~/, ../) that exist on disk
  //     and aren't sensitive get COPIED into the zip and declared in
  //     the manifest as bundled assets.
  //   • Concrete source paths that don't exist (runtime artifacts
  //     like /tmp/foo.yaml) get added as manual_steps with a
  //     "user supplies at runtime" note.
  //   • References we can't locate at all get added as manual_steps
  //     with a "MISSING — author should re-export" note.
  // Whatever's left after auto-resolve is returned alongside the
  // stream for the dashboard to surface via toast. Export ALWAYS
  // produces a zip.
  let workingManifest: DependencyManifest = readDependencyManifest(technique.directoryPath);
  let autoResolutions: AutoResolution[] = [];
  const extraBundledFiles: Array<{ relPath: string; absSourcePath: string }> = [];

  const mdPath = path.join(technique.directoryPath, 'TECHNIQUE.md');
  if (fs.existsSync(mdPath)) {
    const md = fs.readFileSync(mdPath, 'utf-8');
    const validation = validateTechniqueFileReferences(technique.directoryPath, md, workingManifest);
    if (!validation.ok) {
      const resolved = autoResolveViolations(technique.directoryPath, validation.violations, workingManifest);
      workingManifest = resolved.patchedManifest;
      autoResolutions = resolved.resolutions;
      extraBundledFiles.push(...resolved.filesToBundle);
      logger.info('Export auto-resolved file references', {
        techniqueId,
        violationCount: validation.violations.length,
        bundledCount: resolved.filesToBundle.length,
        manualStepCount: resolved.resolutions.filter(r => r.action === 'declared_as_manual_step').length,
      });
    }
  }

  const entries = collectTechniqueFiles(technique.directoryPath);
  if (entries.length === 0) {
    throw new Error(`Technique "${techniqueId}" has no files to export`);
  }

  const { entries: scrubbedEntries, placeholders: initialPlaceholders } = applyScrub(entries);

  // Trainer review pass — may add more redactions and writes the README
  const { readme, additionalRedactions } = await runTrainerReviewPass(
    { id: technique.id, name: technique.name, description: technique.description },
    scrubbedEntries,
    initialPlaceholders,
  );

  // Apply trainer-flagged redactions
  let finalEntries = scrubbedEntries;
  const placeholderMap = new Map<string, { label: string; hint: string; files: Set<string> }>();
  for (const p of initialPlaceholders) {
    placeholderMap.set(p.label, { label: p.label, hint: p.hint, files: new Set(p.files) });
  }
  if (additionalRedactions.length > 0) {
    finalEntries = scrubbedEntries.map(e => {
      if (e.isBinary || e.content === undefined) return e;
      const fileRedactions = additionalRedactions.filter(r => r.file === e.relPath);
      if (fileRedactions.length === 0) return e;
      let content = e.content;
      for (const r of fileRedactions) {
        if (!r.value || !content.includes(r.value)) continue;
        content = content.split(r.value).join(`{{NEEDS_FROM_USER:${r.label}}}`);
        const existing = placeholderMap.get(r.label) ?? { label: r.label, hint: r.hint, files: new Set<string>() };
        existing.files.add(e.relPath);
        placeholderMap.set(r.label, existing);
      }
      return { ...e, content };
    });
  }

  const manifest: ExportManifest = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_FORMAT_VERSION,
    technique: {
      id: technique.id,
      name: technique.name,
      description: technique.description,
      tags: technique.tags,
      version: technique.version,
      author_agent_name: technique.authorAgentName,
    },
    exported_at: new Date().toISOString(),
    placeholders: Array.from(placeholderMap.values()).map(p => ({
      label: p.label,
      hint: p.hint,
      files: Array.from(p.files),
    })),
  };

  // Stream the zip
  const archive = archiver('zip', { zlib: { level: 6 } });
  const passthrough = new PassThrough();
  archive.on('error', (err) => passthrough.destroy(err));
  archive.pipe(passthrough);

  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  archive.append(readme, { name: 'README.md' });

  // Substitute the auto-resolver's patched dependencies.json for
  // whatever was in the technique directory. The on-disk version is
  // untouched; the substitution only affects the zip.
  const bundledFilePaths = new Set([
    'dependencies.json',
    ...extraBundledFiles.map(f => f.relPath),
  ]);
  for (const entry of finalEntries) {
    if (bundledFilePaths.has(entry.relPath)) continue; // handled below
    if (entry.isBinary) {
      archive.file(entry.absSourcePath, { name: entry.relPath });
    } else if (entry.content !== undefined) {
      archive.append(entry.content, { name: entry.relPath });
    }
  }
  archive.append(JSON.stringify(workingManifest, null, 2) + '\n', { name: 'dependencies.json' });

  // Auto-bundled assets (files the auto-resolver pulled from elsewhere
  // on disk). These weren't part of the technique directory walk so
  // we add them here. Streaming the absolute source path keeps memory
  // flat regardless of file size.
  for (const f of extraBundledFiles) {
    archive.file(f.absSourcePath, { name: f.relPath });
  }

  archive.finalize();

  const safeName = technique.id.replace(/[^a-z0-9-]/g, '-');
  return { stream: passthrough, filename: `${safeName}.dojo.zip`, autoResolutions };
}
