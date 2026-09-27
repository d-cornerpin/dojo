// ════════════════════════════════════════════════════════════════════════════
// THE GRAPH BYTE DOOR — THE CALLS THAT DO NOT GO THROUGH `msGraphRead/Write`
// (A-6 fix round, sweep review L2-1)
//
// `client.ts` next door is the WRAPPED door: it logs the activity, records at the
// outbound seam, and — since A-6 — registers the call under the agent's stop. Three
// files reach Graph without it, and for real reasons: a workbook-range PATCH, an
// upload-session PUT to a URL Graph just issued, a `…/content` byte read. Those calls
// must not appear in the activity feed as separate rows, which is what `client.ts`'s
// wrappers are for.
//
// ── WHAT THE CENSUS FOUND, AND WHY THIS FILE EXISTS ──
// The A-6 census exempted those three files with the sentence *"RIDES THE DOOR
// ALREADY"*. Measured by the reviewer, that was FALSE of all three:
// `tools-office.ts` calls neither wrapper anywhere — 13 bare fetches, 9 straight to
// Graph, and ELEVEN carrying no `signal` at all, so an Excel or OneDrive operation
// could hang with neither a timeout nor a stop. `tools-write.ts`'s sentence described
// 4 of its 16 sites; `tools-read.ts`'s described none of its 3. The exemption was
// reporting work as handled that was not handled.
//
// So this is the A-6 job finished rather than re-worded: one door those sites go
// through, which gives each of them the two things the wrapped door already had —
//
//   1. THE AGENT'S STOP, registered through `openAgentCall` exactly as the media dials
//      and the four A-6 transports do, composed with whatever clock the caller brought.
//   2. A CLOCK AT ALL. A site that passed no `signal` gets `GRAPH_TIMEOUT_MS`, because
//      "hangs for ever" was the other half of what the census had called handled.
//
// …and none of the three things the wrapped door adds: no activity row, no outbound
// record, no broadcast. That is the whole reason those call sites are not simply
// rewritten to use `msGraphRead`.
//
// ⚠ IT OWNS `GRAPH_BASE`. The constant was written twice — `client.ts:16` and
// `tools-office.ts:19` — with the same literal. One constant, one owner: both now read
// it from here, which is also what let this fix land without growing either pinned file.
// ════════════════════════════════════════════════════════════════════════════

import { openAgentCall, STOPPED_BY_USER } from '../agent/abortable-call.js';

/** Microsoft Graph v1.0. The one copy; `client.ts` and `tools-office.ts` both read it. */
export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * The default deadline for a site that brought none. Deliberately generous — these are
 * workbook writes and multi-megabyte uploads, not chat completions — and deliberately
 * finite, which is the change: eleven of these sites had no deadline of any kind.
 */
export const GRAPH_TIMEOUT_MS = 60_000;

/**
 * One Graph call, under this agent's stop.
 *
 * `agentId` comes FIRST and may be `undefined`: a plumbing caller (a boot probe, an
 * operator's connection test) passes nothing and registers against nobody — the same rule
 * `client.ts`'s own transport follows, and for the same reason: `countAbortable` is a
 * number a user READS on the agent card (A-5b), so a registration for work no agent asked
 * for would make it a lie. First rather than last because the 32 call sites this replaces
 * carry multi-line `RequestInit` literals: `fetch(url, {…})` → `graphFetch(agentId, url,
 * {…})` is a prefix edit that adds no line to three files that may only shrink.
 *
 * A stop is REPORTED AS A STOP. These callers each render their own failure text
 * ("Download failed: HTTP …", "Error: …"), so an `AbortError` reaching them would come
 * out as a transport fault — the user's own button wearing a provider's clothes, which
 * is the defect A-5 was fixed for. The throw is re-labelled here, once, and the
 * discrimination is read off THIS call's own controller, so a composed deadline can
 * never be reported as a stop.
 */
export async function graphFetch(
  agentId: string | undefined, url: string, init: RequestInit = {},
): Promise<Response> {
  const slot = agentId === undefined ? null : openAgentCall(agentId, 'turn', init.signal ?? undefined);
  if (slot?.refused) {
    slot.release();
    throw new Error(STOPPED_BY_USER);
  }
  try {
    return await fetch(url, {
      ...init,
      // The slot already composed the caller's own signal; a caller that brought none
      // gets the finite deadline it was missing.
      signal: slot?.signal ?? init.signal ?? AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
  } catch (err) {
    if (slot?.cutByStop()) throw new Error(STOPPED_BY_USER);
    throw err;
  } finally {
    slot?.release();
  }
}
