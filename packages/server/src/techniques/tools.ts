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
      return `Error: Section "${sectionName}" not found in "${technique.name}". Available: ${available}. Use action="outline" to see the full structure.`;
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

  switch (action) {
    case 'outline': return formatOutline(technique);
    case 'section': return formatSection(technique, args);
    case 'search': return formatSearch(technique, args);
    case 'list_files': return formatListFiles(technique);
    case 'read_file': return formatReadFile(technique, args);
    default:
      return `Error: unknown action "${action}". Valid actions: outline, section, search, list_files, read_file.`;
  }
}
