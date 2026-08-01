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
  useTools: boolean;
  /** Registry path only: the entry id that produced each system-prompt part,
   *  aligned to the parts recovered by splitting on PART_SEPARATOR. Attached to
   *  each part only when the count matches (so a misalignment from a later
   *  loop-side mutation is dropped rather than mislabeled). Omitted on the
   *  legacy path → receipt unchanged. */
  systemEntryIds?: (string | null)[];
  /** Registry path only: the entry id per message, aligned to `messages`. */
  messageEntryIds?: (string | null)[];
}

const RECEIPTS_ROOT = path.join(os.homedir(), '.dojo', 'receipts');
const MAX_RECEIPTS_PER_AGENT = 200;
const MODE_CACHE_MS = 30_000;
// The assembler joins its parts[] with this separator (prompt/assembler.ts).
// Splitting on it recovers the block structure without touching the assembler.
const PART_SEPARATOR = '\n\n---\n\n';

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
  const parts = systemPrompt.split(PART_SEPARATOR);
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
const SOURCE_PATTERNS: Array<{ tag: string; test: (s: string) => boolean }> = [
  { tag: 'source-tagged', test: (s) => s.startsWith('[SOURCE:') },
  { tag: 'a2a', test: (s) => s.startsWith('[A2A:') },
  { tag: 'engine-hint', test: (s) => s.startsWith('[Engine hint') },
  { tag: 'engine-note', test: (s) => s.startsWith('[Engine note') },
  { tag: 'engine-ack', test: (s) => s.startsWith('[Engine ack') },
  { tag: 'engine-other', test: (s) => s.startsWith('[ENGINE') || s.startsWith('[Engine') },
  { tag: 'system-note', test: (s) => s.startsWith('[System note') },
  { tag: 'dojo-technique-wrap', test: (s) => s.startsWith('[DOJO') },
  { tag: 'new-session-marker', test: (s) => s.startsWith('[New Session') },
];

function classifySource(text: string): string {
  for (const p of SOURCE_PATTERNS) {
    if (p.test(text)) return p.tag;
  }
  return 'organic';
}

function summarizeMessage(msg: LoopMessage, mode: ReceiptMode): Record<string, unknown> {
  if (typeof msg.content === 'string') {
    const out: Record<string, unknown> = {
      role: msg.role,
      kind: 'text',
      source: msg.role === 'user' ? classifySource(msg.content) : undefined,
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
      messages: {
        count: input.messages.length,
        chars: messagesSerialized.length,
        estTokens: estTokens(messagesSerialized.length),
        sha256: sha256(messagesSerialized),
        items: input.messages.map((m, i) => {
          const summary = summarizeMessage(m, mode);
          // KIT-HARDENING K10(a). The whole-array hash above says THAT the
          // array changed; it cannot say WHERE. A hash per message lets the kit
          // diff two consecutive receipts and report the longest identical
          // prefix plus the first entry that diverged — which is the only
          // direct evidence of whether the cached prefix survived the turn.
          // Read-only: this observes the array, it never reorders or edits it,
          // so it cannot itself move the prefix it exists to watch.
          summary.sha256 = sha256(JSON.stringify(m));
          if (input.messageEntryIds && input.messageEntryIds.length === input.messages.length) {
            summary.entryId = input.messageEntryIds[i];
          }
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
