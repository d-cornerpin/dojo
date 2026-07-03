// ════════════════════════════════════════
// Phase 1A, loop detector classifier
//
// Ports v1's canonicalToolSignature + repeat-count check from
// runtime.ts:261-293 + 1440-1463 into a v2 classifier. Behavior is
// identical: a tool call signature normalized to ignore agent prose,
// timestamp/UUID variation, and JSON key order. After 3 calls of
// the same signature in the recent window, the call is blocked.
//
// Window size and threshold match v1 exactly (RECENT_TOOL_WINDOW = 8,
// MAX_REPEATS_BEFORE_BREAK = 3) so v2 behavior matches v1 verbatim.
// ════════════════════════════════════════

import type { ToolCall } from '@dojo/shared';

export const RECENT_TOOL_WINDOW = 8;       // matches v1 runtime.ts:785
export const MAX_REPEATS_BEFORE_BREAK = 3; // matches v1 runtime.ts:786

// Remediation 4f (catalog row 9): user-facing repetition guard. The exact-
// match check missed trivially reworded repeats; token-set Jaccard catches
// near-duplicates cheaply on the hot reply path (no embedding call). Short
// replies stay exact-only: "Done." twice in a row can be legitimate.
export function isNearDuplicateText(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size < 8 || tb.size < 8) return a.trim() === b.trim();
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  return jaccard >= 0.9;
}

export type LoopDecision = 'ok' | 'block';

export interface LoopCheckResult {
  decision: LoopDecision;
  signature: string;        // canonical sig of this call (caller appends to window)
  repeatCount: number;      // how many times this sig appeared in the window (incl. current)
  refusalMessage?: string;  // populated when decision === 'block'
}

/**
 * Fields that carry agent prose rather than operation identity.
 * Removed from the canonical signature so two calls that say
 * different things in their `caption` but do the same operation
 * compare equal.
 *
 * Verbatim from v1 runtime.ts:255-259.
 */
const DEFAULT_PROSE_FIELDS = new Set([
  'caption', 'message', 'content', 'text', 'payload',
  'summary', 'description', 'query', 'reason', 'note', 'notes',
  'change_summary', 'instructions',
]);

/**
 * v2.7.25, Search / exploration tools where the `query` field IS the
 * operation identity, not prose. Dropping `query` from the signature
 * collapsed semantically-distinct searches into one bucket and blocked
 * legitimate "try a different phrasing" sweeps (e.g. vault_search with
 * 4 related queries hit the 3-repeat threshold and refused the 4th).
 *
 * For these tools the global PROSE_FIELDS minus `query` is used, 
 * everything else (`reason`, `note`, etc.) still gets stripped, but
 * each distinct query phrase counts as a distinct operation.
 *
 * Update this set when you add a new search-style tool whose primary
 * input is the user-supplied search string.
 */
const SEARCH_TOOLS = new Set([
  // Vault + memory
  'vault_search', 'vault_describe', 'vault_expand',
  'memory_grep', 'memory_describe', 'memory_expand',
  'squad_recall',
  // External search
  'web_search', 'web_fetch', 'web_browse',
  // Email
  'gmail_search', 'outlook_search',
  // Calendar
  'calendar_search', 'calendar_search_ms',
  // Storage / contacts / sites
  'drive_list', 'onedrive_search', 'sharepoint_list_sites', 'contacts_search',
  // Plaud
  'plaud_search_recordings',
  // Screen / techniques (different questions → different operations)
  'screen_read', 'technique_read',
]);

const SEARCH_TOOL_PROSE_FIELDS = (() => {
  const s = new Set(DEFAULT_PROSE_FIELDS);
  s.delete('query');
  return s;
})();

/**
 * Generation / creation tools where the `description` (or `prompt`) IS the
 * operation identity, not prose. Field bug: image_create takes
 * `aspect_ratio` + `description`, and `description` was being stripped as
 * prose, leaving only `aspect_ratio: '1:1'` in the signature. Every
 * image_create call with the same aspect ratio collapsed to the same
 * signature, so a batch of 7 distinct headshots got blocked after 3.
 *
 * For these tools we keep `description` and `prompt` in the signature so
 * each distinct prompt counts as a distinct operation. The other
 * DEFAULT_PROSE_FIELDS (reason, note, etc.) still get stripped.
 */
const GENERATION_TOOLS = new Set([
  'image_create',
  'video_create',
  'music_create',
]);

const GENERATION_TOOL_PROSE_FIELDS = (() => {
  const s = new Set(DEFAULT_PROSE_FIELDS);
  s.delete('description');
  s.delete('prompt');
  return s;
})();

/**
 * OPEN-3, Inter-agent coordination tools where the `payload`/`message` IS the
 * operation identity, not prose. send_to_agent's args are
 * {agent, thread_id, intent, payload}; stripping `payload` as prose collapsed
 * every distinct message to the SAME thread/intent into one signature, so
 * legitimate multi-message PM coordination on a user turn hit the 3-repeat
 * threshold and got blocked ("STOP, you have called send_to_agent N times").
 * Keeping the content field means distinct messages count as distinct
 * operations; a TRUE thrash (re-sending the identical message) still collapses
 * to one signature and is still caught. Mirrors the SEARCH/GENERATION carve-outs.
 */
const COORDINATION_TOOLS = new Set([
  'send_to_agent',
  'broadcast_to_group',
]);

const COORDINATION_TOOL_PROSE_FIELDS = (() => {
  const s = new Set(DEFAULT_PROSE_FIELDS);
  s.delete('payload');
  s.delete('message');
  return s;
})();

/**
 * D5, Mutating tools where the content-bearing field IS the operation identity,
 * not prose. file_write/append/patch take {path, content}; stripping `content`
 * as prose collapsed every append to the SAME file into one signature, so the
 * 4th section-append (the tool's own docs recommend building a long doc one
 * section at a time) was blocked as a "loop". Channel sends take {to, message/
 * text}; the message content is what distinguishes two real sends to the same
 * recipient. Keep those fields, canonicalToolSignature already fingerprints
 * long strings to a cheap prefix+len hash, so distinct writes/sends are
 * distinct operations. A TRUE thrash (identical content re-written/re-sent)
 * still collapses to one signature and is still caught.
 */
const MUTATING_TOOLS = new Set([
  'file_write', 'file_append', 'file_patch',
  'imessage_send', 'sms_send',
  'email_send', 'gmail_send', 'gmail_reply', 'gmail_send_message',
  'outlook_send', 'outlook_reply', 'outlook_send_message',
  'teams_send_message',
]);

const MUTATING_TOOL_PROSE_FIELDS = (() => {
  const s = new Set(DEFAULT_PROSE_FIELDS);
  s.delete('content');
  s.delete('text');
  s.delete('message');
  return s;
})();

function proseFieldsFor(toolName: string): ReadonlySet<string> {
  if (SEARCH_TOOLS.has(toolName)) return SEARCH_TOOL_PROSE_FIELDS;
  if (GENERATION_TOOLS.has(toolName)) return GENERATION_TOOL_PROSE_FIELDS;
  if (COORDINATION_TOOLS.has(toolName)) return COORDINATION_TOOL_PROSE_FIELDS;
  if (MUTATING_TOOLS.has(toolName)) return MUTATING_TOOL_PROSE_FIELDS;
  return DEFAULT_PROSE_FIELDS;
}

// D5: a successful mutating tool (a write or a send) is forward progress, the
// task-thrash breaker must not count it toward a "stuck" verdict. Exposed so the
// breaker's madeProgress check can treat writes/sends like tracker transitions.
export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

/**
 * Build a canonical signature for a tool call, used to detect loops.
 *
 * The sig captures the operation, not the agent's prose around it.
 * Two calls to show_to_user with the same file but different captions
 * are the same operation. Two file_reads on
 * slides_..._<timestamp>_000.png are the same operation.
 *
 * Behavior is verbatim from v1 runtime.ts:261-293:
 *   1. Drop fields that are agent prose (PROSE_FIELDS).
 *   2. Replace 6+ digit numeric runs in remaining strings with "*"
 *      (catches timestamps, large UUIDs).
 *   3. Truncate long string values to a short prefix.
 *   4. Sort keys so JSON ordering doesn't matter.
 */
export function canonicalToolSignature(
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args) return `${name}:{}`;
  const normalized: Record<string, unknown> = {};
  // Truncate long values to a stable prefix instead of a blob marker. The
  // pre-2026-05-06 implementation replaced every >80-char string with the
  // literal "<prose>", which collapsed distinct exec commands (grep vs
  // sed vs python3) into the same signature, three real, different exec
  // calls would trip the loop detector and the fourth got blocked. The
  // PROSE_FIELDS drop above already removes truly free-form agent text;
  // here we just want to ignore late variation (timestamps, trailing
  // arguments) within the same operation.
  const fingerprintLong = (s: string): string =>
    s.length > 80 ? `${s.slice(0, 60)}…[len=${s.length}]` : s;
  const proseFields = proseFieldsFor(name);
  for (const k of Object.keys(args).sort()) {
    if (proseFields.has(k)) continue;
    const v = args[k];
    if (typeof v === 'string') {
      const s = v.replace(/\d{6,}/g, '*');
      normalized[k] = fingerprintLong(s);
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      normalized[k] = v;
    } else if (Array.isArray(v)) {
      normalized[k] = v.slice(0, 5).map((item) => {
        if (typeof item === 'string') {
          const s = item.replace(/\d{6,}/g, '*');
          return fingerprintLong(s);
        }
        return item;
      });
    } else {
      try {
        const s = JSON.stringify(v);
        normalized[k] = fingerprintLong(s);
      } catch {
        normalized[k] = '<unserializable>';
      }
    }
  }
  return `${name}:${JSON.stringify(normalized)}`;
}

/**
 * Check whether this tool call is a duplicate that should be blocked.
 *
 * Caller passes the recent tool signatures window (managed in state).
 * If the new call's signature appears MAX_REPEATS_BEFORE_BREAK times
 * already in the window, the decision is 'block' with a refusal
 * message that tells the agent to stop and respond with text.
 *
 * Behavior verbatim from v1 runtime.ts:1440-1463, same threshold,
 * same refusal message, same windowing.
 */
export function loopDetector(
  call: ToolCall,
  recentSignatures: string[],
): LoopCheckResult {
  const signature = canonicalToolSignature(call.name, call.arguments);
  const repeatCount = recentSignatures.filter((s) => s === signature).length;
  if (repeatCount >= MAX_REPEATS_BEFORE_BREAK) {
    return {
      decision: 'block',
      signature,
      repeatCount: repeatCount + 1,
      refusalMessage:
        `STOP, you have called \`${call.name}\` ${repeatCount + 1} times with substantially-similar arguments in the last few turns. ` +
        `The user does not need more verification. The previous result is the answer; trust it. ` +
        `Respond to the user with TEXT now, do NOT call this tool again, and do NOT call related verification tools (file_read, exec, ls, etc.) on the same artifact. ` +
        `If you genuinely need different information, ask the user a direct question instead.`,
    };
  }

  // Same-tool-name threshold REMOVED 2026-05-06. The blanket "same tool
  // called >5 times in the window" check (added in v2.2.2 to catch
  // memory_grep thrashing) blocked legitimate batch operations, an agent
  // updating profiles on 6 sub-agents looked identical to a real loop.
  // The original target (memory_grep thrashing) is now handled by giving
  // memory_grep results their message IDs + a copy-pasteable
  // memory_describe(id="…") hint when truncated, so the agent has a clean
  // recovery path instead of needing to thrash. MAX_TOOL_LOOPS=75
  // remains as the per-turn ceiling for the truly-pathological case.
  return { decision: 'ok', signature, repeatCount: repeatCount + 1 };
}
