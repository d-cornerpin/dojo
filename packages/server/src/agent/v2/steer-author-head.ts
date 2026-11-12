// Every steer reaches the model as an engine line, never as user text; applied once, in enqueueSteer.
const AUTHOR_HEAD = /^\s*\[(System|Engine)\b/;

export function withAuthorHead(content: string): string {
  return AUTHOR_HEAD.test(content) ? content : `[System: ${content.trim()}]`;
}
