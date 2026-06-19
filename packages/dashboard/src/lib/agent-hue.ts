/**
 * Agent colour. One hue drives BOTH the agent's avatar box (hsl) and the orb
 * tint, so they always match. Resolution order for an agent:
 *   1. primary "dojo master"      -> the signature champagne (fixed)
 *   2. an explicitly chosen colour -> agent.config.orbHue (set via the picker)
 *   3. otherwise                   -> a stable hue derived from the agent id
 */

/** The dojo's signature champagne/gold hue. The primary orb never shifts from
 *  it, and it matches the orb engine's CHAMPAGNE_HUE_DEG. */
export const CHAMPAGNE_HUE = 42;

export interface OrbColor {
  name: string;
  hue: number;
}

/** A curated palette that reads well in the warm champagne scheme — soft, not
 *  neon. The user picks from these for any non-primary agent. */
export const ORB_PALETTE: OrbColor[] = [
  { name: 'Rose', hue: 350 },
  { name: 'Coral', hue: 14 },
  { name: 'Amber', hue: 34 },
  { name: 'Citron', hue: 74 },
  { name: 'Sage', hue: 134 },
  { name: 'Teal', hue: 172 },
  { name: 'Sky', hue: 202 },
  { name: 'Periwinkle', hue: 230 },
  { name: 'Violet', hue: 264 },
  { name: 'Berry', hue: 322 },
];

/** Stable fallback hue (0..360) for an agent with no chosen colour. */
export function agentHue(id: string): number {
  let h = 2166136261; // FNV-ish seed
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

/** Read an agent's chosen orb hue from its config, if a valid one is set. */
export function chosenHue(config: Record<string, unknown> | undefined | null): number | null {
  const v = config?.orbHue;
  return typeof v === 'number' && v >= 0 && v < 360 ? v : null;
}

/** The hue an agent's avatar + orb should use. */
export function resolveAgentHue(
  agent: { id: string; config?: Record<string, unknown> } | null | undefined,
  isPrimary: boolean,
): number {
  if (isPrimary) return CHAMPAGNE_HUE;
  if (!agent) return CHAMPAGNE_HUE;
  return chosenHue(agent.config) ?? agentHue(agent.id);
}
