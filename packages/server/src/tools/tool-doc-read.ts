// ════════════════════════════════════════════════════════════════════════════
// READING A GENERATED TOOL DOC (PHASE-5 T8 Step 3, RULING P5-R15 part 2).
//
// `index-generator.ts` held two jobs behind one `node:fs` import: it WRITES
// `~/.dojo/tools/*.md` once at boot, and it READ one of them back inside a tool
// call. Those are two populations, not one — the writer runs before any agent
// exists and the reader runs inside `load_tool_docs` — so the module's single
// import could not be honestly classified either way. The surfaces are now
// separated: the generator keeps the boot job and its `node:fs`, and this leaf
// holds the reader, which reaches the disk through the facade.
//
// The READER moved rather than the generator because that is where the real
// module boundary is: the file's own name and header describe the generator, and
// the reader was the passenger. It also leaves this a LEAF — the generator
// statically imports the whole tool registry, and none of that belongs in the
// module graph of a dispatch that only wants to read one markdown file.
//
// `TOOLS_DIR` lives here, with the leaf, and the generator imports it: one owner
// for the fact of where the docs are.
// ════════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import os from 'node:os';
import * as effectFs from '../agent/effects/fs.js';

export const TOOLS_DIR = path.join(os.homedir(), '.dojo', 'tools');

export function getToolsDir(): string {
  return TOOLS_DIR;
}

/**
 * Read a tool's documentation file.
 *
 * The name reaching here is always one of the agent's own accessible tools —
 * `load_tool_docs` intersects the requested names with `getFilteredTools(agentId)`
 * before it calls this — so the declared scope (the docs directory) is exactly
 * the reach, and the conversion adds no refusal to any reachable call.
 */
export function readToolDoc(toolName: string): string | null {
  const filePath = path.join(TOOLS_DIR, `${toolName}.md`);
  if (!effectFs.existsSync(filePath)) return null;
  try {
    return effectFs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
