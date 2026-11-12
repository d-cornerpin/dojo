// What a tool can do in one call, read back from its own definition (`ToolDefinition.scale`), never from
// a hand-typed list of tools.
import { toolDefinitionsByName } from '../agent/tools/definitions.js';
import { getFilteredTools } from '../agent/tools/surface.js';

/** What one call can do at scale; `{max}` and `{pageSize}` in `note` are filled from `batch` and `pages`. */
export interface ToolScale {
  batch?: { arg: string; max: number };
  pages?: { arg: string; pageSize: number; tokenArg: string };
  note: string;
}

export interface ScaleFact { tool: string; scale: ToolScale }

const num = (n: number): string => n.toLocaleString('en-US');

export function scaleFactsFor(toolNames: readonly string[]): ScaleFact[] {
  const defs = toolDefinitionsByName();
  const out: ScaleFact[] = [];
  for (const name of new Set(toolNames)) {
    const scale = defs.get(name)?.scale;
    if (scale) out.push({ tool: name, scale });
  }
  return out;
}

export function renderScaleFacts(facts: readonly ScaleFact[]): string {
  return facts.map(({ tool, scale }) => {
    const note = scale.note
      .replace('{max}', scale.batch ? num(scale.batch.max) : '{max}')
      .replace('{pageSize}', scale.pages ? num(scale.pages.pageSize) : '{pageSize}');
    return `${tool}: ${note}`;
  }).join('\n');
}

export function scaleFactsForAgent(agentId: string): string {
  try {
    const lines = renderScaleFacts(scaleFactsFor(getFilteredTools(agentId).map((t) => t.name)));
    return lines ? `What your tools do at scale:\n${lines}` : '';
  } catch {
    return '';
  }
}
