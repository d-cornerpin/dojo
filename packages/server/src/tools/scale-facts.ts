// v3.5 PLAN BEFORE PROJECT, Task A2: what a tool can do in ONE call, stated on the tool's own definition
// (`ToolDefinition.scale`) and read back from it. Nothing here is a hand-typed list of tools: the facts
// are whatever the definitions the agent holds declare, so a tool that learns to batch says so where it
// is defined and the agent sees it when it plans.
import { toolDefinitionsByName } from '../agent/tools/definitions.js';
import { getFilteredTools } from '../agent/tools/surface.js';

/**
 * What one call of a tool can do at scale. `batch` names an argument that takes several ids and the most
 * the provider accepts per call; `pages` names the argument that sets the page size, the provider's page
 * maximum, and the argument that carries the cursor to the next page. `note` is the sentence the agent
 * reads; `{max}` and `{pageSize}` in it are filled from the numbers declared beside it, so a number is
 * said once.
 */
export interface ToolScale {
  batch?: { arg: string; max: number };
  pages?: { arg: string; pageSize: number; tokenArg: string };
  note: string;
}

export interface ScaleFact { tool: string; scale: ToolScale }

const num = (n: number): string => n.toLocaleString('en-US');

/** The scale facts of the named tools that declare any, in the order given (each tool once). */
export function scaleFactsFor(toolNames: readonly string[]): ScaleFact[] {
  const defs = toolDefinitionsByName();
  const out: ScaleFact[] = [];
  for (const name of new Set(toolNames)) {
    const scale = defs.get(name)?.scale;
    if (scale) out.push({ tool: name, scale });
  }
  return out;
}

/** One line per tool: "gmail_label: one call labels up to 1,000 messages (message_ids), …". */
export function renderScaleFacts(facts: readonly ScaleFact[]): string {
  return facts.map(({ tool, scale }) => {
    const note = scale.note
      .replace('{max}', scale.batch ? num(scale.batch.max) : '{max}')
      .replace('{pageSize}', scale.pages ? num(scale.pages.pageSize) : '{pageSize}');
    return `${tool}: ${note}`;
  }).join('\n');
}

/** The facts for the tools THIS agent holds, as the text a project-opening result ends with; '' if none. */
export function scaleFactsForAgent(agentId: string): string {
  try {
    const lines = renderScaleFacts(scaleFactsFor(getFilteredTools(agentId).map((t) => t.name)));
    return lines ? `What your tools do at scale:\n${lines}` : '';
  } catch {
    return '';   // facts are help, never a reason a project cannot open
  }
}
