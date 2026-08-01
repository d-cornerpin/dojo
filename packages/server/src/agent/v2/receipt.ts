// ════════════════════════════════════════
// Context receipt — Phase 0 of the remediation plan.
//
// Records exactly what the model received on one loop iteration, after every
// injector and post-assembly mutation has run. The receipt is the instrument
// that turns "what did the model actually see?" from a theory into a fact,
// which is what makes every later deletion in the plan safe.
//
// Permanent, debug-gated: off by default, near-zero cost when off.
//
// Modes (config key `context_receipt_mode`; env DOJO_RECEIPT_MODE wins):
//   off  — no receipts (default)
//   meta — structure only: system-prompt block headings + sizes + hashes,
//          per-message shape (role, source, kinds, sizes). No content bodies,
//          so nothing sensitive is persisted.
//   full — meta plus verbatim system prompt and message bodies. Explicit
//          debugging only. Files stay local under ~/.dojo/receipts and are
//          never logged, broadcast, or embedded.
//
// Discipline: writes are fire-and-forget and NEVER throw into the turn.
// ════════════════════════════════════════

import fs from 'node:fs';
import { estimateTokensFromChars } from '../../memory/budget.js';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/connection.js';
import { A2A_INBOUND_RE, NEW_SESSION_BRACKET_RE, SOURCE_ENVELOPE_OPENER } from '@dojo/shared';
import { PART_JOINER } from '../../prompt/registry/types.js';
import { assemblyTokens } from '../../memory/assembly-validation.js';
import { POST_BUDGET_LANES, type AllocationReport } from '../../memory/lanes.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('context-receipt');

export type ReceiptMode = 'off' | 'meta' | 'full';

type LoopMessage = {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlockParam[];
};

export interface ReceiptInput {
  agentId: string;
  modelId: string;
  turnNumber: number;
  loopCount: number;
  systemPrompt: string;
  messages: LoopMessage[];
  /**
   * PHASE-3 T3: index of the FIRST message of the near-tail volatile lane
   * (`msg.turn-context` -> `msg.peer-status` -> `msg.current-time` and the one-shot engine
   * hints beside them). Everything BELOW it is the cacheable region and must be
   * append-only across calls; everything at or above it is volatile BY DESIGN and is
   * re-emitted after each turn's new rows. `check-message-prefix.mjs` could not tell the
   * two apart and therefore reported the designed shape as a broken prefix.
   */
  volatileFrom?: number;
  useTools: boolean;
  /** Registry path only: the entry id that produced each system-prompt part,
   *  aligned to the parts recovered by splitting on PART_JOINER. Attached to
   *  each part only when the count matches (so a misalignment from a later
   *  loop-side mutation is dropped rather than mislabeled). Omitted on the
   *  legacy path → receipt unchanged. */
  systemEntryIds?: (string | null)[];
  /**
   * The LANE that produced each message, aligned to `messages`. PHASE-3 T6 (F21) —
   * declared since the registry landed and assigned by nothing until now. `null` means no
   * lane claimed the message, which is a finding, not a hole to pattern-match over.
   */
  messageEntryIds?: (string | null)[];
  /**
   * F20: the allocator's own record — one grant per lane INCLUDING the rejected, the
   * truncated and the ones that rendered nothing, each with its reason in words. Before
   * this a section the budget dropped produced a byte-identical receipt to a section that
   * never existed (research 06 §8's own complaint).
   */
  allocation?: AllocationReport;
  /** F22: how many fresh-tail messages the assembler dropped to fit the window. */
  freshTailDropped?: number;
  /** F22: `systemVolatile.length`. The cache law says it stays 0; recording it is how a
   *  regression becomes visible per assembly instead of only at the next gate run. */
  systemVolatileChars?: number;
  /** What the assembly set aside for tool schemas + output (T4's measured reserve). */
  reserveTokens?: number;
}

const RECEIPTS_ROOT = path.join(os.homedir(), '.dojo', 'receipts');
const MAX_RECEIPTS_PER_AGENT = 200;
const MODE_CACHE_MS = 30_000;

let cachedMode: ReceiptMode = 'off';
let cachedModeAt = 0;
let writesSinceSweep = 0;

export function getReceiptMode(): ReceiptMode {
  const envMode = process.env.DOJO_RECEIPT_MODE;
  if (envMode === 'off' || envMode === 'meta' || envMode === 'full') return envMode;

  const now = Date.now();
  if (now - cachedModeAt < MODE_CACHE_MS) return cachedMode;
  cachedModeAt = now;
  try {
    const row = getDb()
      .prepare("SELECT value FROM config WHERE key = 'context_receipt_mode'")
      .get() as { value: string } | undefined;
    cachedMode = row?.value === 'meta' || row?.value === 'full' ? row.value : 'off';
  } catch {
    cachedMode = 'off';
  }
  return cachedMode;
}

// PHASE-3 T2: was an independent re-declaration of the /4 estimator (§T0-C #4). The
// receipt takes a CHAR COUNT rather than the text, so it adapts the one estimator instead
// of re-implementing it — the receipt must report the number the budget actually spent.
function estTokens(chars: number): number {
  return estimateTokensFromChars(chars);
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function summarizeSystemPrompt(
  systemPrompt: string,
  entryIds?: (string | null)[],
): Array<{
  heading: string;
  chars: number;
  estTokens: number;
  entryId?: string | null;
}> {
  // D16: IMPORTED from the shared taxonomy, never re-declared. `receipt.ts:63` held a
  // byte-identical private `PART_SEPARATOR`, so the receipt could have gone on splitting on
  // a string the assembler had stopped writing and reported one part as the whole prompt.
  const parts = systemPrompt.split(PART_JOINER);
  const aligned = entryIds && entryIds.length === parts.length;
  return parts.map((part, i) => {
    const firstLine = part.split('\n').find((l) => l.trim().length > 0) ?? '';
    return {
      heading: firstLine.trim().slice(0, 100),
      chars: part.length,
      estTokens: estTokens(part.length),
      ...(aligned ? { entryId: entryIds![i] } : {}),
    };
  });
}

// Engine/source tags that classify where a synthetic user-role message came
// from. Read-only pattern sniffing; if none match, the message is organic.
//
// ── PHASE-3 T5: THE ORDER WAS THE DEFECT (research 06 §5) ──────────────────────────────
// `'[SOURCE:'` was tested BEFORE `'[A2A:'`, and this list is first-match-wins. A legacy
// A2A row (`[SOURCE: AGENT MESSAGE FROM …`, `[SOURCE: GROUP BROADCAST FROM …`) therefore
// tagged `source-tagged` and could NEVER tag `a2a` — the receipt said "an envelope" about
// a row that was peer traffic, and the one field a reader would use to count A2A in a
// context was structurally incapable of counting the legacy half of it.
//
// The fix is not "move one line up": the A2A test now uses the shared matcher, which knows
// all four inbound forms, and it runs FIRST. The generic `[SOURCE:` opener stays as the
// catch-all BELOW it, which is the only order in which both are true.
//
// The `new-session-marker` test also gained its closer. It was `startsWith('[New Session')`
// with nothing after it — `platform-noise.ts` required `[New Session]` and this required
// no bracket at all, so the two disagreed about `[New Sessions are great]` AND about the
// dated `[New Session: …]` form. One matcher now.
const SOURCE_PATTERNS: Array<{ tag: string; test: (s: string) => boolean }> = [
  { tag: 'a2a', test: (s) => A2A_INBOUND_RE.test(s) },
  { tag: 'source-tagged', test: (s) => s.startsWith(SOURCE_ENVELOPE_OPENER) },
  { tag: 'engine-hint', test: (s) => s.startsWith('[Engine hint') },
  { tag: 'engine-note', test: (s) => s.startsWith('[Engine note') },
  { tag: 'engine-ack', test: (s) => s.startsWith('[Engine ack') },
  { tag: 'engine-other', test: (s) => s.startsWith('[ENGINE') || s.startsWith('[Engine') },
  { tag: 'system-note', test: (s) => s.startsWith('[System note') },
  { tag: 'dojo-technique-wrap', test: (s) => s.startsWith('[DOJO') },
  { tag: 'new-session-marker', test: (s) => NEW_SESSION_BRACKET_RE.test(s) },
];

// PHASE-3 T6 (F23): THE LANE IS THE ANSWER; THE PATTERNS ARE THE FALLBACK.
// Every message now carries the lane that emitted it, including the six raw engine
// injections that had no marker prose to sniff and therefore reported as `organic` —
// research 06 §8 names four of them (RECENT OUTBOUND, RECENTLY ANSWERED, open-loops, the
// settled hint) and there are six. A tagged message reports its lane; only a message NO
// lane claimed falls through to the prose sniffing, and `organic` finally means what it
// says: content nobody in the engine put there.
function classifySource(text: string, laneId: string | null): string {
  if (laneId) return laneId;
  for (const p of SOURCE_PATTERNS) {
    if (p.test(text)) return p.tag;
  }
  return 'organic';
}

function summarizeMessage(msg: LoopMessage, mode: ReceiptMode, laneId: string | null): Record<string, unknown> {
  if (typeof msg.content === 'string') {
    const out: Record<string, unknown> = {
      role: msg.role,
      kind: 'text',
      source: msg.role === 'user' ? classifySource(msg.content, laneId) : undefined,
      chars: msg.content.length,
      estTokens: estTokens(msg.content.length),
      techniqueWrap: msg.content.includes('--- TECHNIQUE:'),
    };
    if (mode === 'full') out.content = msg.content;
    return out;
  }

  const blockKinds: Record<string, number> = {};
  let textChars = 0;
  let techniqueWrap = false;
  for (const block of msg.content) {
    const kind = typeof block === 'object' && block !== null && 'type' in block
      ? String((block as { type: unknown }).type)
      : 'unknown';
    blockKinds[kind] = (blockKinds[kind] ?? 0) + 1;
    if (kind === 'text' && 'text' in (block as object)) {
      const text = String((block as { text: unknown }).text ?? '');
      textChars += text.length;
      // Role-merging can fold the technique-wrapped live ask into a blocks
      // message (e.g. after a tool_result), so the wrap must be detected
      // here too, not just on string-content messages.
      if (text.includes('--- TECHNIQUE:') || text.startsWith('[DOJO:')) techniqueWrap = true;
    }
  }
  const out: Record<string, unknown> = {
    role: msg.role,
    kind: 'blocks',
    blocks: blockKinds,
    textChars,
    estTokens: estTokens(textChars),
    hasImages: (blockKinds.image ?? 0) > 0,
    techniqueWrap,
  };
  if (mode === 'full') out.content = msg.content;
  return out;
}

/**
 * `lane.loop-tail` is DECLARED by the assembler and FILLED by the loop, so the assembler's
 * own report can only ever say "did not fire on this turn" about it — which the lane table
 * printed while three loop-tail entries sat in the same receipt. The receipt is written
 * after the tail-append and knows where it starts (`volatileFrom`), so it is the one place
 * that can state the truth. Measured, never estimated; the grants array is COPIED rather
 * than mutated, because the report belongs to the assembly and recording must not change it.
 *
 * The one thing this cannot see is the settled hint when it FOLDS into an existing string
 * tail instead of pushing its own message: those characters are below `volatileFrom` and
 * count against the lane that owns that message. Stated because it is a real edge, not
 * because it is large (65 tokens at its measured maximum).
 */
function withMeasuredLoopTail(input: ReceiptInput): AllocationReport['grants'] {
  const grants = input.allocation?.grants ?? [];
  const from = input.volatileFrom;
  if (typeof from !== 'number' || from < 0 || from > input.messages.length) return grants;
  const tail = input.messages.slice(from);
  if (tail.length === 0) return grants;
  const tokens = assemblyTokens(tail);
  const reserve = POST_BUDGET_LANES.find((l) => l.id === 'lane.loop-tail')?.reserveTokens ?? 0;
  const ids = [...new Set((input.messageEntryIds ?? []).slice(from).map((x) => x ?? '(untagged)'))];
  return grants.map((g) => (g.id !== 'lane.loop-tail' ? g : {
    ...g,
    requested: tokens,
    granted: tokens,
    status: 'admitted' as const,
    reason: `loop tail-append, MEASURED at the receipt boundary: ${tail.length} message(s) ` +
      `(${ids.join(', ')}) costing ${tokens} tokens against the ${reserve}-token reserve ` +
      `lanes.ts declares` + (tokens > reserve ? ' — OVER' : ''),
  }));
}

/**
 * Fire-and-forget. Call at the callModel site, after ALL mutations, so the
 * receipt reflects precisely what the provider request will contain.
 */
export function writeContextReceipt(input: ReceiptInput): void {
  try {
    const mode = getReceiptMode();
    if (mode === 'off') return;

    const messagesSerialized = JSON.stringify(input.messages);
    const record = {
      v: 1,
      mode,
      at: new Date().toISOString(),
      agentId: input.agentId,
      modelId: input.modelId,
      turnNumber: input.turnNumber,
      loopCount: input.loopCount,
      useTools: input.useTools,
      systemPrompt: {
        chars: input.systemPrompt.length,
        estTokens: estTokens(input.systemPrompt.length),
        sha256: sha256(input.systemPrompt),
        parts: summarizeSystemPrompt(input.systemPrompt, input.systemEntryIds),
        ...(mode === 'full' ? { content: input.systemPrompt } : {}),
      },
      // ── THE ALLOCATOR RECEIPT (F20/F22) ────────────────────────────────────────────────
      // Every lane's `{requested, granted, status, reason}`, THREADED from the allocator's
      // own `AllocationReport` (`memory/lanes.ts`) — never recomputed here. A second
      // derivation of the same decision is how a receipt comes to disagree with the
      // assembly it is supposed to be evidence of.
      assembly: {
        freshTailDropped: input.freshTailDropped ?? null,
        systemVolatileChars: input.systemVolatileChars ?? null,
        reserveTokens: input.reserveTokens ?? null,
        // The array's cost by the ONE estimator, measured through the VALIDATOR's own
        // function at the last point before the provider call. Between here and the wire
        // sits only the pairing repair, which never adds a block and logs whenever it
        // removes one — so this is the post-validation total in `detect` mode, and when
        // Step 2b flips to `repair` the validator logs its own before → after beside it.
        tokenTotalAtBoundary: assemblyTokens(input.messages),
        ...(input.allocation
          ? {
              budgetTokens: input.allocation.budgetTokens,
              reservedTokens: input.allocation.reservedTokens,
              spentTokens: input.allocation.spentTokens,
              offTheTopTokens: input.allocation.offTheTopTokens,
              admittedIds: input.allocation.admittedIds,
              overBudget: input.allocation.overBudget,
              lanes: withMeasuredLoopTail(input),
            }
          : { lanes: null }),
      },
      messages: {
        volatileFrom: input.volatileFrom ?? null,
        count: input.messages.length,
        chars: messagesSerialized.length,
        estTokens: estTokens(messagesSerialized.length),
        sha256: sha256(messagesSerialized),
        items: input.messages.map((m, i) => {
          const laneId = input.messageEntryIds?.[i] ?? null;
          const summary = summarizeMessage(m, mode, laneId);
          // KIT-HARDENING K10(a). The whole-array hash above says THAT the
          // array changed; it cannot say WHERE. A hash per message lets the kit
          // diff two consecutive receipts and report the longest identical
          // prefix plus the first entry that diverged — which is the only
          // direct evidence of whether the cached prefix survived the turn.
          // Read-only: this observes the array, it never reorders or edits it,
          // so it cannot itself move the prefix it exists to watch.
          summary.sha256 = sha256(JSON.stringify(m));
          // The length guard is GONE, and its removal is the point of T6: the ids are now
          // read off the same array in the same statement (`collectMessageLaneIds`), so a
          // count disagreement is no longer expressible and dropping the ids on one would
          // only hide a bug. `null` is a real answer — no lane claimed this message.
          summary.entryId = laneId;
          return summary;
        }),
      },
    };

    const dir = path.join(RECEIPTS_ROOT, input.agentId);
    const file = path.join(
      dir,
      `${Date.now()}-t${input.turnNumber}-i${input.loopCount}.json`,
    );

    void fs.promises
      .mkdir(dir, { recursive: true })
      .then(() => fs.promises.writeFile(file, JSON.stringify(record, null, 2), 'utf-8'))
      .then(() => {
        writesSinceSweep += 1;
        if (writesSinceSweep >= 20) {
          writesSinceSweep = 0;
          return sweepOldReceipts(dir);
        }
        return undefined;
      })
      .catch((err) => {
        logger.debug('receipt write failed', {
          agentId: input.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  } catch (err) {
    // Receipts must never affect the turn.
    logger.debug('receipt build failed', {
      agentId: input.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function sweepOldReceipts(dir: string): Promise<void> {
  try {
    const files = (await fs.promises.readdir(dir))
      .filter((f) => f.endsWith('.json'))
      .sort(); // timestamp-prefixed names sort oldest-first
    const excess = files.length - MAX_RECEIPTS_PER_AGENT;
    if (excess <= 0) return;
    await Promise.all(
      files.slice(0, excess).map((f) => fs.promises.unlink(path.join(dir, f)).catch(() => {})),
    );
  } catch {
    // best-effort
  }
}
