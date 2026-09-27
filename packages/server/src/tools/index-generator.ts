// ════════════════════════════════════════
// Tool Doc Generator
// Writes full tool documentation to ~/.dojo/tools/*.md
// Runs on startup so load_tool_docs can read them.
// ════════════════════════════════════════
//
// PHASE-5 T8 Step 3 (RULING P5-R15 part 2): this module used to hold the READER
// too, which meant one `node:fs` import served both a boot job and a tool call.
// The reader is now `./tool-doc-read.ts` and reaches the disk through the
// facade; what is left here runs ONCE at boot, from `index.ts`, before any agent
// exists — so this import is platform-internal and says so.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';
import type { ToolDefinition } from '../agent/tools/types.js';
import { registryToolDefinitions } from '../agent/tools/registry.js';
import { TOOLS_DIR } from './tool-doc-read.js';
import { recordToolDocsGeneration } from './doc-freshness.js';

const logger = createLogger('tool-docs-generator');

// Source directory for hand-written tool doc overrides. When a file named
// `<tool-name>.md` exists here, it's copied verbatim into ~/.dojo/tools/
// instead of generating one from the tool definition. Used when a tool
// needs a longer prompting guide than can reasonably live in the
// `description` field (e.g. image_create's "how to write good
// descriptions" section).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DOCS_SOURCE_DIR = path.resolve(__dirname, './docs');

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
export async function generateToolDocs(): Promise<{ count: number; expected: number; written: number; pruned: number }> {
  // Ensure directory exists
  fs.mkdirSync(TOOLS_DIR, { recursive: true });

  // Single source of truth: the REGISTRY owns the complete tool surface, so any
  // tool family agents can be granted is documented here too. (Replaces a
  // hand-maintained import list that drifted: forms/pdf/credentials/plaud were
  // loadable but undocumented, so load_tool_docs dead-ended on them.) PHASE-5
  // T1: this was `await import('../agent/tools.js')` — the seventh of the seven
  // dynamic-import hacks §T0-PINS P8 pinned. Nothing here imports this module
  // from inside the toolbox, so the loop it was breaking did not exist.
  const allTools: ToolDefinition[] = registryToolDefinitions();

  // Deduplicate by name (Google calendar_agenda vs Microsoft calendar_agenda_ms, etc.)
  // `seen` IS the expected surface: one manual is owed per unique registered name, so its
  // size is the number the written count has to be compared against. Before the
  // installed-box audit this number was computed and then thrown away, which is why a box
  // that wrote nothing could report `count: 0` as success.
  const seen = new Set<string>();
  let count = 0;
  /** The first real write failure, carried out to the freshness record. */
  let firstWriteError: string | null = null;
  for (const tool of allTools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);

    // If there's a hand-written override in src/tools/docs/<name>.md, use
    // it verbatim. Otherwise generate from the tool definition.
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
      // Per-tool warn KEPT: it names which manual failed, which the aggregate
      // cannot. What changes is that the failure is no longer the ONLY record —
      // `firstWriteError` carries it out to the freshness recorder, so a box
      // that failed every write can say so once, at ERROR, with a number.
      const message = err instanceof Error ? err.message : String(err);
      if (firstWriteError === null) firstWriteError = message;
      logger.warn(`Failed to write tool doc for ${tool.name}`, { error: message });
    }
  }

  // Prune ghost docs: the dir is written but historically never cleaned, so
  // renamed/removed tools left stale `<name>.md` files behind (e.g.
  // audio_create.md after that tool became tts_create). A stale doc is mostly
  // inert — there's no executor and it's in no category — but load_tool_docs
  // could still return it, and it clutters the dir. Delete any `.md` whose
  // tool name isn't in the current definition set.
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
  } catch { /* dir read failed — non-fatal, nothing to prune */ }

  // THE COMPARISON, and it is not made here: the recorder owns it, so it happens on every
  // boot by construction rather than at a call site somebody can forget. It also owns the
  // level — a shortfall is an ERROR, a complete set is the INFO line this function used to
  // write unconditionally (including when it had written nothing at all).
  recordToolDocsGeneration({
    expected: seen.size,
    written: count,
    dir: TOOLS_DIR,
    lastError: firstWriteError,
    pruned,
  });

  // `count` is kept as the historical name for the written total; `written` is the same
  // number under the name the freshness contract uses, so a caller reads whichever it means.
  return { count, expected: seen.size, written: count, pruned };
}
