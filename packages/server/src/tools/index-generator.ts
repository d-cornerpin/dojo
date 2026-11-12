// Boot-time writer of ~/.dojo/tools/*.md, which `load_tool_docs` reads back via ./tool-doc-read.ts. It
// runs once from `index.ts` before any agent exists, so its `node:fs` import is platform-internal.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';
import type { ToolDefinition } from '../agent/tools/types.js';
import { registryToolDefinitions } from '../agent/tools/registry.js';
import { TOOLS_DIR } from './tool-doc-read.js';
import { recordToolDocsGeneration } from './doc-freshness.js';

const logger = createLogger('tool-docs-generator');

// Hand-written overrides: a `<tool-name>.md` in the docs source directory is copied verbatim instead of
// generating one, for a tool that needs a longer prompting guide than its description can hold.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DOCS_SOURCE_DIR = path.resolve(__dirname, './docs');

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

export async function generateToolDocs(): Promise<{ count: number; expected: number; written: number; pruned: number }> {
  fs.mkdirSync(TOOLS_DIR, { recursive: true });

  // The registry owns the complete tool surface, so every grantable tool family is documented here.
  const allTools: ToolDefinition[] = registryToolDefinitions();

  // Dedupe by name. `seen` is the expected surface (one manual owed per unique name); the recorder
  // compares it with the written count.
  const seen = new Set<string>();
  let count = 0;
  /** The first real write failure, carried out to the freshness record. */
  let firstWriteError: string | null = null;
  for (const tool of allTools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);

    // A hand-written override is used verbatim, else the doc is generated from the definition.
    let doc: string;
    const overridePath = path.join(TOOL_DOCS_SOURCE_DIR, `${tool.name}.md`);
    if (fs.existsSync(overridePath)) {
      try {
        doc = fs.readFileSync(overridePath, 'utf-8');
      } catch {
        doc = formatToolDoc(tool);
      }
    } else {
      doc = formatToolDoc(tool);
    }

    const filePath = path.join(TOOLS_DIR, `${tool.name}.md`);
    try {
      fs.writeFileSync(filePath, doc, 'utf-8');
      count++;
    } catch (err) {
      // The per-tool warn names which manual failed; `firstWriteError` carries the first one to the recorder.
      const message = err instanceof Error ? err.message : String(err);
      if (firstWriteError === null) firstWriteError = message;
      logger.warn(`Failed to write tool doc for ${tool.name}`, { error: message });
    }
  }

  // Prune ghost docs: delete any `.md` whose tool name is not in the current definition set (a renamed or
  // removed tool leaves a stale manual that `load_tool_docs` could still return).
  let pruned = 0;
  try {
    for (const file of fs.readdirSync(TOOLS_DIR)) {
      if (!file.endsWith('.md')) continue;
      const toolName = file.slice(0, -'.md'.length);
      if (seen.has(toolName)) continue;
      try {
        fs.unlinkSync(path.join(TOOLS_DIR, file));
        pruned++;
      } catch (err) {
        logger.warn(`Failed to prune stale tool doc ${file}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch { /* dir read failed: non-fatal, nothing to prune */ }

  // The recorder owns the comparison and the log level, so it runs on every boot, not at a call site.
  recordToolDocsGeneration({
    expected: seen.size,
    written: count,
    dir: TOOLS_DIR,
    lastError: firstWriteError,
    pruned,
  });

  // `count` and `written` are the same number (the older name and the freshness contract's name).
  return { count, expected: seen.size, written: count, pruned };
}
