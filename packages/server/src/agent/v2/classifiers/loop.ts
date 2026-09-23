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

// ════════════════════════════════════════════════════════════════════════════
// THE SIGNATURE IS THE WHOLE ARGUMENT OBJECT (OWNER RULING, 2026-09-22)
//
// ── WHAT WAS HERE, AND WHY IT IS GONE ──
// A PROSE-FIELD ALLOW-LIST. v1 shipped `PROSE_FIELDS` — `caption, message,
// content, text, payload, summary, description, query, reason, note, notes,
// change_summary, instructions` — DROPPED from the signature on the theory that
// they "carry agent prose rather than operation identity", so two `show_to_user`
// calls with different captions would compare equal. Every time that theory met a
// real tool it was wrong, and every time the answer was ANOTHER CARVE-OUT SET
// keyed on TOOL NAME rather than a fix to the rule:
//   · v2.7.25     SEARCH_TOOLS       `query` is identity for 26 named search tools
//                                    (a vault_search sweep of 4 phrasings, blocked)
//   · 2026-07     GENERATION_TOOLS   `description`/`prompt`/`text` is identity
//                                    (7 distinct headshots, blocked after 3)
//   · OPEN-3      COORDINATION_TOOLS `payload`/`message` is identity
//                                    (multi-message PM coordination, blocked)
//   · D5 + 07-21  MUTATING_TOOLS     `content` is identity
//                                    (a Word doc abandoned mid-build on the 4th append)
// Four sets, a release-gate derivation scan (`deploy/check-tool-conformance.mjs`
// section (e)) and a registry-exhaustive unit test were built to keep the
// allow-list honest. The allow-list still failed in production:
//
//   THE LIVE DEFECT (2026-09-22). An agent ran FIVE `user_gmail_search` calls
//   with five different date ranges — `after:2026/09/08 before:2026/09/11`, then
//   /11–/14, /14–/17, /17–/20, /20–/23 — each returning different mail.
//   `user_gmail_search` is a RUNTIME-GENERATED twin of `gmail_search` and is in
//   no carve-out set, so `query` was stripped and all five collapsed to
//   `user_gmail_search:{"max_results":40}`. The thrash gate refused the work AND
//   told the model *"You already have the result from the first call"*, which was
//   not true. NEITHER GUARD COULD HAVE CAUGHT IT: the `user_` twins are minted at
//   runtime and are not in the category registry the exhaustive scan iterates, so
//   the scan is structurally blind to the entire twin family.
//
// ── THE RULE NOW ──
// OWNER RULING: *"Two calls are 'the same' only when the model asked for the same
// work."* EVERY argument key participates, keys sorted, no allow-list and no
// name-keyed exception to keep in sync. There is no set left to forget a tool
// from — which is why this DELETES four exported sets, five field lists,
// `proseFieldsFor`, and the release-gate section built to police them, instead of
// adding a fifth set for the twins.
//
// ── WHAT THIS COSTS, STATED ──
// A model that varies a caption while re-running the same operation no longer
// collapses to one signature, so `loopDetector` will not stop it. That case is
// covered where it always actually was: the thrash ladder's DRIFT arms
// (`agent/v2/steps/pre-call-gates/thrash-gate.ts`) exist precisely to catch an
// agent that VARIES its signatures to dodge the gate — a one-shot nudge at 8
// iterations, a terminal block at 24 — with `MAX_TOOL_LOOPS` as the per-turn
// ceiling. Trading a false REFUSAL of genuine work for a slightly later stop on
// genuine spinning is the direction the owner has ruled on every time this has
// come up; the reverse trade is the one that reached production.
// ════════════════════════════════════════════════════════════════════════════

/** 32-bit FNV-1a, hex. Deterministic and dependency-free, and used ONLY to keep a
 *  length-capped value distinguishable from another value with the same head and
 *  the same length. Never a security hash. */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Above this many characters a value is CAPPED (never dropped). */
const LONG_VALUE_CHARS = 80;
/** The readable head kept in a capped value, so a human reading a log or a steer
 *  can still tell what the call was about. */
const VALUE_PREFIX_CHARS = 60;
/** Array items carried verbatim before the tail is folded into the digest. */
const ARRAY_HEAD_ITEMS = 5;

// D5 (2026-07-08 defect-class sweep): the "a successful mutating call is forward
// progress" predicate is not a hand list either. It lives at the
// detectTaskThrashing call site as classifyTool(name) === 'effectful-action',
// which expands correctly (creating a calendar event or uploading a file IS real
// work) and never drifts. MUTATING_TOOLS used to survive here for the signature
// carve-out alone; with no carve-out left, the set is gone.

/**
 * Build a canonical signature for a tool call, used to detect loops.
 *
 * The identity is the tool `name` plus EVERY argument it was given, keys sorted
 * so JSON ordering does not matter. Two normalizations survive, and each is
 * stated here because each one CAN make two different values compare equal:
 *
 *   1. RUNS OF 6+ DIGITS inside strings become `*`. The one deliberate collapse
 *      left, narrow and load-bearing: re-reading the same re-rendered artifact
 *      (`/tmp/render_1738422123_000.png` vs `…_1738422999_000.png`) is one
 *      operation, not two. RESIDUAL, NAMED: two genuinely DISTINCT all-numeric
 *      ids of 6+ digits also collapse. Nothing on the owner's live surface passes
 *      such an id (Gmail/Drive/Graph ids are alphanumeric), so this is kept as it
 *      was rather than moved in a fix that was not about it.
 *   2. VALUES LONGER THAN `LONG_VALUE_CHARS` are CAPPED, never dropped, to
 *      `head…[len=N#digest]` — a readable prefix, the exact length, and a digest
 *      of the WHOLE value. Two 500-character queries differing only at the tail
 *      therefore stay DISTINCT; the pre-2026-09-22 form kept `head…[len=N]` with
 *      no digest and did not. Over-long arrays keep their head and fold the tail
 *      into the same kind of digest, for the same reason.
 */
export function canonicalToolSignature(
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args) return `${name}:{}`;
  const scrubDigits = (s: string): string => s.replace(/\d{6,}/g, '*');
  const cap = (s: string): string =>
    s.length > LONG_VALUE_CHARS
      ? `${s.slice(0, VALUE_PREFIX_CHARS)}…[len=${s.length}#${fnv1a32(s)}]`
      : s;
  const normalized: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) {
    const v = args[k];
    if (typeof v === 'string') {
      normalized[k] = cap(scrubDigits(v));
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      normalized[k] = v;
    } else if (Array.isArray(v)) {
      const head: unknown[] = v.slice(0, ARRAY_HEAD_ITEMS).map((item: unknown) =>
        (typeof item === 'string' ? cap(scrubDigits(item)) : item));
      if (v.length > ARRAY_HEAD_ITEMS) {
        // The TAIL IS FOLDED IN, NOT DROPPED. Two 7-item arrays that share a
        // 5-item head are two different asks and must not share a signature —
        // the same defect the prose allow-list had, one type down.
        let tail: string;
        try { tail = JSON.stringify(v.slice(ARRAY_HEAD_ITEMS)); } catch { tail = `unserializable:${v.length}`; }
        head.push(`…[n=${v.length}#${fnv1a32(scrubDigits(tail))}]`);
      }
      normalized[k] = head;
    } else {
      try {
        normalized[k] = cap(scrubDigits(JSON.stringify(v)));
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
  // history_search thrashing) blocked legitimate batch operations, an agent
  // updating profiles on 6 sub-agents looked identical to a real loop.
  // The original target (history_search thrashing) is now handled by giving
  // history_search results their message IDs + a copy-pasteable
  // history_get(id="…") hint when truncated, so the agent has a clean
  // recovery path instead of needing to thrash. MAX_TOOL_LOOPS=75
  // remains as the per-turn ceiling for the truly-pathological case.
  return { decision: 'ok', signature, repeatCount: repeatCount + 1 };
}
