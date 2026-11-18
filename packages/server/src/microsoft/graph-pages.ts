// Graph answers a list in pages and names the next one in `@odata.nextLink`. This reads a list
// to its end so a busy calendar is not silently cut after the first page.

import { msGraphRead } from './client.js';

/** Every page's `value` joined, or the first failure. Stops when no next link is given or one repeats. */
export async function readAllPages<T = unknown>(
  firstEndpoint: string,
  agentId: string,
  agentName: string,
  action: string,
  details: Record<string, unknown>,
  accountId: string,
  /** Stop once this many items are read (and give back exactly that many). Absent: read to the end. */
  limit?: number,
): Promise<{ ok: true; value: T[] } | { ok: false; error: string }> {
  const value: T[] = [];
  const seen = new Set<string>();
  let next: string | undefined = firstEndpoint;
  while (next && !seen.has(next)) {
    seen.add(next);
    const page = await msGraphRead(next, agentId, agentName, action, details, accountId);
    if (!page.ok) return { ok: false, error: page.error ?? 'unknown error' };
    const data = page.data as { value?: T[]; '@odata.nextLink'?: string } | null;
    value.push(...(data?.value ?? []));
    next = data?.['@odata.nextLink'];
    if (limit !== undefined && value.length >= limit) break;
  }
  return { ok: true, value: limit !== undefined ? value.slice(0, limit) : value };
}

/** Teams message body for the read result: cut at 500 characters, and a cut says so to the agent. */
export function teamsBodyShown(body: string): string {
  return body.length > 500 ? `${body.slice(0, 500)}… [truncated; ${body.length} chars]` : body;
}

export type TeamsMessage = { id: string; from?: { user?: { displayName: string } }; body: { content: string; contentType: string }; createdDateTime: string };
