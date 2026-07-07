// ════════════════════════════════════════
// Technique Agent Tools
// ════════════════════════════════════════

import fs from 'node:fs';
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
} from './share-import.js';
import {
  type DependencyManifest,
  emptyDependencyManifest,
} from './dependencies.js';
import { getTrainerAgentId, getTrainerAgentName, isTrainerAgent, isTrainerEnabled } from '../config/platform.js';
// (getDb is already imported above)

const logger = createLogger('technique-tools');

/**
 * Authorization check for technique-mutating tools (save/update/publish/
 * delete). Returns null when the caller is allowed, or a refusal string
 * when they aren't.
 *
 * Policy:
 *   - The trainer agent is always allowed.
 *   - If the trainer is disabled in config OR the configured trainer
 *     agent doesn't exist / has been terminated, fall back to allowing
 *     any sensei-class caller. Without this fallback, installs that
 *     disabled the trainer (or never set one up) would have ALL
 *     technique mutation refused — bricking the feature.
 *   - Otherwise, refuse with a redirect to the trainer.
 */
function authorizeTechniqueMutation(agentId: string, classification: string, verb: string): string | null {
  if (isTrainerAgent(agentId)) return null;

  // Fallback: trainer disabled per install config, OR no live trainer
  // agent exists. Allow sensei-class callers (mirrors the pre-trainer-
  // ownership behavior so the feature still works on a trainer-less
  // install).
  if (!isTrainerEnabled()) {
    if (classification === 'sensei') return null;
    return `Refused: ${verb} is restricted to Sensei agents (the trainer is disabled on this install).`;
  }
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
    // DB hiccup — be permissive rather than block legitimate work.
    if (classification === 'sensei') return null;
  }

  const trainerName = getTrainerAgentName();
  return (
    `Refused: ${verb} is reserved for the trainer agent (${trainerName}). ` +
    `Techniques are owned by ${trainerName} so that support files, dependency manifests, and file-reference integrity all stay in one place — when techniques get shared, that ownership is what makes the package portable. ` +
    `Send a message to ${trainerName} describing what you want built (include any custom scripts/files in the message body or via shared-files), and they'll create / edit the technique on your behalf.`
  );
}

// ── Technique freshness enforcement (v2.7.4, banner shortened v2.7.6) ──
//
// Single source of truth for the "this is a technique tool result"
// sentinel. Every technique_read / use_technique response gets this
// banner prepended. Four consumers downstream:
//
//   1. The assembler's stubOldToolResults() — looks for this sentinel
//      and stubs the matching tool_result blocks after just 1 turn
//      (vs 12 for normal tool results), so the agent literally cannot
//      reference a prior read on the next turn.
//   2. vault_remember — refuses to store any entry whose content
//      contains this sentinel.
//   3. scratchpad_set — refuses to write technique content into
//      scratchpad (added v2.7.6).
//   4. Compaction — replaces sentinel-wrapped blocks with a stub
//      BEFORE summarizing, so technique content doesn't leak into
//      summaries the model later reads as authoritative (added v2.7.6).
//
// v2.7.6 — banner shortened. The v2.7.4 banner spelled out the
// enforcement policy in every response ("prior reads get stubbed",
// "do not reference cached memory", etc.), which made the agent
// second-guess whether the fresh response it was looking at was
// actually fresh, and bail to exec/memory instead of trusting the
// content. The policy now lives ONLY in the tool descriptions
// (system prompt level); each result just identifies itself.
//
// Don't change the sentinel string without grepping for every consumer.
export const TECHNIQUE_FRESH_SENTINEL = '══ TECHNIQUE FRESH READ ══';

function wrapTechniqueResult(techniqueName: string, body: string): string {
  return (
    `${TECHNIQUE_FRESH_SENTINEL} ${techniqueName} (${new Date().toISOString()})\n` +
    `${body}`
  );
}

// Convert the structured TechniqueValidationError into something the
// calling agent sees as a refusal rather than a generic platform error.
function formatValidationError(err: unknown, fallbackPrefix: string): string {
  if (err instanceof TechniqueValidationError) return err.refusalText;
  const msg = err instanceof Error ? err.message : String(err);
  return `${fallbackPrefix}: ${msg}`;
}

// ── save_technique ──

export function executeSaveTechnique(agentId: string, agentName: string, classification: string, args: Record<string, unknown>): string {
  const refusal = authorizeTechniqueMutation(agentId, classification, 'save_technique');
  if (refusal) return refusal;

  const name = args.name as string;
  const displayName = args.display_name as string;
  const description = args.description as string;
  const instructions = args.instructions as string;
  const tags = (args.tags as string[]) ?? [];
  const files = args.files as Array<{ path: string; content: string }> | undefined;
  // Partial-manifest tolerance: LLMs routinely send `{ system_packages: [] }`
  // and omit the rest. Pre-fix, the cast-and-fallback kept the partial as-is
  // and the validator (`dependencies.ts:279` iterating `manifest.repos`)
  // crashed with `TypeError: repos is not iterable`. Deep-merge into a fresh
  // empty manifest so every bucket is guaranteed to be an array.
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

// ── use_technique ──

export function executeUseTechnique(agentId: string, agentName: string, agentGroupId: string | null, args: Record<string, unknown>): string {
  const name = args.name as string;
  if (!name) return 'Error: name is required.';

  const resolved = resolveTechniqueRef(name);
  if (!resolved.ok) return resolved.error;
  const db = getDb();
  const technique = getTechniqueDetail(resolved.id);
  if (!technique) return `Error: Technique "${name}" not found.`;

  // Check access
  if (technique.state === 'published' && technique.enabled) {
    // Everyone can use published techniques
  } else if ((technique.state === 'draft' || technique.state === 'review') && technique.buildSquadId === agentGroupId) {
    // Squad members can access draft/review techniques
  } else {
    return `Error: Technique "${name}" is not available (state: ${technique.state}). Only published techniques can be used.`;
  }

  // Log usage
  recordTechniqueUsage(technique.id, agentId, agentName);

  // Build response with full instructions
  const parts: string[] = [
    `=== Technique: ${technique.name} ===`,
    technique.description ?? '',
    '',
    technique.instructions ?? '(No instructions found)',
  ];

  // List supporting files
  const supportingFiles = technique.files.filter(f => !f.isDirectory && f.path !== 'TECHNIQUE.md');
  if (supportingFiles.length > 0) {
    parts.push('');
    parts.push('Supporting files in this technique:');
    for (const f of supportingFiles) {
      parts.push(`- ${f.path} (${f.size} bytes) — at ${technique.directoryPath}/${f.path}`);
    }
  }

  parts.push(`=== End Technique ===`);

  logger.info('Technique used', { techniqueId: technique.id, agentId }, agentId);
  return wrapTechniqueResult(technique.name, parts.join('\n'));
}

// ── list_techniques ──

export function executeListTechniques(agentId: string, classification: string, args: Record<string, unknown>): string {
  const tag = args.tag as string | undefined;
  const includeDrafts = (args.include_drafts as boolean) && classification === 'sensei';
  const verbose = args.verbose as boolean | undefined;

  const techniques = listTechniques({
    tag,
    includeDrafts,
    state: includeDrafts ? undefined : 'published',
  });

  if (techniques.length === 0) {
    return 'No techniques available.' + (includeDrafts ? '' : ' Try include_drafts=true to see drafts (Sensei only).');
  }

  const lines = techniques.map(t => {
    const tags = t.tags.length > 0 ? ` [${t.tags.join(', ')}]` : '';
    const state = t.state !== 'published' ? ` (${t.state})` : '';
    if (verbose) {
      return `- ${t.name} (${t.id}): ${t.description ?? 'No description'}${tags}${state} — used ${t.usageCount} time(s)`;
    }
    // Compact: name + id + tags + non-default state. Drop description and
    // usage count — they're only useful when picking between options, and
    // the caller can verbose=true or use_technique to get the full thing.
    return `- ${t.name} (${t.id})${tags}${state}`;
  });

  const header = `Available techniques (${techniques.length}):\n${lines.join('\n')}`;
  if (verbose) return header;
  return `${header}\n\n${techniques.length} result${techniques.length === 1 ? '' : 's'} shown (compact). For full detail on one: use_technique(name=<id>). For all details on every result: re-call list_techniques with verbose=true.`;
}

// ── publish_technique ──

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

  // FA-TS3: the placeholder-completeness invariant lived ONLY in
  // finalizeImportedTechnique. A floor model that skips finalize can publish a
  // still-in-setup technique carrying literal {{NEEDS_FROM_USER:...}} markers,
  // which use_technique then feeds to other agents as if they were real values.
  // The TOOL-SURFACE strip is advisory (text-mode emission bypasses it), so the
  // gate has to live here in the executor. Refuse a needs_setup technique, and
  // belt-and-suspenders re-scan the files for unfilled markers (no-op for
  // locally-created techniques, which have no import manifest).
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

// ── update_technique ──

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

  // Metadata-only edits (rename, description) don't bump the version
  // because there's no TECHNIQUE.md change to snapshot. Apply them first
  // so a combined call (rename + new instructions) leaves the technique
  // with the new name AND a fresh version snapshot.
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
  if (files) {
    for (const file of files) {
      const filePath = path.join(technique.directoryPath, file.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }
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

// ── technique_set_placeholder ──
// Used during import setup. After Yoshi asks the user for a secret/value,
// he calls this to write it into the technique files in place of the
// {{NEEDS_FROM_USER:LABEL}} marker.

export function executeTechniqueSetPlaceholder(agentId: string, classification: string, args: Record<string, unknown>): string {
  // FA-TS7: the sensei/trainer gate was only ever enforced by the tool-surface
  // strip, which text-mode emission bypasses. Re-check in the executor, same
  // ownership rule and corrective surface as save/publish.
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

// ── technique_finalize ──
// Used during import setup. Once every placeholder is filled Yoshi calls
// this to flip the technique out of needs_setup into draft state and
// remove the staged import manifest.

export function executeTechniqueFinalize(agentId: string, classification: string, args: Record<string, unknown>): string {
  // FA-TS7: executor-side sensei/trainer re-check (surface strip is advisory).
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

// ── submit_technique_for_review ──

export function executeSubmitForReview(agentId: string, classification: string, args: Record<string, unknown>): string {
  // FA-TS7: executor-side sensei/trainer re-check (surface strip is advisory).
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

// ════════════════════════════════════════
// technique_read (v2.5.44)
//
// Replaces the slurp-the-whole-technique pattern of use_technique with
// targeted, partial reads. Agents were avoiding techniques entirely
// because (a) use_technique truncated big ones and (b) there was no way
// to read just the part they needed — so they fell back to memory, which
// is compacted and often wrong. This tool fixes both.
//
// Five actions: outline (default), section, search, list_files, read_file.
// Outline never truncates — only headings + ranges + sizes. Section caps
// at SECTION_SOFT_CAP chars; oversize sections require an explicit line
// range. Search returns ±SEARCH_CONTEXT_LINES of context per hit, capped.
// ════════════════════════════════════════

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

function checkTechniqueAccess(
  technique: { state: string; enabled: boolean; buildSquadId: string | null; name: string },
  agentGroupId: string | null,
): string | null {
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
      // The agent that hit this error in v2.7.5 testing bailed straight
      // to exec/memory instead of trying a different action. The new
      // text walks them through the alternatives explicitly so they
      // stay inside the technique_read tool family.
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
        const entries = fs.readdirSync(path.join(dir, subdir), { withFileTypes: true });
        for (const entry of entries) {
          if (hits.length >= SEARCH_MAX_HITS) return;
          const rel = subdir ? path.join(subdir, entry.name) : entry.name;
          if (entry.isDirectory()) {
            if (entry.name === '.versions' || entry.name === 'node_modules') continue;
            walk(rel);
          } else if (entry.isFile() && entry.name !== 'TECHNIQUE.md' && entry.name !== 'metadata.json') {
            try {
              const buf = fs.readFileSync(path.join(dir, rel));
              // Skip binary files (best-effort heuristic)
              if (buf.includes(0)) continue;
              searchOne(rel, buf.toString('utf-8'));
            } catch { /* unreadable file — skip */ }
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
  // Prevent path traversal
  const normalized = path.normalize(file).replace(/^(\.\.[\\/])+/, '');
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return `Error: file must be a relative path within the technique directory.`;
  }
  const full = path.join(technique.directoryPath, normalized);
  if (!full.startsWith(technique.directoryPath)) {
    return `Error: file path escapes the technique directory.`;
  }
  if (!fs.existsSync(full)) {
    return `Error: file "${normalized}" not found in "${technique.name}". Use action="list_files" to see available files.`;
  }
  let contents: string;
  try {
    contents = fs.readFileSync(full, 'utf-8');
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

  const accessErr = checkTechniqueAccess(technique, agentGroupId);
  if (accessErr) return accessErr;

  // Outline doesn't count as "usage" — it's introspection. Section/search/read_file
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
      // Don't wrap error responses — the sentinel only attaches to real
      // technique content so the stubber doesn't trip on a bad-action
      // refusal message.
      return `Error: unknown action "${action}". Valid actions: outline, section, search, list_files, read_file.`;
  }
  return wrapTechniqueResult(technique.name, body);
}

// ── technique_acknowledge ──
//
// Clears the engine's pendingTechniqueAck gate. Required after any
// successful technique_read / use_technique call before the agent can
// run any other (non-allowlisted) tool. The summary parameter forces
// the agent to write SOMETHING in their own words about the technique
// — engagement, not just reading. The runtime owns the actual gate
// state (in agents.config.pendingTechniqueAck); this executor just
// validates the ack payload and returns success/refusal. The runtime
// clears the persisted state when this returns success.
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
  // D6 removed the hard acknowledgement GATE; acking is now an OPTIONAL affordance
  // and the turn loop tracks the pending state itself (v2/loop.ts). This executor
  // is dispatched from executeTool, which has no turn state, so it can legitimately
  // see pendingAck=null even right after a read. Erroring in that case (the old
  // "no pending acknowledgement on file" wall) broke every technique flow, because
  // the tool descriptions still nudge the model to acknowledge. Treat a missing or
  // unmatched pending as a friendly no-op success: there is nothing to gate, so the
  // agent should just keep working. We only enforce the paraphrase-length nudge when
  // there is a genuine pending ack to clear.
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
