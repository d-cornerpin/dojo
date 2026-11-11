// Bumped by any write to the global tool surface; zero imports keep it cycle-free for low-level writers.

let generation = 0;

export function bumpToolConfigGeneration(): void {
  generation++;
}

export function getToolConfigGeneration(): number {
  return generation;
}
