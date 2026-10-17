// t196 (A4): every steer reaches the model as an ENGINE line, never as a bare sentence the model could read as the
// user's. Held at the one seam every steer crosses (`enqueueSteer`), so a new floor cannot arrive without it. A steer
// that already carries a `[System` / `[Engine` head is left byte-identical.
const AUTHOR_HEAD = /^\s*\[(System|Engine)\b/;

export function withAuthorHead(content: string): string {
  return AUTHOR_HEAD.test(content) ? content : `[System: ${content.trim()}]`;
}
