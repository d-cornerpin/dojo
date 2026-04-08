// ════════════════════════════════════════
// Tool Doc Generator
// Writes full tool documentation to ~/.dojo/tools/*.md
// Runs on startup so load_tool_docs can read them.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logger.js';
import type { ToolDefinition } from '../agent/tools.js';

const logger = createLogger('tool-docs-generator');
const TOOLS_DIR = path.join(os.homedir(), '.dojo', 'tools');

export function getToolsDir(): string {
  return TOOLS_DIR;
}

/**
 * Format a tool definition as a Markdown documentation file.
 */
export function formatToolDoc(tool: ToolDefinition): string {
  const lines: string[] = [];
  lines.push(`# ${tool.name}`);
  lines.push('');
  lines.push(tool.description);
  lines.push('');
  lines.push('## Parameters');
  lines.push('');

  const props = tool.input_schema.properties as Record<string, { type?: string; description?: string; enum?: string[]; items?: { type?: string } }>;
  const required = new Set(tool.input_schema.required ?? []);

  if (Object.keys(props).length === 0) {
    lines.push('_(no parameters)_');
  } else {
    for (const [name, prop] of Object.entries(props)) {
      const type = prop.type ?? 'any';
      const req = required.has(name) ? 'required' : 'optional';
      const itemType = prop.items?.type ? `<${prop.items.type}>` : '';
      let line = `- **${name}** (${type}${itemType}, ${req})`;
      if (prop.description) {
        line += `: ${prop.description}`;
      }
      if (prop.enum) {
        line += ` — one of: ${prop.enum.join(', ')}`;
      }
      lines.push(line);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Generate .md files for all tool definitions.
 * Called on platform startup.
 */
export async function generateToolDocs(): Promise<{ count: number }> {
  // Ensure directory exists
  fs.mkdirSync(TOOLS_DIR, { recursive: true });

  // Gather all tools from all sources
  const { toolDefinitions } = await import('../agent/tools.js');
  const { googleReadToolDefinitions } = await import('../google/tools-read.js');
  const { googleWriteToolDefinitions } = await import('../google/tools-write.js');
  const { slidesToolDefinitions } = await import('../google/tools-slides.js');
  const { microsoftReadToolDefinitions } = await import('../microsoft/tools-read.js');
  const { microsoftWriteToolDefinitions } = await import('../microsoft/tools-write.js');
  const { officeToolDefinitions } = await import('../microsoft/tools-office.js');

  const allTools: ToolDefinition[] = [
    ...toolDefinitions,
    ...googleReadToolDefinitions,
    ...googleWriteToolDefinitions,
    ...slidesToolDefinitions,
    ...microsoftReadToolDefinitions,
    ...microsoftWriteToolDefinitions,
    ...officeToolDefinitions,
  ];

  // Deduplicate by name (Google calendar_agenda vs Microsoft calendar_agenda_ms, etc.)
  const seen = new Set<string>();
  let count = 0;
  for (const tool of allTools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);

    const doc = formatToolDoc(tool);
    const filePath = path.join(TOOLS_DIR, `${tool.name}.md`);
    try {
      fs.writeFileSync(filePath, doc, 'utf-8');
      count++;
    } catch (err) {
      logger.warn(`Failed to write tool doc for ${tool.name}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Tool docs generated', { count, dir: TOOLS_DIR });
  return { count };
}

/**
 * Read a tool's documentation file.
 */
export function readToolDoc(toolName: string): string | null {
  const filePath = path.join(TOOLS_DIR, `${toolName}.md`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
