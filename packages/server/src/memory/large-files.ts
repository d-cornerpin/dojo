import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { estimateTokens } from './store.js';

const logger = createLogger('memory-large-files');

const LARGE_FILE_TOKEN_THRESHOLD = 25000;
const FILES_BASE_DIR = path.join(os.homedir(), '.dojo', 'data', 'files');

// ── Interception Check ──

export function shouldIntercept(content: string): boolean {
  return estimateTokens(content) > LARGE_FILE_TOKEN_THRESHOLD;
}

// ── File Extension Detection ──

function detectExtension(originalPath?: string): string {
  if (originalPath) {
    const ext = path.extname(originalPath);
    if (ext) return ext;
  }
  return '.txt';
}

function detectFileType(content: string, filePath?: string): string {
  const ext = filePath ? path.extname(filePath).toLowerCase() : '';

  const codeExtensions = ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.rb', '.swift', '.kt'];
  if (codeExtensions.includes(ext)) return 'code';
  if (ext === '.json') return 'json';
  if (ext === '.csv' || ext === '.tsv') return 'csv';

  // Auto-detect from content
  try {
    JSON.parse(content);
    return 'json';
  } catch {
    // not JSON
  }

  if (content.includes('function ') || content.includes('import ') || content.includes('class ') || content.includes('const ') || content.includes('def ')) {
    return 'code';
  }

  return 'text';
}

// ── Exploration Summary Generation (Deterministic, No LLM) ──

export function generateExplorationSummary(content: string, filePath?: string): string {
  const fileType = detectFileType(content, filePath);
  const totalTokens = estimateTokens(content);
  const lines = content.split('\n');

  const header = `[Large file: ${filePath ?? 'unknown'} | ${totalTokens} tokens | ${lines.length} lines]`;

  switch (fileType) {
    case 'code':
      return generateCodeSummary(content, lines, header);
    case 'json':
      return generateJsonSummary(content, header);
    case 'csv':
      return generateCsvSummary(content, lines, header);
    default:
      return generateTextSummary(content, header);
  }
}

function generateCodeSummary(content: string, lines: string[], header: string): string {
  const parts: string[] = [header, ''];

  // Extract imports
  const imports = lines
    .filter(l => /^\s*(import |from |require\(|use |#include)/.test(l))
    .slice(0, 20);
  if (imports.length > 0) {
    parts.push('Imports:');
    for (const imp of imports) {
      parts.push(`  ${imp.trim()}`);
    }
    parts.push('');
  }

  // Extract function/class/interface definitions
  const definitions: string[] = [];
  const defPatterns = [
    /^\s*(export\s+)?(async\s+)?function\s+(\w+)/,
    /^\s*(export\s+)?class\s+(\w+)/,
    /^\s*(export\s+)?interface\s+(\w+)/,
    /^\s*(export\s+)?type\s+(\w+)/,
    /^\s*(export\s+)?const\s+(\w+)\s*=/,
    /^\s*def\s+(\w+)/,
    /^\s*fn\s+(\w+)/,
    /^\s*func\s+(\w+)/,
    /^\s*(pub\s+)?struct\s+(\w+)/,
    /^\s*(pub\s+)?enum\s+(\w+)/,
  ];

  for (const line of lines) {
    for (const pattern of defPatterns) {
      if (pattern.test(line)) {
        definitions.push(line.trim());
        break;
      }
    }
  }

  if (definitions.length > 0) {
    parts.push(`Definitions (${definitions.length} found):`);
    for (const def of definitions.slice(0, 30)) {
      parts.push(`  ${def}`);
    }
    if (definitions.length > 30) {
      parts.push(`  ... and ${definitions.length - 30} more`);
    }
    parts.push('');
  }

  // Show first 10 lines
  parts.push('First 10 lines:');
  for (const line of lines.slice(0, 10)) {
    parts.push(`  ${line}`);
  }

  return parts.join('\n');
}

function generateJsonSummary(content: string, header: string): string {
  const parts: string[] = [header, ''];

  try {
    const parsed = JSON.parse(content);

    if (Array.isArray(parsed)) {
      parts.push(`Type: Array with ${parsed.length} entries`);

      if (parsed.length > 0) {
        const firstType = typeof parsed[0];
        parts.push(`Element type: ${firstType}`);

        if (firstType === 'object' && parsed[0] !== null) {
          parts.push(`Keys: ${Object.keys(parsed[0]).join(', ')}`);
        }

        parts.push('');
        parts.push('First 5 entries:');
        for (const entry of parsed.slice(0, 5)) {
          parts.push(`  ${JSON.stringify(entry).slice(0, 200)}`);
        }
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      const keys = Object.keys(parsed);
      parts.push(`Type: Object with ${keys.length} top-level keys`);
      parts.push('');

      for (const key of keys.slice(0, 30)) {
        const val = parsed[key];
        let typeStr: string;
        if (Array.isArray(val)) {
          typeStr = `Array[${val.length}]`;
        } else if (val === null) {
          typeStr = 'null';
        } else {
          typeStr = typeof val;
        }
        parts.push(`  "${key}": ${typeStr}`);
      }
      if (keys.length > 30) {
        parts.push(`  ... and ${keys.length - 30} more keys`);
      }
    }
  } catch {
    parts.push('(Failed to parse JSON, treating as text)');
    return generateTextSummary(content, header);
  }

  return parts.join('\n');
}

function generateCsvSummary(content: string, lines: string[], header: string): string {
  const parts: string[] = [header, ''];
  const nonEmptyLines = lines.filter(l => l.trim().length > 0);

  if (nonEmptyLines.length === 0) {
    parts.push('(Empty file)');
    return parts.join('\n');
  }

  // Detect delimiter
  const firstLine = nonEmptyLines[0];
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  const headers = firstLine.split(delimiter).map(h => h.trim().replace(/^"|"$/g, ''));

  parts.push(`Rows: ${nonEmptyLines.length - 1} (excluding header)`);
  parts.push(`Columns: ${headers.length}`);
  parts.push(`Headers: ${headers.join(', ')}`);
  parts.push('');
  parts.push('First 3 data rows:');

  for (const line of nonEmptyLines.slice(1, 4)) {
    parts.push(`  ${line}`);
  }

  return parts.join('\n');
}

function generateTextSummary(content: string, header: string): string {
  const parts: string[] = [header, ''];

  const maxFront = 500;
  const maxBack = 500;

  if (content.length <= maxFront + maxBack + 100) {
    parts.push(content);
  } else {
    const front = content.slice(0, maxFront);
    const back = content.slice(content.length - maxBack);
    const omitted = content.length - maxFront - maxBack;
    parts.push(front);
    parts.push(`\n[... ${omitted} chars omitted ...]\n`);
    parts.push(back);
  }

  return parts.join('\n');
}

// ── Intercept and Store ──

export function interceptLargeFile(
  agentId: string,
  content: string,
  originalPath?: string,
): { fileId: string; replacement: string } {
  const db = getDb();
  const fileId = `file_${uuidv4()}`;
  const ext = detectExtension(originalPath);
  const agentDir = path.join(FILES_BASE_DIR, agentId);

  // Create directory
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }

  const storagePath = path.join(agentDir, `${fileId}${ext}`);

  // Write content to disk
  fs.writeFileSync(storagePath, content, 'utf-8');

  // Generate exploration summary
  const explorationSummary = generateExplorationSummary(content, originalPath);
  const tokenCount = estimateTokens(content);

  // Detect MIME type (basic)
  const mimeType = ext === '.json' ? 'application/json'
    : ext === '.csv' ? 'text/csv'
    : ext === '.ts' || ext === '.js' ? 'text/javascript'
    : 'text/plain';

  // Insert into database
  db.prepare(`
    INSERT INTO large_files (id, agent_id, original_path, mime_type, token_count, exploration_summary, storage_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(fileId, agentId, originalPath ?? null, mimeType, tokenCount, explorationSummary, storagePath);

  logger.info('Intercepted large file', {
    fileId,
    originalPath,
    tokenCount,
    storagePath,
  }, agentId);

  // Build replacement text
  const replacement = `[File intercepted: ${fileId} | ${tokenCount} tokens stored on disk]\n\n${explorationSummary}\n\nUse memory_describe("${fileId}") or memory_expand with this file ID to explore further.`;

  return { fileId, replacement };
}

// ── Retrieve ──

export function getLargeFile(fileId: string): { content: string; metadata: Record<string, unknown> } | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM large_files WHERE id = ?').get(fileId) as {
    id: string;
    agent_id: string;
    original_path: string | null;
    mime_type: string | null;
    token_count: number;
    exploration_summary: string;
    storage_path: string;
    created_at: string;
  } | undefined;

  if (!row) return null;

  try {
    const content = fs.readFileSync(row.storage_path, 'utf-8');
    return {
      content,
      metadata: {
        id: row.id,
        agentId: row.agent_id,
        originalPath: row.original_path,
        mimeType: row.mime_type,
        tokenCount: row.token_count,
        explorationSummary: row.exploration_summary,
        storagePath: row.storage_path,
        createdAt: row.created_at,
      },
    };
  } catch (err) {
    logger.error('Failed to read large file from disk', {
      fileId,
      storagePath: row.storage_path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
