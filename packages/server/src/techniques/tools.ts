// Technique agent tools.

import * as effectFs from '../agent/effects/fs.js';
import { supportingFileTargets } from './technique-folder.js';
import path from 'node:path';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import {
  createTechnique,
  getTechnique,
  getTechniqueDetail,
  listTechniques,
  updateTechnique,
  updateTechniqueInstructions,
  updateTechniqueDependencies,
  publishTechnique,
  recordTechniqueUsage,
  resolveTechniqueRef,
  TechniqueValidationError,
} from './store.js';
import {
  readImportManifest,
  applyPlaceholderToTechnique,
  findRemainingPlaceholders,
  finalizeImportedTechnique,
} from './import-setup.js';
import {
  type DependencyManifest,
  emptyDependencyManifest,
} from './dependencies.js';
import { VERSIONS_SUBDIR } from './versioning.js';
import { getTrainerAgentId, getTrainerAgentName, isTrainerAgent } from '../config/platform.js';
import { mayUseTechnique } from '../agent/access/read.js';

const logger = createLogger('technique-tools');

// Authorization for technique-mutating tools (save/update/publish/delete): null when allowed, else a refusal
// string. The trainer is always allowed; with no live trainer any sensei-class caller is (otherwise every
// mutation would be refused); everyone else is redirected to the trainer.
function authorizeTechniqueMutation(agentId: string, classification: string, verb: string): string | null {
  if (isTrainerAgent(agentId)) return null;

  // No live trainer: allow sensei-class callers so the feature still works on a trainer-less install.
  try {
    const trainerId = getTrainerAgentId();
    const row = getDb()
      .prepare("SELECT status FROM agents WHERE id = ?")
      .get(trainerId) as { status: string } | undefined;
    if (!row || row.status === 'terminated') {
      if (classification === 'sensei') return null;
      return `Refused: ${verb} is restricted to Sensei agents (no live trainer agent on this install).`;
    }
  } catch {
    // DB hiccup: be permissive rather than block legitimate work.
    if (classification === 'sensei') return null;
  }

  const trainerName = getTrainerAgentName();
  return (
    `Refused: ${verb} is reserved for the trainer agent (${trainerName}). ` +
    `Techniques are owned by ${trainerName} so that support files, dependency manifests, and file-reference integrity all stay in one place — when techniques get shared, that ownership is what makes the package portable. ` +
    `Send a message to ${trainerName} describing what you want built (include any custom scripts/files in the message body or via shared-files), and they'll create / edit the technique on your behalf.`
  );
}

// Every technique_read / use_technique response is prefixed with TECHNIQUE_FRESH_SENTINEL (from @dojo/shared).
// Consumers: memory/assembler.ts stubs prior technique reads so an agent cannot lean on an earlier one;
// vault_remember and scratchpad_set refuse content containing it; compaction stubs sentinel-wrapped blocks
// before summarizing so technique text never reaches a summary as authority. The banner only identifies the
// result: the enforcement policy lives in the tool descriptions, because spelling it out in every response
// made agents doubt the content was fresh.
export { TECHNIQUE_FRESH_SENTINEL } from '@dojo/shared';
import { TECHNIQUE_FRESH_SENTINEL } from '@dojo/shared';
import { compactCountNote } from '../agent/tool-helpers.js';

function wrapTechniqueResult(techniqueName: string, body: string): string {
  return (
    `${TECHNIQUE_FRESH_SENTINEL} ${techniqueName} (${new Date().toISOString()})\n` +
    `${body}`
  );
}

// Turn the structured TechniqueValidationError into a refusal the agent reads, not a generic platform error.
function formatValidationError(err: unknown, fallbackPrefix: string): string {
  if (err instanceof TechniqueValidationError) return err.refusalText;
  const msg = err instanceof Error ? err.message : String(err);
  return `${fallbackPrefix}: ${msg}`;
}


export function executeSaveTechnique(agentId: string, agentName: string, classification: string, args: Record<string, unknown>): string {
  const refusal = authorizeTechniqueMutation(agentId, classification, 'save_technique');
  if (refusal) return refusal;

  const name = args.name as string;
  const displayName = args.display_name as string;
  const description = args.description as string;
  const instructions = args.instructions as string;
  const tags = (args.tags as string[]) ?? [];
  const files = args.files as Array<{ path: string; content: string }> | undefined;
  // Partial-manifest tolerance: models often send only some buckets (`{ system_packages: [] }`). Deep-merge into
  // a fresh empty manifest so every bucket is an array and the validator never iterates undefined.
  const rawDeps = (args.dependencies ?? {}) as Partial<DependencyManifest>;
  const base = emptyDependencyManifest();
  const dependencies: DependencyManifest = {
    version: base.version,
    system_packages: Array.isArray(rawDeps.system_packages) ? rawDeps.system_packages : base.system_packages,
    language_packages: Array.isArray(rawDeps.language_packages) ? rawDeps.language_packages : base.language_packages,
    repos: Array.isArray(rawDeps.repos) ? rawDeps.repos : base.repos,
    models_or_assets: Array.isArray(rawDeps.models_or_assets) ? rawDeps.models_or_assets : base.models_or_assets,
    manual_steps: Array.isArray(rawDeps.manual_steps) ? rawDeps.manual_steps : base.manual_steps,
  };
  const publish = args.publish as boolean ?? false;

  if (!name || !displayName || !description || !instructions) {
    return 'Error: name, display_name, description, and instructions are all required.';
  }

  try {
    const technique = createTechnique({
      name,
      displayName,
      description,
      instructions,
      tags,
      files,
      dependencies,
      publish,
      authorAgentId: agentId,
      authorAgentName: agentName,
    });

    const fileCount = files?.length ?? 0;
    const depCount = dependencies.system_packages.length + dependencies.language_packages.length + dependencies.repos.length + dependencies.models_or_assets.length + dependencies.manual_steps.length;
    return `Technique "${technique.name}" saved successfully.\nID: ${technique.id}\nState: ${technique.state}\nDirectory: ${technique.directoryPath}\nVersion: ${technique.version}\nFiles: TECHNIQUE.md + ${fileCount} supporting file(s)\nDependencies declared: ${depCount}${publish ? '\nPublished and available to all agents.' : '\nSaved as draft. Call publish_technique to make it available.'}`;
  } catch (err) {
    if (err instanceof TechniqueValidationError) {
      logger.info('save_technique refused by validator', { agentId }, agentId);
      return err.refusalText;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('save_technique failed', { error: msg }, agentId);
    return `Error saving technique: ${msg}`;
  }
}


export function executeListTechniques(agentId: string, classification: string, args: Record<string, unknown>): string {
  const tag = args.tag as string | undefined;
  const includeDrafts = (args.include_drafts as boolean) && classification === 'sensei';
  const verbose = args.verbose as boolean | undefined;

  // The browse verb lists what this agent may RUN: the same predicate as `use_technique`, so a list never
  // offers what `use_technique` then refuses.
  const techniques = listTechniques({
    tag,
    includeDrafts,
    state: includeDrafts ? undefined : 'published',
  }).filter((t) => mayUseTechnique(agentId, t.id));

  if (techniques.length === 0) {
    return 'No techniques available.' + (includeDrafts ? '' : ' Try include_drafts=true to see drafts (Sensei only).');
  }

  const lines = techniques.map(t => {
    const tags = t.tags.length > 0 ? ` [${t.tags.join(', ')}]` : '';
    const state = t.state !== 'published' ? ` (${t.state})` : '';
    if (verbose) {
      return `- ${t.name} (${t.id}): ${t.description ?? 'No description'}${tags}${state} — used ${t.usageCount} time(s)`;
    }
    // Compact: name, id, tags and non-default state; description and usage count only matter when choosing
    // between options (verbose=true or use_technique gives the full thing).
    return `- ${t.name} (${t.id})${tags}${state}`;
  });

  const header = `Available techniques (${techniques.length}):\n${lines.join('\n')}`;
  if (verbose) return header;
  return `${header}\n\n${compactCountNote(techniques.length)}. For full detail on one: use_technique(name=<id>). For all details on every result: re-call list_techniques with verbose=true.`;
}


export function executePublishTechnique(agentId: string, classification: string, args: Record<string, unknown>): string {
  const refusal = authorizeTechniqueMutation(agentId, classification, 'publish_technique');
  if (refusal) return refusal;

  const name = args.name as string;
  if (!name) return 'Error: name is required.';

  const resolved = resolveTechniqueRef(name);
  if (!resolved.ok) return resolved.error;
  const technique = getTechnique(resolved.id);
  if (!technique) return `Error: Technique "${name}" not found.`;
  if (technique.state === 'published') return `Technique "${technique.name}" is already published.`;

  // The placeholder-completeness check must live here in the executor: the tool-surface strip is advisory
  // (text-mode emission bypasses it), and a still-in-setup technique with literal {{NEEDS_FROM_USER:...}}
  // markers would be fed to other agents as real values. Refuse needs_setup and re-scan the files for unfilled
  // markers (no-op for locally created techniques, which have no import manifest).
  if (technique.state === 'needs_setup') {
    return (
      `Refused: "${technique.name}" is still in setup (needs_setup) and cannot be published. ` +
      `Fill every owner-supplied value with technique_set_placeholder, then call technique_finalize ` +
      `to move it to draft before publishing.`
    );
  }
  const remaining = findRemainingPlaceholders(technique.directoryPath);
  if (remaining.length > 0) {
    return (
      `Refused: "${technique.name}" still has ${remaining.length} unfilled placeholder(s): ${remaining.join(', ')}. ` +
      `Set each with technique_set_placeholder, then call technique_finalize before publishing, ` +
      `so other agents never receive {{NEEDS_FROM_USER}} markers as if they were real values.`
    );
  }

  const published = publishTechnique(resolved.id);
  if (!published) return `Error: Failed to publish technique "${name}".`;

  return `Technique "${published.name}" is now published and available to all agents in the dojo.`;
}


export function executeUpdateTechnique(agentId: string, _agentName: string, classification: string, args: Record<string, unknown>): string {
  const refusal = authorizeTechniqueMutation(agentId, classification, 'update_technique');
  if (refusal) return refusal;

  const name = args.name as string;
  if (!name) return 'Error: name is required.';

  const resolved = resolveTechniqueRef(name);
  if (!resolved.ok) return resolved.error;
  const technique = getTechnique(resolved.id);
  if (!technique) return `Error: Technique "${name}" not found.`;

  const instructions = args.instructions as string | undefined;
  const files = args.files as Array<{ path: string; content: string }> | undefined;
  const displayName = args.display_name as string | undefined;
  const description = args.description as string | undefined;
  const dependencies = args.dependencies as DependencyManifest | undefined;
  const changeSummary = args.change_summary as string || 'Updated by agent';

  const fileTargets = supportingFileTargets(technique.directoryPath, files);
  if (typeof fileTargets === 'string') return `Error: ${fileTargets}`;

  // Metadata-only edits (rename, description) don't bump the version (no TECHNIQUE.md change to
  // snapshot). Apply them first so a combined call leaves the new name AND a fresh snapshot.
  if (displayName !== undefined || description !== undefined) {
    try {
      updateTechnique(resolved.id, {
        ...(displayName !== undefined ? { name: displayName } : {}),
        ...(description !== undefined ? { description } : {}),
      });
    } catch (err) {
      return `Error updating metadata: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Write files FIRST so the validator on the instructions-update sees
  // them on disk. Same ordering as createTechnique.
  for (const file of files ?? []) {
    const filePath = fileTargets.get(file.path)!;
    effectFs.mkdirSync(path.dirname(filePath), { recursive: true });
    effectFs.writeFileSync(filePath, file.content, 'utf-8');
  }

  // Dependencies update is independent of the .md change. If both are
  // provided, write deps first so the .md validator sees the new manifest.
  if (dependencies !== undefined) {
    try {
      updateTechniqueDependencies(resolved.id, dependencies);
    } catch (err) {
      return formatValidationError(err, 'Error updating dependencies');
    }
  }

  if (instructions) {
    try {
      updateTechniqueInstructions(resolved.id, instructions, changeSummary, agentId);
    } catch (err) {
      return formatValidationError(err, 'Error updating instructions');
    }
  }

  const updated = getTechnique(resolved.id);
  return `Technique "${updated?.name}" updated (version ${updated?.version}). ${changeSummary}`;
}

// Import setup: after the Trainer asks the user for a value, this writes it into the technique files in place
// of the {{NEEDS_FROM_USER:LABEL}} marker.

export function executeTechniqueSetPlaceholder(agentId: string, classification: string, args: Record<string, unknown>): string {
  // Executor-side sensei/trainer re-check (the tool-surface strip is advisory), same rule as save/publish.
  const refusal = authorizeTechniqueMutation(agentId, classification, 'technique_set_placeholder');
  if (refusal) return refusal;

  const techniqueRef = args.technique as string;
  const label = args.label as string;
  const value = args.value as string;

  if (!techniqueRef || !label || value === undefined) {
    return 'Error: technique, label, and value are all required.';
  }
  if (typeof value !== 'string') {
    return 'Error: value must be a string.';
  }

  const resolved = resolveTechniqueRef(techniqueRef);
  if (!resolved.ok) return resolved.error;
  const technique = getTechnique(resolved.id);
  if (!technique) return `Error: Technique "${techniqueRef}" not found.`;

  const manifest = readImportManifest(technique.directoryPath);
  if (!manifest) {
    return `Error: Technique "${technique.name}" was not imported and has no placeholders. This tool only applies to techniques that came in via a shared package.`;
  }
  const known = manifest.placeholders.find(p => p.label === label);
  if (!known) {
    const available = manifest.placeholders.map(p => p.label).join(', ') || '(none)';
    return `Error: Placeholder "${label}" is not part of this technique's import manifest. Available labels: ${available}.`;
  }

  const replacements = applyPlaceholderToTechnique(technique.directoryPath, label, value);
  const remaining = findRemainingPlaceholders(technique.directoryPath);
  logger.info('Placeholder applied', { techniqueId: technique.id, label, replacements, remaining: remaining.length }, agentId);

  if (replacements === 0) {
    return `Placeholder "${label}" was already filled in (no remaining markers in the files). Remaining placeholders: ${remaining.length === 0 ? 'none — ready to finalize.' : remaining.join(', ')}.`;
  }
  if (remaining.length === 0) {
    return `Placeholder "${label}" set across ${replacements} location(s). All placeholders are now filled — call technique_finalize to publish this technique as a draft.`;
  }
  return `Placeholder "${label}" set across ${replacements} location(s). Remaining placeholders: ${remaining.join(', ')}.`;
}

// Import setup: once every placeholder is filled, flips the technique from needs_setup to draft and removes
// the staged import manifest.

export function executeTechniqueFinalize(agentId: string, classification: string, args: Record<string, unknown>): string {
  // Executor-side sensei/trainer re-check (the tool-surface strip is advisory).
  const refusal = authorizeTechniqueMutation(agentId, classification, 'technique_finalize');
  if (refusal) return refusal;

  const techniqueRef = args.technique as string;
  if (!techniqueRef) return 'Error: technique is required.';

  const resolved = resolveTechniqueRef(techniqueRef);
  if (!resolved.ok) return resolved.error;
  const technique = getTechnique(resolved.id);
  if (!technique) return `Error: Technique "${techniqueRef}" not found.`;

  const result = finalizeImportedTechnique(resolved.id);
  if (!result.ok) return `Error: ${result.error}`;

  logger.info('Imported technique finalized', { techniqueId: technique.id }, agentId);
  return `Technique "${technique.name}" is finalized and now in draft state. Use publish_technique to make it available to other agents, or test it first via use_technique.`;
}


export function executeSubmitForReview(agentId: string, classification: string, args: Record<string, unknown>): string {
  // Executor-side sensei/trainer re-check (the tool-surface strip is advisory).
  const refusal = authorizeTechniqueMutation(agentId, classification, 'submit_technique_for_review');
  if (refusal) return refusal;

  const name = args.name as string;
  if (!name) return 'Error: name is required.';

  const resolved = resolveTechniqueRef(name);
  if (!resolved.ok) return resolved.error;
  const technique = getTechnique(resolved.id);
  if (!technique) return `Error: Technique "${name}" not found.`;
  if (technique.state !== 'draft') return `Technique "${technique.name}" is not in draft state (current: ${technique.state}).`;

  updateTechnique(resolved.id, { state: 'review' });
  return `Technique "${technique.name}" submitted for Sensei review.`;
}

// technique_read: targeted partial reads instead of slurping the whole technique, because agents avoided
// techniques that use_technique truncated and fell back to compacted memory. Actions: outline (default,
// never truncates), section (capped at SECTION_SOFT_CAP; oversize needs a line range), search (capped,
// ±SEARCH_CONTEXT_LINES per hit), list_files, read_file.

const SECTION_SOFT_CAP = 12000;       // chars per single section read
const READ_FILE_SOFT_CAP = 12000;     // chars per single supporting file read
const SEARCH_CONTEXT_LINES = 4;       // lines of context around each search hit
const SEARCH_MAX_HITS = 30;           // total hits returned per search call

interface SectionEntry {
  level: number;      // 1 = #, 2 = ##, 3 = ###
  title: string;
  startLine: number;  // 1-indexed; the line containing the heading
  endLine: number;    // 1-indexed inclusive; last content line of the section
  charCount: number;
}

function parseSections(content: string): SectionEntry[] {
  const lines = content.split('\n');
  const headings: Array<{ level: number; title: string; line: number }> = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^```/.test(ln)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = ln.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      headings.push({ level: m[1].length, title: m[2].trim(), line: i + 1 });
    }
  }
  const sections: SectionEntry[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const next = headings.find((n, idx) => idx > i && n.level <= h.level);
    const endLine = next ? next.line - 1 : lines.length;
    const sectionText = lines.slice(h.line - 1, endLine).join('\n');
    sections.push({
      level: h.level,
      title: h.title,
      startLine: h.line,
      endLine,
      charCount: sectionText.length,
    });
  }
  return sections;
}

// THE TECHNIQUE DOOR. The agent's GRANT is asked FIRST (`agents.equipped_techniques` is a pre-load list, not an
// allow-list), so a technique the agent may not run is refused for that reason whatever its state; only then
// does the state/squad rule answer.
function checkTechniqueAccess(
  technique: { id: string; state: string; enabled: boolean; buildSquadId: string | null; name: string },
  agentGroupId: string | null,
  agentId: string,
): string | null {
  if (!mayUseTechnique(agentId, technique.id)) {
    return `Error: Technique "${technique.name}" is not in this agent's technique grants. The request was not performed. Ask the primary agent to grant it if this needs to happen.`;
  }
  if (technique.state === 'published' && technique.enabled) return null;
  if ((technique.state === 'draft' || technique.state === 'review') && technique.buildSquadId === agentGroupId) return null;
  return `Error: Technique "${technique.name}" is not available (state: ${technique.state}). Only published techniques can be read by agents outside the build squad.`;
}

function formatOutline(technique: { name: string; directoryPath: string; description: string | null; files: Array<{ path: string; size: number; isDirectory: boolean }>; instructions: string | null }): string {
  const md = technique.instructions ?? '';
  const totalChars = md.length;
  const totalLines = md.split('\n').length;
  const sections = parseSections(md);
  const supporting = technique.files.filter((f) => !f.isDirectory && f.path !== 'TECHNIQUE.md');

  const parts: string[] = [];
  parts.push(`=== Outline: ${technique.name} ===`);
  if (technique.description) parts.push(technique.description);
  parts.push('');
  parts.push(`TECHNIQUE.md: ${totalChars.toLocaleString()} chars, ${totalLines.toLocaleString()} lines, ${sections.length} sections`);
  parts.push('');
  parts.push('Sections (call technique_read action="section" section_name="<title>" or lines="start-end"):');
  if (sections.length === 0) {
    parts.push('  (no headings detected)');
  } else {
    for (const s of sections) {
      const indent = '  '.repeat(s.level - 1);
      const oversize = s.charCount > SECTION_SOFT_CAP ? ' ⚠ large' : '';
      parts.push(`${indent}- L${s.startLine}-${s.endLine} [${s.charCount.toLocaleString()} chars]${oversize} ${s.title}`);
    }
  }
  parts.push('');
  if (supporting.length > 0) {
    parts.push(`Supporting files (${supporting.length}) — call technique_read action="read_file" file="<path>":`);
    for (const f of supporting) {
      parts.push(`  - ${f.path} (${f.size.toLocaleString()} bytes)`);
    }
  } else {
    parts.push('Supporting files: none.');
  }
  parts.push('');
  parts.push('Next: read only the sections you need. For lookups across the whole technique use action="search".');
  parts.push(`=== End Outline ===`);
  return parts.join('\n');
}

function formatSection(technique: { name: string; instructions: string | null }, args: Record<string, unknown>): string {
  const md = technique.instructions ?? '';
  const lines = md.split('\n');
  const sectionName = args.section_name as string | undefined;
  const lineRange = args.lines as string | undefined;

  let startLine: number;
  let endLine: number;
  let label: string;

  if (sectionName) {
    const sections = parseSections(md);
    const needle = sectionName.toLowerCase();
    const match = sections.find((s) => s.title.toLowerCase() === needle)
      ?? sections.find((s) => s.title.toLowerCase().includes(needle));
    if (!match) {
      const available = sections.map((s) => `"${s.title}"`).join(', ') || '(none)';
      // Point at alternative actions so the agent stays inside the technique_read family instead of bailing to exec.
      return (
        `Error: section "${sectionName}" not found in "${technique.name}".\n` +
        `Available sections: ${available}.\n\n` +
        `Try one of:\n` +
        `  • technique_read(name="${technique.name}", action="search", query="${sectionName.toLowerCase()}") — greps TECHNIQUE.md + supporting files for that term\n` +
        `  • technique_read(name="${technique.name}", action="section", section_name="<one of the available titles above>")\n` +
        `  • technique_read(name="${technique.name}", action="outline") — full structure if the list above isn't enough\n\n` +
        `Do NOT fall back to memory or exec the technique directory — the on-disk file is the source of truth and the actions above will reach it.`
      );
    }
    startLine = match.startLine;
    endLine = match.endLine;
    label = `"${match.title}" (L${startLine}-${endLine})`;
  } else if (lineRange) {
    const m = lineRange.match(/^(\d+)-(\d+)$/);
    if (!m) return `Error: lines must be "start-end" (e.g. "1-200"). Got: "${lineRange}".`;
    startLine = Math.max(1, parseInt(m[1], 10));
    endLine = Math.min(lines.length, parseInt(m[2], 10));
    if (endLine < startLine) return `Error: end line ${endLine} is before start line ${startLine}.`;
    label = `L${startLine}-${endLine}`;
  } else {
    return 'Error: provide either section_name="<title>" or lines="start-end". Use action="outline" to see options.';
  }

  const slice = lines.slice(startLine - 1, endLine).join('\n');
  if (slice.length > SECTION_SOFT_CAP) {
    const midpoint = startLine + Math.floor((endLine - startLine) / 2);
    return `Error: Section ${label} is ${slice.length.toLocaleString()} chars — too large for a single read (cap: ${SECTION_SOFT_CAP.toLocaleString()}). Page through with explicit line ranges, e.g. lines="${startLine}-${midpoint}" then lines="${midpoint + 1}-${endLine}". Or narrow with action="search" query="<term>".`;
  }
  const numbered = lines.slice(startLine - 1, endLine)
    .map((ln, idx) => `${String(startLine + idx).padStart(5, ' ')}  ${ln}`)
    .join('\n');
  return `=== ${technique.name} ${label} ===\n${numbered}\n=== End Section ===`;
}

function formatSearch(technique: { name: string; directoryPath: string; instructions: string | null }, args: Record<string, unknown>): string {
  const query = args.query as string | undefined;
  if (!query || query.trim().length === 0) return 'Error: query is required for action="search".';
  const includeFiles = args.include_files !== false;
  const needle = query.toLowerCase();

  interface Hit { file: string; lineNumber: number; contextLines: string[]; contextStart: number }
  const hits: Hit[] = [];

  const searchOne = (filePath: string, contents: string) => {
    const lines = contents.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= SEARCH_MAX_HITS) return;
      if (lines[i].toLowerCase().includes(needle)) {
        const start = Math.max(0, i - SEARCH_CONTEXT_LINES);
        const end = Math.min(lines.length, i + SEARCH_CONTEXT_LINES + 1);
        hits.push({
          file: filePath,
          lineNumber: i + 1,
          contextLines: lines.slice(start, end),
          contextStart: start + 1,
        });
      }
    }
  };

  searchOne('TECHNIQUE.md', technique.instructions ?? '');

  if (includeFiles && hits.length < SEARCH_MAX_HITS) {
    try {
      const dir = technique.directoryPath;
      const walk = (subdir: string) => {
        const entries = effectFs.readdirSync(path.join(dir, subdir), { withFileTypes: true });
        for (const entry of entries) {
          if (hits.length >= SEARCH_MAX_HITS) return;
          const rel = subdir ? path.join(subdir, entry.name) : entry.name;
          if (entry.isDirectory()) {
            // The technique's own snapshots only live at the top level; a deeper
            // folder the author named `versions` is theirs and stays searchable.
            if ((subdir === '' && entry.name === VERSIONS_SUBDIR) || entry.name === 'node_modules') continue;
            walk(rel);
          } else if (entry.isFile() && entry.name !== 'TECHNIQUE.md' && entry.name !== 'metadata.json') {
            try {
              const buf = effectFs.readFileSync(path.join(dir, rel));
              // Skip binary files (best-effort heuristic)
              if (buf.includes(0)) continue;
              searchOne(rel, buf.toString('utf-8'));
            } catch { /* unreadable file: skip */ }
          }
        }
      };
      walk('');
    } catch (err) {
      logger.warn('technique_read search: walk failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (hits.length === 0) {
    return `No matches for "${query}" in "${technique.name}". Tried TECHNIQUE.md${includeFiles ? ' and all supporting files' : ''}.`;
  }

  const parts: string[] = [];
  parts.push(`=== Search "${query}" in ${technique.name} — ${hits.length} hit${hits.length === 1 ? '' : 's'}${hits.length >= SEARCH_MAX_HITS ? ' (capped — narrow your query for more)' : ''} ===`);
  for (const h of hits) {
    parts.push('');
    parts.push(`[${h.file}:L${h.lineNumber}]`);
    h.contextLines.forEach((ln, idx) => {
      const lineNo = h.contextStart + idx;
      const marker = lineNo === h.lineNumber ? '>' : ' ';
      parts.push(`${marker} ${String(lineNo).padStart(5, ' ')}  ${ln}`);
    });
  }
  parts.push('');
  parts.push(`=== End Search ===`);
  return parts.join('\n');
}

function formatListFiles(technique: { name: string; files: Array<{ path: string; size: number; isDirectory: boolean }> }): string {
  const supporting = technique.files.filter((f) => !f.isDirectory && f.path !== 'TECHNIQUE.md' && f.path !== 'metadata.json');
  if (supporting.length === 0) return `Technique "${technique.name}" has no supporting files (only TECHNIQUE.md).`;
  const parts: string[] = [];
  parts.push(`Supporting files in "${technique.name}" (${supporting.length}):`);
  for (const f of supporting) {
    parts.push(`  - ${f.path} (${f.size.toLocaleString()} bytes)`);
  }
  parts.push('');
  parts.push('Read one with action="read_file" file="<path>".');
  return parts.join('\n');
}

function formatReadFile(technique: { name: string; directoryPath: string }, args: Record<string, unknown>): string {
  const file = args.file as string | undefined;
  if (!file) return 'Error: file is required for action="read_file" (use action="list_files" to see available files).';
  // The Mac belongs to the agent: an absolute or climbing name reads where it says.
  const normalized = path.normalize(file);
  const full = path.resolve(technique.directoryPath, normalized);
  if (!effectFs.existsSync(full)) {
    return `Error: file "${normalized}" not found in "${technique.name}". Use action="list_files" to see available files.`;
  }
  let contents: string;
  try {
    contents = effectFs.readFileSync(full, 'utf-8');
  } catch (err) {
    return `Error reading "${normalized}": ${err instanceof Error ? err.message : String(err)}.`;
  }
  const lines = contents.split('\n');
  const lineRange = args.lines as string | undefined;
  let startLine = 1;
  let endLine = lines.length;
  if (lineRange) {
    const m = lineRange.match(/^(\d+)-(\d+)$/);
    if (!m) return `Error: lines must be "start-end" (e.g. "1-200"). Got: "${lineRange}".`;
    startLine = Math.max(1, parseInt(m[1], 10));
    endLine = Math.min(lines.length, parseInt(m[2], 10));
  }
  const slice = lines.slice(startLine - 1, endLine).join('\n');
  if (slice.length > READ_FILE_SOFT_CAP) {
    const midpoint = startLine + Math.floor((endLine - startLine) / 2);
    return `Error: ${normalized} L${startLine}-${endLine} is ${slice.length.toLocaleString()} chars — too large for a single read (cap: ${READ_FILE_SOFT_CAP.toLocaleString()}). Page through, e.g. lines="${startLine}-${midpoint}" then lines="${midpoint + 1}-${endLine}".`;
  }
  const numbered = lines.slice(startLine - 1, endLine)
    .map((ln, idx) => `${String(startLine + idx).padStart(5, ' ')}  ${ln}`)
    .join('\n');
  return `=== ${technique.name}/${normalized} L${startLine}-${endLine} ===\n${numbered}\n=== End File ===`;
}

export function executeTechniqueRead(
  agentId: string,
  agentName: string,
  agentGroupId: string | null,
  args: Record<string, unknown>,
): string {
  const name = args.name as string | undefined;
  if (!name) return 'Error: name (technique slug/id/display name) is required.';
  const action = (args.action as string | undefined) ?? 'outline';

  const resolved = resolveTechniqueRef(name);
  if (!resolved.ok) return resolved.error;
  const technique = getTechniqueDetail(resolved.id);
  if (!technique) return `Error: Technique "${name}" not found.`;

  const accessErr = checkTechniqueAccess(technique, agentGroupId, agentId);
  if (accessErr) return accessErr;

  // Outline doesn't count as "usage" (it's introspection). Section/search/read_file
  // do (the agent is actually consuming the technique's content).
  if (action !== 'outline' && action !== 'list_files') {
    try { recordTechniqueUsage(technique.id, agentId, agentName); } catch { /* best effort */ }
  }

  let body: string;
  switch (action) {
    case 'outline':    body = formatOutline(technique); break;
    case 'section':    body = formatSection(technique, args); break;
    case 'search':     body = formatSearch(technique, args); break;
    case 'list_files': body = formatListFiles(technique); break;
    case 'read_file':  body = formatReadFile(technique, args); break;
    default:
      // Don't wrap error responses: the sentinel only attaches to real
      // technique content so the stubber doesn't trip on a bad-action
      // refusal message.
      return `Error: unknown action "${action}". Valid actions: outline, section, search, list_files, read_file.`;
  }
  return wrapTechniqueResult(technique.name, body);
}

// Acknowledges a technique read. The runtime owns the pendingTechniqueAck state (agents.config); this executor
// only validates the payload (the summary must show the agent engaged), and the runtime clears the state on success.
const TECHNIQUE_ACK_MIN_SUMMARY_CHARS = 100;

export function executeTechniqueAcknowledge(
  agentId: string,
  pendingAck: { techniqueId: string; techniqueName: string } | null,
  args: Record<string, unknown>,
): { ok: true; content: string; clearedAck: true } | { ok: false; content: string } {
  const name = typeof args.name === 'string' ? args.name : undefined;
  const summary = typeof args.summary === 'string' ? args.summary : undefined;

  if (!name) {
    return { ok: false, content: 'Error: name (technique slug/id) is required.' };
  }
  // Acking is optional and the turn loop tracks the pending state (v2/loop.ts); this executor is dispatched
  // without turn state, so pendingAck can be null even right after a read. That is a friendly no-op success,
  // not an error. The paraphrase-length check only applies when a genuine pending ack is being cleared.
  if (!pendingAck) {
    return {
      ok: true,
      clearedAck: true,
      content:
        `Noted. Acknowledging a technique is optional; nothing was pending to clear, so go ahead and apply "${name}".`,
    };
  }
  if (!summary || summary.trim().length < TECHNIQUE_ACK_MIN_SUMMARY_CHARS) {
    return {
      ok: false,
      content:
        `Error: summary must be at least ${TECHNIQUE_ACK_MIN_SUMMARY_CHARS} characters. ` +
        `The acknowledgement is what shows you processed what you read instead of skipping past it. ` +
        `Briefly paraphrase the technique's key steps in your own words (no need to be exhaustive, just enough to show you engaged). ` +
        `Current summary length: ${(summary?.trim().length ?? 0)} chars.`,
    };
  }
  // Match by slug (techniqueId) or display name (techniqueName). LLMs
  // sometimes get the form wrong; accept either.
  const matches = (
    name === pendingAck.techniqueId ||
    name.toLowerCase() === pendingAck.techniqueName.toLowerCase()
  );
  if (!matches) {
    return {
      ok: false,
      content:
        `Error: pending acknowledgement is for technique "${pendingAck.techniqueName}" (${pendingAck.techniqueId}), not "${name}". ` +
        `Call technique_acknowledge(name="${pendingAck.techniqueId}", summary=...) to clear the current gate, ` +
        `or re-read the technique you actually want to work with via technique_read.`,
    };
  }
  logger.info('Technique acknowledgement accepted', {
    techniqueId: pendingAck.techniqueId,
    summaryChars: summary.trim().length,
  }, agentId);
  return {
    ok: true,
    clearedAck: true,
    content:
      `Acknowledgement accepted for "${pendingAck.techniqueName}" (${pendingAck.techniqueId}). ` +
      `Acknowledging after a technique read is optional; it records that you engaged with the material before applying it.`,
  };
}
