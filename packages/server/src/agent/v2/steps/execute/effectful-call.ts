// The ONE rule for "this call did something in the world". `post-result.ts` counts it into
// `turns.effectful_calls` (on success), and `work/orphaned-claims.ts` names, from a dead turn's
// own tool rows, the calls it must not repeat when its owner's message is handed back.
import { classifyTool } from '@dojo/shared';
import { FIRE_AND_FORGET_GEN_TOOLS, SEND_TO_PEOPLE_SET } from './tool-sets.js';

export function isEffectfulTool(name: string): boolean {
  return classifyTool(name) === 'effectful-action' || FIRE_AND_FORGET_GEN_TOOLS.has(name) || SEND_TO_PEOPLE_SET.has(name);
}
