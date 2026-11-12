// Context receipt: what the model actually received on one loop iteration, after every
// injector and post-assembly mutation has run. Debug-gated and off by default: `meta`
// records headings, sizes and hashes only, `full` adds verbatim bodies. Writes are
// fire-and-forget and NEVER throw into the turn; files stay under ~/.dojo/receipts, never logged.

import fs from 'node:fs';
import { estimateTokensFromChars } from '../../memory/budget.js';
import path from 'node:path';
import crypto from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/connection.js';
import { A2A_INBOUND_RE, NEW_SESSION_BRACKET_RE, SOURCE_ENVELOPE_OPENER } from '@dojo/shared';
import { PART_JOINER } from '../../prompt/registry/types.js';
import { getFilteredTools } from '../tools/surface.js';
import { filterToolsForApiCall, getAgentAlwaysLoadedTools } from '../../tools/tool-docs.js';
import { assemblyTokens } from '../../memory/assembly-validation.js';
import { POST_BUDGET_LANES, type AllocationReport } from '../../memory/lanes.js';
import { createLogger } from '../../logger.js';
import { homeDir } from '../../home.js';

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
  /** Index of the first near-tail volatile message: below it the region is cacheable and
   *  append-only; at or above it messages are volatile by design, re-emitted each turn. */
  volatileFrom?: number;
  useTools: boolean;
  /** The entry id behind each system-prompt part, aligned to the PART_JOINER split;
   *  attached only when the counts match, so a loop-side misalignment is dropped, not mislabeled. */
  systemEntryIds?: (string | null)[];
  /** The LANE that produced each message, aligned to `messages`; `null` means no lane
   *  claimed it, which is a finding in its own right, not a hole to pattern over. */
  messageEntryIds?: (string | null)[];
  /** The allocator's own record: one grant per lane INCLUDING rejected, truncated and
   *  no-rendered, each with its reason; a dropped section must not look like an absent one. */
  allocation?: AllocationReport;
  /** How many fresh-tail messages the assembler dropped to fit the window. */
  freshTailDropped?: number;
  /** The cache law says this stays 0; recording it makes a regression visible per assembly. */
  systemVolatileChars?: number;
  reserveTokens?: number;
}

/** Resolved per call, never cached at module load: a test that redirects `HOME` must get
 *  the redirected path, and every durable sink must follow this rule. */
function receiptsRoot(): string {
  return path.join(homeDir(), '.dojo', 'receipts');
}
const MAX_RECEIPTS_PER_AGENT = 200;
const MODE_CACHE_MS = 30_000;

let cachedMode: ReceiptMode = 'off';
let cachedModeAt = 0;
let writesSinceSweep = 0;

// The mode is process-global, cached for 30s and can flip under the turn, so every
// TRANSITION is announced once and a failed write warns: this instrument must never die silently.

type ReceiptModeSource = 'env' | 'config';

let lastAnnouncedMode: ReceiptMode | null = null;

/** The resolved mode plus where it came from: the env override wins, else the config row. */
function resolveReceiptMode(): { mode: ReceiptMode; source: ReceiptModeSource } {
  const envMode = process.env.DOJO_RECEIPT_MODE;
  if (envMode === 'off' || envMode === 'meta' || envMode === 'full') {
    return { mode: envMode, source: 'env' };
  }

  const now = Date.now();
  if (now - cachedModeAt < MODE_CACHE_MS) return { mode: cachedMode, source: 'config' };
  cachedModeAt = now;
  try {
    const row = getDb()
      .prepare("SELECT value FROM config WHERE key = 'context_receipt_mode'")
      .get() as { value: string } | undefined;
    cachedMode = row?.value === 'meta' || row?.value === 'full' ? row.value : 'off';
  } catch {
    cachedMode = 'off';
  }
  return { mode: cachedMode, source: 'config' };
}

export function getReceiptMode(): ReceiptMode {
  const { mode, source } = resolveReceiptMode();
  // Once per change, never per call: this only speaks when the answer differs from last
  // time, and the 30s cache above already throttles the read.
  if (mode !== lastAnnouncedMode) {
    const from = lastAnnouncedMode;
    lastAnnouncedMode = mode;
    if (mode === 'off') {
      logger.info('context receipts are OFF — no record of what any model is being sent will be written from here on. Nothing is broken; this is the shipped default and the state a tool that borrowed the switch restores it to', {
        from, source,
      });
    } else {
      logger.info('context receipts are ON — every model call from here on records what the model was sent', {
        from, mode, source, root: receiptsRoot(),
      });
    }
  }
  return mode;
}

// The receipt reports tokens through the ONE estimator: its number is what the budget spent.
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
  // Split on the IMPORTED joiner, never a private copy, so the split tracks what the assembler writes.
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

// Engine/source tags for synthetic user-role messages; if none match, the message is organic.
// First-match-wins order is load-bearing: the shared A2A matcher runs FIRST and the generic
// `[SOURCE:` opener stays as the catch-all below it, or legacy A2A rows would mis-tag.
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

// The lane that emitted a message is the answer; prose sniffing is only the fallback for
// messages no lane claimed, so `organic` means content nobody in the engine put there.
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
      // Role-merging can fold the technique-wrapped live ask into a blocks message,
      // so the wrap must be detected here too, not just on string-content messages.
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

/** The registry entry the deliveries lane emits under. Its tokens belong to `lane.deliveries`,
 *  which declares its own reserve, and not to the loop tail it sits inside. */
const DELIVERIES_ENTRY_ID = 'msg.deliveries';
/** The recall lane, the same split for the same reason: it declares its own reserve. It emits
 *  TWO messages (snapshot then per-ask retrieval), so both ids count and the sum is measured. */
const RECALL_ENTRY_IDS = new Set(['msg.relevant-memory', 'engine.open-commitments']);
const HISTORY_IDS = new Set(['lane.fresh-tail', 'lane.pm-tail']);

function toolNameLists(agentId: string): Record<string, string | number> | null {
  try {
    const permitted = getFilteredTools(agentId);
    const sent = filterToolsForApiCall(agentId, permitted, getAgentAlwaysLoadedTools(agentId)).map((t) => t.name);
    const names = permitted.map((t) => t.name);
    return { permittedSha256: sha256(names.join('\n')), permittedCount: names.length, sentSha256: sha256(sent.join('\n')), sentCount: sent.length };
  } catch { return null; }
}

/** The loop tail is DECLARED by the assembler but FILLED by the loop, so only the receipt,
 *  written after the tail-append, can measure it. Grants are COPIED, never mutated. */
function withMeasuredLoopTail(input: ReceiptInput): AllocationReport['grants'] {
  const grants = input.allocation?.grants ?? [];
  const from = input.volatileFrom;
  if (typeof from !== 'number' || from < 0 || from > input.messages.length) return grants;
  const tail = input.messages.slice(from);
  if (tail.length === 0) return grants;
  const tailIds = (input.messageEntryIds ?? []).slice(from);
  // The deliveries lane has its OWN reserve, so its tokens are attributed to it and taken
  // OUT of the loop tail's measurement, or the same tokens would be reported twice.
  const isDeliveries = (i: number) => tailIds[i] === DELIVERIES_ENTRY_ID;
  const isRecall = (i: number) => RECALL_ENTRY_IDS.has(tailIds[i] ?? '');
  // An appended call's tail holds the turn's own conversation rows too; they are not loop tail.
  const isOwnReserve = (i: number) => isDeliveries(i) || isRecall(i) || HISTORY_IDS.has(tailIds[i] ?? '');
  const deliveries = tail.filter((_, i) => isDeliveries(i));
  const recall = tail.filter((_, i) => isRecall(i));
  const rest = tail.filter((_, i) => !isOwnReserve(i));
  const measured = (
    id: string,
    msgs: typeof tail,
    ids: Array<string | null | undefined>,
    label: string,
  ) => {
    const tokens = assemblyTokens(msgs);
    const reserve = (POST_BUDGET_LANES.find((l) => l.id === id)?.reserveTokens ?? 0) + (id === 'lane.loop-tail' ? input.allocation?.loopTailExtraTokens ?? 0 : 0);
    const names = [...new Set(ids.map((x) => x ?? '(untagged)'))];
    return {
      requested: tokens,
      granted: tokens,
      status: 'admitted' as const,
      reason: `${label}, MEASURED at the receipt boundary: ${msgs.length} message(s) ` +
        `(${names.join(', ')}) costing ${tokens} tokens against the ${reserve}-token reserve ` +
        `lanes.ts declares` + (tokens > reserve ? ' — OVER' : ''),
    };
  };
  return grants.map((g) => {
    if (g.id === 'lane.loop-tail' && rest.length > 0) {
      return { ...g, ...measured('lane.loop-tail', rest, tailIds.filter((_, i) => !isOwnReserve(i)), 'loop tail-append') };
    }
    if (g.id === 'lane.deliveries' && deliveries.length > 0) {
      return { ...g, ...measured('lane.deliveries', deliveries, [DELIVERIES_ENTRY_ID], 'deliveries lane') };
    }
    if (g.id === 'lane.relevant-memory' && recall.length > 0) {
      return { ...g, ...measured('lane.relevant-memory', recall, tailIds.filter((_, i) => isRecall(i)), 'recall lane') };
    }
    return g;
  });
}

/** Fire-and-forget, with exactly one production call site, immediately before every provider
 *  call. Call at the callModel site, after ALL mutations: the receipt is the request. */
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
      tools: input.useTools ? toolNameLists(input.agentId) : null,
      systemPrompt: {
        chars: input.systemPrompt.length,
        estTokens: estTokens(input.systemPrompt.length),
        sha256: sha256(input.systemPrompt),
        parts: summarizeSystemPrompt(input.systemPrompt, input.systemEntryIds),
        ...(mode === 'full' ? { content: input.systemPrompt } : {}),
      },
      // Every lane's grant, THREADED from the allocator's own report, never recomputed here,
      // so the receipt cannot disagree with the assembly.
      assembly: {
        freshTailDropped: input.freshTailDropped ?? null,
        systemVolatileChars: input.systemVolatileChars ?? null,
        reserveTokens: input.reserveTokens ?? null,
        // Token cost through the VALIDATOR's own estimator, at the last point before the provider call.
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
          // A hash per message says WHERE two consecutive receipts first diverge, the direct
          // evidence of whether the cached prefix survived. Read-only.
          summary.sha256 = sha256(JSON.stringify(m));
          // Read off the same array, so no length guard; `null` is a real answer: no lane claimed it.
          summary.entryId = laneId;
          return summary;
        }),
      },
    };

    const dir = path.join(receiptsRoot(), input.agentId);
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
      // WARN, not debug: an ENABLED instrument writing nothing is exactly the silence this
      // must end, and the turn stays untouched: receipts are still fire-and-forget.
      .catch((err) => {
        logger.warn('context receipts are ON and this receipt COULD NOT BE WRITTEN — the record of what the model was sent is being lost for every call while this persists', {
          agentId: input.agentId, mode, file, error: err instanceof Error ? err.message : String(err),
        });
      });
  } catch (err) {
    // Receipts must never affect the turn, but they must not fail invisibly either.
    logger.warn('context receipts are ON and this receipt COULD NOT BE BUILT — the record of what the model was sent is being lost for every call while this persists', {
      agentId: input.agentId, error: err instanceof Error ? err.message : String(err),
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
