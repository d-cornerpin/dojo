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
  publishTechnique,
  recordTechniqueUsage,
  resolveTechniqueRef,
} from './store.js';
import {
  readImportManifest,
  applyPlaceholderToTechnique,
  findRemainingPlaceholders,
  finalizeImportedTechnique,
} from './share-import.js';

const logger = createLogger('technique-tools');

// ── save_technique ──

export function executeSaveTechnique(agentId: string, agentName: string, classification: string, args: Record<string, unknown>): string {
  if (classification !== 'sensei') {
    return 'Only Sensei agents can create techniques. Ronin and Apprentice agents can use existing techniques with use_technique.';
  }

  const name = args.name as string;
  const displayName = args.display_name as string;
  const description = args.description as string;
  const instructions = args.instructions as string;
  const tags = (args.tags as string[]) ?? [];
  const files = args.files as Array<{ path: string; content: string }> | undefined;
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
      publish,
      authorAgentId: agentId,
      authorAgentName: agentName,
    });

    const fileCount = files?.length ?? 0;
    return `Technique "${technique.name}" saved successfully.\nID: ${technique.id}\nState: ${technique.state}\nDirectory: ${technique.directoryPath}\nVersion: ${technique.version}\nFiles: TECHNIQUE.md + ${fileCount} supporting file(s)${publish ? '\nPublished and available to all agents.' : '\nSaved as draft. Call publish_technique to make it available.'}`;
  } catch (err) {
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
  return parts.join('\n');
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
  if (classification !== 'sensei') {
    return 'Only Sensei agents can publish techniques.';
  }

  const name = args.name as string;
  if (!name) return 'Error: name is required.';

  const resolved = resolveTechniqueRef(name);
  if (!resolved.ok) return resolved.error;
  const technique = getTechnique(resolved.id);
  if (!technique) return `Error: Technique "${name}" not found.`;
  if (technique.state === 'published') return `Technique "${technique.name}" is already published.`;

  const published = publishTechnique(resolved.id);
  if (!published) return `Error: Failed to publish technique "${name}".`;

  return `Technique "${published.name}" is now published and available to all agents in the dojo.`;
}

// ── update_technique ──

export function executeUpdateTechnique(agentId: string, agentName: string, classification: string, args: Record<string, unknown>): string {
  if (classification !== 'sensei') {
    return 'Only Sensei agents can update techniques.';
  }

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

  if (instructions) {
    updateTechniqueInstructions(resolved.id, instructions, changeSummary, agentId);
  }

  if (files) {
    for (const file of files) {
      const filePath = path.join(technique.directoryPath, file.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }
  }

  const updated = getTechnique(resolved.id);
  return `Technique "${updated?.name}" updated (version ${updated?.version}). ${changeSummary}`;
}

// ── technique_set_placeholder ──
// Used during import setup. After Yoshi asks the user for a secret/value,
// he calls this to write it into the technique files in place of the
// {{NEEDS_FROM_USER:LABEL}} marker.

export function executeTechniqueSetPlaceholder(agentId: string, args: Record<string, unknown>): string {
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

export function executeTechniqueFinalize(agentId: string, args: Record<string, unknown>): string {
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

export function executeSubmitForReview(agentId: string, args: Record<string, unknown>): string {
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
