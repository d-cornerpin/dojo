// ════════════════════════════════════════
// v2 control shell — runV2Turn
//
// The entire agent runtime. ~400 line target. Replaces v1's 2055-line
// runAgentLoop. Phase 2 implementation: real behavior wired throughout.
//
// Per Part XIX (preservation contract), every v1-visible behavior must
// work identically — see agent/v2/PRESERVATION_CHECKLIST.md.
//
// Phase 2 covers:
//   ✓ All 7 phases as real functions
//   ✓ All 14 Phase-1 classifiers wired
//   ✓ TRUE streaming (chunks broadcast immediately, not buffered)
//   ✓ complete_task / image_create loop exit
//   ✓ Status heartbeat preserved
//   ✓ Stop / preempt preserved (via shared-state)
//   ✓ Cost recording + embedding queueing preserved
//   ✓ chat:tool_call / chat:tool_result / chat:message broadcasts preserved
//   ✓ Synthetic Cancelled tool results when stopped mid-batch
//   ✓ Engine-injected ack (via ackInjector)
//   ✓ Tool partitioning (safe → parallel, others → serial)
//   ✓ Loop break detection (via loopDetector)
//   ✓ Permission denial nudging (via permissionAlternativeFinder)
//   ✓ Tracker enforcement (engine-side, no tool_use in context)
//   ✓ Spinning detection with model nudge (via progressClassifier)
//
// Deferred to later phases (with TODO markers in-line):
//   • Phase 3.5 — large-files.ts deletion + file_read offset/limit
//   • Phase 4 — compaction defaults change + scaffolding cuts
//   • Phase 5 — system prompt diet
//   • Phase 6 — full unified error cascade (Dreamer special case, etc.)
//   • Phase 7 — squad shared memory namespaces
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import type Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../logger.js';
import { getDb } from '../../db/connection.js';
import { broadcast } from '../../gateway/ws.js';
import type { Message, ToolCall } from '@dojo/shared';

import { assembleContext } from '../../memory/assembler.js';
import { callModel, getContextWindow } from '../model.js';
import { executeTool } from '../tools.js';
// recordError intentionally NOT imported — handleMessage's catch path calls
// it. Calling here would double-count errors and trip the loop-detector
// pause prematurely.
import { AgentError, clearErrors } from '../errors.js';
import { checkTimeouts } from '../spawner.js';
import {
  isAwaitingIMResponse,
  clearIMResponseFlag,
  getInboundSenderFor,
  addressesMatch,
} from '../../services/imessage-bridge.js';
import {
  getGmailSafeSenders,
  getOutlookSafeSenders,
  getTeamsSafeSenders,
} from '../../services/channel-safe-senders.js';
// recordCost intentionally NOT imported — callModel records cost internally.
import { queueEmbedding } from '../../memory/embeddings.js';
import { isPrimaryAgent, isTrainerAgent, isPMAgent } from '../../config/platform.js';
import os from 'node:os';
import path from 'node:path';
import { turnBoundary } from '../turn-state.js';

import {
  stoppedAgents,
  preemptedAgents,
  activeAbortControllers,
  pendingWakeups,
  statusHeartbeats,
  turnContinuationCounts,
  recoveryRunStreak,
  backgroundDrains,
} from '../shared-state.js';

// Force-import side-effect: also register the runtime singleton getter so v2
// can fire self-continuation handleMessage() calls (matches v1 behavior).
import { getAgentRuntime } from '../runtime.js';

import {
  type AgentTurnState,
  initState,
  advance,
  bumpLoopSignature,
  nextOutputEscalation,
} from './state.js';

import { partitionTools, type ToolBatch } from './classifiers/concurrency.js';
import { loopDetector, RECENT_TOOL_WINDOW, canonicalToolSignature } from './classifiers/loop.js';
import {
  isLoadingTool,
  isStructuringTool,
  buildHoardingRefusal,
  LOADING_GATE_THRESHOLD,
} from './classifiers/hoarding.js';
// ackInjector intentionally NOT imported — engine ack disabled per invariant
// review (see "Engine-injected ack — DISABLED" comment below).
import { trackerEnforcer } from './classifiers/tracker.js';
import { compactionGate } from './classifiers/compaction.js';
import { checkAndCompact, estimateAssembledTokens, getUncompactedGapCount, UNCOMPACTED_GAP_THRESHOLD } from '../../memory/compaction.js';
import { a2aReplyEnforcer, parseA2ATrigger } from './classifiers/a2a.js';
import { findUnrepliedAssignForAgent, hasPriorReplyOnThread } from '../a2a-replies.js';
import { outputTruncationClassifier, outputPersistenceClassifier, sanitizeAssistantText } from './classifiers/output.js';
import { progressClassifier, buildSpinningNudge } from './classifiers/progress.js';
import { permissionAlternativeFinder } from './classifiers/permission.js';
import { techniqueMatcher } from './classifiers/technique.js';
import { listTechniques } from '../../techniques/store.js';

const logger = createLogger('v2-loop');

// Fire-and-forget media generators. Each posts a "started" ack and delivers
// the finished asset later as a synthetic message (from a background worker
// or poller), so the agent must NOT get a second turn — the loop exits
// immediately after one of these is called. This is the engine-enforced
// version of the tool result's "end your turn now" instruction, so a
// disobedient model can't retry-storm.
const FIRE_AND_FORGET_GEN_TOOLS = new Set([
  'image_create',
  'tts_create',
  'music_create',
  'video_create',
]);

// v2.5.9 — Just-in-time visibility hint helper.
//
// When a tool result contains content the user will not see (URLs the
// agent might want to share, file paths from the shared uploads dir),
// append a small informational note so the agent knows the user can't
// read its tool results directly. The note is intentionally NEUTRAL —
// it doesn't tell the agent it MUST surface anything, just clarifies the
// visibility model. The agent retains full discretion about what to
// share, what to summarize, and what to keep internal.
//
// Trade-off: ~50 tokens per triggering tool result, vs. spending the
// same tokens in the system prompt every turn whether or not relevant.
const VISIBILITY_HINT = `\n\n[VISIBILITY: tool results are shown only to you, not to the user. The user sees only your reply text and any files you attach via show_to_user. If you want them to have a URL or detail from this result, include it inline in your reply — they cannot "see above". If there's nothing here worth surfacing, no action needed.]`;

// Match http(s) URLs OR file paths under the shared uploads dir.
// Conservative: only triggers on patterns that are typically things the
// agent might want to surface, not generic mentions of paths/URLs.
const VISIBILITY_TRIGGER_RE = /https?:\/\/\S+|[~/]\.dojo\/uploads\//;

// v2.7.8 — anti-hoarding gate carve-out.
//
// Returns true when the trainer agent is reading a file or directory
// INSIDE its own ~/.dojo/techniques tree. Those reads are the trainer's
// core job — auditing scripts, cross-checking TECHNIQUE.md, reviewing
// supporting files — and counting them against the hoarding-gate
// budget produces nonsense like "open a tracker project before you can
// look at your own technique's files." Other agents, other paths, and
// trainer reads OUTSIDE the techniques tree still count normally.
const TECHNIQUES_ROOT = path.join(os.homedir(), '.dojo', 'techniques');
function isTrainerOwnTechniquesRead(
  agentId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
): boolean {
  if (!isTrainerAgent(agentId)) return false;
  if (toolName !== 'file_read' && toolName !== 'file_list') return false;
  const rawPath = typeof args?.path === 'string' ? args.path : null;
  if (!rawPath) return false;
  // Resolve ~ before the prefix check — the trainer often passes
  // ~/.dojo/techniques/... and a literal startsWith on the resolved
  // root would miss it.
  const resolved = rawPath.startsWith('~') ? path.join(os.homedir(), rawPath.slice(1)) : rawPath;
  return resolved.startsWith(TECHNIQUES_ROOT + path.sep) || resolved === TECHNIQUES_ROOT;
}

function appendVisibilityHintIfRelevant<T extends { content?: string; isError?: boolean }>(toolResult: T): T {
  // Skip on errors — error messages aren't artifacts to share.
  if (toolResult.isError) return toolResult;
  const content = toolResult.content;
  if (typeof content !== 'string' || !content) return toolResult;
  if (!VISIBILITY_TRIGGER_RE.test(content)) return toolResult;
  return { ...toolResult, content: content + VISIBILITY_HINT };
}

// v2.7.22 — Soft nudge after internal-bookkeeping tools. These tools
// (vault_remember, tracker_update_status, complete_task, credential_*,
// etc.) reliably trigger the model's "wrap up with a closeout line"
// reflex even though the prompt teaches [no-reply] as the escape
// hatch. The prompt sits at the top of the context; the tool result
// sits at the bottom right next to the model's next decision. This
// nudge appends a one-line reminder INSIDE the tool result so the
// escape hatch is in the model's face at the exact moment it would
// otherwise default to "All set." or "Done."
//
// Soft, not destructive: we don't strip anything; we only inform.
// The model still chooses. If a substantive reply is warranted (user
// asked a real question, work isn't done, etc.), it can ignore the
// nudge and write whatever it wants. Same machinery as the visibility
// hint above — append-on-condition, no behavior change to the tool.
const BOOKKEEPING_NUDGE_TOOLS = new Set([
  'tracker_update_status',
  'tracker_complete_step',
  'complete_task',
  'vault_remember',
  'vault_update',
  'vault_forget',
  'credential_add',
  'credential_update',
  'credential_delete',
]);

const BOOKKEEPING_NUDGE = `\n\n[Engine note: this was internal bookkeeping. If the user already has the answer they needed (or didn't ask one), end the turn with literal \`[no-reply]\` instead of writing a closeout line like "Done." / "All set." / "Got it." — silent turns are first-class and the right outcome here.]`;

function appendBookkeepingNudgeIfRelevant<T extends { name?: string; content?: string; isError?: boolean }>(toolResult: T): T {
  if (toolResult.isError) return toolResult;
  if (!toolResult.name || !BOOKKEEPING_NUDGE_TOOLS.has(toolResult.name)) return toolResult;
  const content = toolResult.content;
  if (typeof content !== 'string') return toolResult;
  return { ...toolResult, content: content + BOOKKEEPING_NUDGE };
}

const STATUS_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_TOOL_LOOPS = 75;                     // matches v1
const TURN_TIME_BUDGET_MS = 15 * 60 * 1000;    // matches v1 — 15 min/turn
const MAX_TURN_AUTO_CONTINUATIONS = 3;         // matches v1
const ACK_DEFAULT_TEXT = 'Working on it…';

// ── Task-thrash detector ──
// Catches the "agent re-runs the SAME canonical tool call over and over"
// pattern.
//
// Signature semantics matter: reading 20 unique messages each once is NOT
// thrashing (the task asks for it). Reading the SAME message 4 times is.
// We key on canonicalToolSignature so a model that varies one parameter
// (limit=1000 vs no limit) doesn't slip past, but distinct args = distinct
// signatures = no false positive on legitimate iteration.
//
// REACTION (rewritten): instead of pausing the task and walking away
// (which strands work and forces the user to manually intervene), we
// inject a specific steer message naming the exact gated signature and
// activate a per-signature refusal gate. The agent can still call the
// same tool with DIFFERENT args. Only the exact spinning signature is
// refused. Cleared on any tracker_update_status.
//
// LAST RESORT: if the gate has had to refuse THRASH_GATE_BREAKER_LIMIT+
// calls without the agent transitioning, the engine auto-blocks the task
// so it reaches a real terminal state instead of looping.
const THRASH_WINDOW_MS = 2 * 60 * 1000;
const DUPLICATE_SIG_LIMIT = 4;
const THRASH_GATE_BREAKER_LIMIT = 6;
const THRASH_GATE_DRIFT_LIMIT = 8;

function detectTaskThrashing(agentId: string): {
  thrashing: boolean;
  toolName?: string;
  signature?: string;
  count?: number;
} {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - THRASH_WINDOW_MS).toISOString();
    const rows = db.prepare(`
      SELECT content FROM messages
      WHERE agent_id = ? AND role = 'assistant'
        AND datetime(created_at) > datetime(?)
      ORDER BY created_at ASC, rowid ASC
    `).all(agentId, cutoff) as Array<{ content: string }>;

    const counts = new Map<string, { count: number; toolName: string }>();
    let madeProgress = false;
    for (const row of rows) {
      let blocks: unknown;
      try { blocks = JSON.parse(row.content); } catch { continue; }
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        const block = b as { type?: string; name?: string; input?: Record<string, unknown> };
        if (block.type !== 'tool_use') continue;
        const name = String(block.name ?? '');
        if (!name) continue;
        // tracker_update_status / complete_task count as forward progress —
        // an agent that calls these is at least transitioning. Same for
        // send_to_user / chat-style replies (they finish the work).
        if (name === 'tracker_update_status' || name === 'complete_task') {
          madeProgress = true;
          continue;
        }
        const sig = canonicalToolSignature(name, block.input);
        const cur = counts.get(sig) ?? { count: 0, toolName: name };
        counts.set(sig, { count: cur.count + 1, toolName: name });
      }
    }
    if (madeProgress) return { thrashing: false };
    let topSig = '';
    let topCount = 0;
    let topName = '';
    for (const [sig, v] of counts) {
      if (v.count > topCount) { topCount = v.count; topSig = sig; topName = v.toolName; }
    }
    if (topCount >= DUPLICATE_SIG_LIMIT) {
      return { thrashing: true, toolName: topName, signature: topSig, count: topCount };
    }
    return { thrashing: false };
  } catch {
    return { thrashing: false };
  }
}


// ── Heartbeat (mirrors v1 helpers — local copy so v2 can run standalone) ──

function startStatusHeartbeat(agentId: string): void {
  const existing = statusHeartbeats.get(agentId);
  if (existing) clearInterval(existing);
  const timer = setInterval(() => {
    try {
      broadcast({ type: 'agent:status', agentId, status: 'working' });
    } catch {
      /* best effort */
    }
  }, STATUS_HEARTBEAT_INTERVAL_MS);
  statusHeartbeats.set(agentId, timer);
}

function stopStatusHeartbeat(agentId: string): void {
  const timer = statusHeartbeats.get(agentId);
  if (timer) {
    clearInterval(timer);
    statusHeartbeats.delete(agentId);
  }
}

export function setAgentStatus(agentId: string, status: string): void {
  try {
    const db = getDb();
    if (status === 'idle' || status === 'working') {
      db.prepare(`
        UPDATE agents SET status = ?, last_error = NULL, last_error_at = NULL, updated_at = datetime('now') WHERE id = ?
      `).run(status, agentId);
    } else {
      db.prepare(`
        UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?
      `).run(status, agentId);
    }
    broadcast({ type: 'agent:status', agentId, status });
  } catch (err) {
    logger.warn('Failed to update agent status', {
      agentId,
      status,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

// ── Main entry ──

/**
 * Run a single user-message → agent-response cycle on the v2 runtime.
 * Mirrors v1's runAgentLoop semantics with the Control Shell pattern.
 */
export async function runV2Turn(agentId: string): Promise<void> {
  const db = getDb();

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as
    | Record<string, unknown>
    | undefined;
  if (!agent) {
    throw new AgentError('Agent not found', agentId, { code: 'AGENT_NOT_FOUND' });
  }
  const configuredModelId = agent.model_id as string | null;
  if (!configuredModelId) {
    throw new AgentError('Agent has no model configured', agentId, { code: 'NO_MODEL' });
  }

  const isAutoRouted = configuredModelId === 'auto';
  const contextModelId = isAutoRouted ? '__auto__' : configuredModelId;
  const contextWindow = getContextWindow(contextModelId);

  setAgentStatus(agentId, 'working');
  startStatusHeartbeat(agentId);

  // Trigger context — read once at preflight (Part XIX preservation).
  //
  // v2.9.15: filter out rows that share `role='user'` but are NOT
  // actual user-channel inbounds. Without this, an A2A reply from a
  // sub-agent or a synthetic rate-limit-recovery notice shows up as
  // "the most recent user message" and the engine misattributes the
  // current turn's inbound channel - the canonical failure shape is:
  // user iMessages primary, primary delegates to a sub-agent, the
  // sub-agent's A2A reply lands as `role='user'` with content starting
  // `[A2A:`, and the primary's next-turn reply auto-routes to
  // dashboard instead of back to the original iMessage thread.
  const triggerRow = db.prepare(
    `SELECT content, source FROM messages
       WHERE agent_id = ?
         AND role = 'user'
         AND content NOT LIKE '[SOURCE: SYSTEM%'
         AND content NOT LIKE '[A2A:%'
         AND content NOT LIKE '[SOURCE: AGENT MESSAGE FROM%'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(agentId) as { content: string; source: string | null } | undefined;
  const lastUserMessageContent = triggerRow?.content ?? null;
  // Phase 3 — bind the inbound source for the whole turn. Computed once
  // here and threaded into every assembleContext call below so the
  // voice-conduct block stays in scope across tool-call iterations of
  // a single voice turn.
  const latestUserSource: 'voice' | 'text' | null =
    triggerRow?.source === 'voice' ? 'voice' : triggerRow ? 'text' : null;
  // Hume cloud-TTS brief — extend turn context with the active TTS engine
  // so the assembler can swap between the flat-voice (Kokoro) addendum
  // and the expressive (Hume) addendum that teaches the ((deliver: ...))
  // cue. Resolved once here so it stays stable across tool iterations.
  let latestTtsEngine: 'local' | 'cloud' | null = null;
  if (latestUserSource === 'voice') {
    try {
      const ttsRow = db.prepare("SELECT value FROM config WHERE key = ?")
        .get('voice.tts_engine') as { value: string } | undefined;
      latestTtsEngine = ttsRow?.value === 'cloud' ? 'cloud' : 'local';
    } catch {
      latestTtsEngine = 'local';
    }
  }
  const triggeredByIMessage = lastUserMessageContent?.includes('[SOURCE: IMESSAGE FROM') ?? false;
  const imFlagSetAtRunStart = isAwaitingIMResponse(agentId);
  // v2.9.16: once-per-turn latch for the voice-mode filler phrase.
  // Flipped true the first time we push a filler into the active TTS
  // burst so subsequent tool-using iterations in the same turn don't
  // double-fire ("on it ... checking ... give me a sec ...").
  let voiceFillerFired = false;

  // v2.9.23 — phone-call streaming TTS state. When this turn is
  // triggered by a live phone call, we keep a sentence-splitting
  // buffer attached to the model's onChunk callback. Each completed
  // sentence (or comma-separated clause for short replies) goes to
  // `CallSession.queueAgentSay` ASAP so audio starts playing on the
  // first sentence instead of waiting for the whole model output.
  // Cuts perceived latency by ~70 % on multi-sentence replies.
  let phoneStreamCallSid: string | null = null;
  let phoneStreamBuffer = '';
  let phoneStreamFlushedAny = false;

  // v2.7.23 — structural inbound channel binding. Parse the source tag from
  // the most recent user message to determine which channel the turn was
  // triggered from. The reply-destination resolver reads these at end of
  // turn to auto-route the model's terminal text back to the source
  // channel (OpenClaw-inspired pattern). For replies inside an active
  // iMessage thread, the bridge sets pendingIMResponseMap[agentId] with
  // the inbound sender — we read it via getInboundSenderFor so the agent
  // doesn't have to embed the recipient in its reply.
  let inboundChannel: 'imessage' | 'teams' | 'email' | 'sms' | 'phone' | 'dashboard' | null = null;
  let inboundContext: import('./state.js').ChannelInboundContext | null = null;
  if (triggeredByIMessage) {
    inboundChannel = 'imessage';
    const pendingSender = getInboundSenderFor(agentId);
    inboundContext = { recipientAddress: pendingSender ?? undefined, chatType: 'dm' };
  } else if (lastUserMessageContent?.includes('[SOURCE: TEAMS MESSAGE FROM')) {
    // v2.7.24 — Teams inbound routing. The auto-route ONLY fires when the
    // sender is on the per-channel Teams safe-sender allowlist. Without
    // this check, ANY Teams DM (including from external/unvetted contacts)
    // would trigger an auto-reply.
    const chatIdMatch = lastUserMessageContent.match(/Chat ID:\s*([^\s\]]+)/i);
    const chatTypeMatch = lastUserMessageContent.match(/Chat:[^()\n]*\(([^)]+)\)/i);
    const isGroup = chatTypeMatch?.[1]?.toLowerCase().includes('group') ?? false;
    // Sender format from teams-watcher.ts: "FROM Name <email@x>" or "FROM Name (email@x)".
    const senderHeader = lastUserMessageContent.match(/\[SOURCE: TEAMS MESSAGE FROM ([^\]]+)\]/i);
    const senderRaw = senderHeader?.[1] ?? '';
    const emailMatch = senderRaw.match(/<([^>]+)>/) ?? senderRaw.match(/\(([^)]+)\)/) ?? senderRaw.match(/(\S+@\S+)/);
    const senderAddress = emailMatch?.[1]?.toLowerCase() ?? '';
    const senderIsKnown = senderAddress
      ? getTeamsSafeSenders().some(s => addressesMatch(s.address, senderAddress))
      : false;
    if (senderIsKnown && chatIdMatch?.[1]) {
      inboundChannel = 'teams';
      inboundContext = {
        chatId: chatIdMatch[1],
        chatType: isGroup ? 'group' : 'dm',
        recipientAddress: senderAddress,
      };
    } else {
      // Unknown Teams sender → notification flow only. Agent reads the
      // message, decides whether to surface or engage; auto-route stays off.
      inboundChannel = 'dashboard';
    }
  } else if (
    lastUserMessageContent?.includes('[SOURCE: OUTLOOK NOTIFICATION') ||
    lastUserMessageContent?.includes('[SOURCE: GMAIL NOTIFICATION')
  ) {
    // v2.7.24 — email inbound routing. Only treat as inbound-REPLY (auto-
    // route the agent's response back via email) when all of these are
    // true:
    //   (a) subject starts with "Re:" (case-insensitive)
    //   (b) the From address is on the per-slot safe-sender list for the
    //       mailbox that received this notification (parsed from the
    //       notification's "(agent)" or "(user)" suffix)
    //   (c) we have a Message ID to reply against
    // Per-slot lists match the per-slot "Allow sending email" toggle —
    // adding Sarah to the agent slot's gmail list does NOT authorize
    // auto-reply to Sarah's emails arriving at the user slot's gmail.
    const subjectMatch = lastUserMessageContent.match(/^Subject:\s*(.+)$/im);
    const fromMatch = lastUserMessageContent.match(/^From:\s*(.+)$/im);
    const messageIdMatch = lastUserMessageContent.match(/^Message ID:\s*(\S+)/im);
    const isOutlook = lastUserMessageContent.includes('[SOURCE: OUTLOOK NOTIFICATION');
    // Format: [SOURCE: GMAIL NOTIFICATION — <address> (agent)]
    // The parenthesized suffix is the slot. Default to 'agent' on parse
    // failure (most common slot for monitored inboxes).
    const slotMatch = lastUserMessageContent.match(/\[SOURCE: (?:GMAIL|OUTLOOK) NOTIFICATION[^()]*\(([^)]+)\)\]/i);
    const inboundSlot: 'agent' | 'user' = slotMatch?.[1]?.toLowerCase() === 'user' ? 'user' : 'agent';
    const subject = subjectMatch?.[1]?.trim() ?? '';
    const fromRaw = fromMatch?.[1]?.trim() ?? '';
    const emailMatch = fromRaw.match(/<([^>]+)>/) ?? fromRaw.match(/(\S+@\S+)/);
    const fromAddress = emailMatch?.[1]?.toLowerCase() ?? '';
    const looksLikeReply = /^re:\s/i.test(subject);
    let fromIsKnownSafeSender = false;
    if (fromAddress) {
      const channelList = isOutlook
        ? getOutlookSafeSenders(inboundSlot)
        : getGmailSafeSenders(inboundSlot);
      fromIsKnownSafeSender = channelList.some(s => addressesMatch(s.address, fromAddress));
    }
    if (looksLikeReply && fromIsKnownSafeSender && messageIdMatch?.[1]) {
      inboundChannel = 'email';
      inboundContext = {
        emailMessageId: messageIdMatch[1],
        emailService: isOutlook ? 'outlook' : 'gmail',
        emailSubject: subject,
        recipientAddress: fromAddress,
      };
    } else {
      inboundChannel = 'dashboard';
    }
  } else if (lastUserMessageContent?.includes('[SOURCE: PHONE CALL FROM')) {
    // v2.9.18 — Twilio phone call inbound utterance. The agent's
    // terminal text auto-routes back via TTS over the active
    // CallSession.
    const fromMatch = lastUserMessageContent.match(/\[SOURCE: PHONE CALL FROM ([^\]]+)\]/);
    const callSidMatch = lastUserMessageContent.match(/Call SID:\s*(\S+)/);
    if (fromMatch?.[1] && callSidMatch?.[1]) {
      inboundChannel = 'phone';
      inboundContext = {
        phoneCallSid: callSidMatch[1].trim(),
        phoneFromNumber: fromMatch[1].trim(),
        recipientAddress: fromMatch[1].trim(),
      };
      // v2.9.23 — bind the streaming TTS sink for this turn. The
      // onChunk callback on the model call writes text into
      // phoneStreamBuffer as it arrives; sentence-complete chunks
      // flush to the CallSession's queueAgentSay immediately, so
      // audio starts playing while the model is still generating.
      phoneStreamCallSid = callSidMatch[1].trim();
    } else {
      inboundChannel = 'dashboard';
    }
  } else if (lastUserMessageContent?.includes('[SOURCE: SMS FROM')) {
    // v2.9.18 - Twilio SMS inbound routing. Same auto-route-on-known-
    // sender pattern as Teams: known sender → auto-route reply via
    // Twilio; unknown sender → notification flow, agent decides.
    // sms-inbound.ts already gates on the safe-sender list when
    // building the source tag, so anything tagged `[SOURCE: SMS FROM`
    // here is from a known sender. Unknown senders carry the
    // `[SOURCE: SMS NOTIFICATION` tag instead and fall through to
    // dashboard.
    const fromMatch = lastUserMessageContent.match(/\[SOURCE: SMS FROM ([^\]]+)\]/);
    const toMatch = lastUserMessageContent.match(/^To:\s*(\S+)/im);
    if (fromMatch?.[1]) {
      inboundChannel = 'sms';
      inboundContext = {
        smsFromNumber: fromMatch[1].trim(),
        smsToNumber: toMatch?.[1]?.trim(),
        recipientAddress: fromMatch[1].trim(),
      };
    } else {
      inboundChannel = 'dashboard';
    }
  } else if (lastUserMessageContent) {
    inboundChannel = 'dashboard';
  }
  // v2.5.31 — A2A reply context now sources from the durable a2a_replies
  // table, not just "is the most recent user message an [A2A:...] tag."
  // findUnrepliedAssignForAgent returns null if the most recent ASSIGN/
  // QUESTION/BLOCK has already been replied to via send_to_agent (in any
  // prior handleMessage invocation), which prevents the enforcer from
  // firing again for an already-handled inbound message. Falls back to
  // the legacy parse path so any pre-fix in-flight ASSIGNs (no row in
  // a2a_replies yet) still trigger the enforcer at least once.
  const unrepliedAssign = findUnrepliedAssignForAgent(agentId);
  const a2aReplyContext = unrepliedAssign
    ? { intent: unrepliedAssign.intent, threadShort: unrepliedAssign.threadShort, fromName: unrepliedAssign.fromName }
    : parseA2ATrigger(lastUserMessageContent);
  const a2aReplyAssignMessageId = unrepliedAssign?.messageId ?? null;

  // Determine v2 turn_number — read max from messages, increment.
  // Per Part XVIII §E: turn_number is per-agent, monotonically increasing,
  // resets to 0 on session reset (handled elsewhere).
  const lastTurn = db.prepare(
    'SELECT MAX(turn_number) as max_turn FROM messages WHERE agent_id = ?',
  ).get(agentId) as { max_turn: number | null } | undefined;
  const turnNumber = (lastTurn?.max_turn ?? 0) + 1;

  // Snapshot turn boundary so context assembly excludes mid-run user messages
  const turnStartedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  turnBoundary.set(agentId, turnStartedAt);

  // v2.7.6 — hydrate the technique-acknowledgement gate from agents.config.
  // If the agent ended their last turn with a pending ack, the gate stays
  // engaged across turns until they call technique_acknowledge.
  let initialPendingTechniqueAck: import('./state.js').AgentTurnState['pendingTechniqueAck'] = null;
  try {
    const cfgRow = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    if (cfgRow?.config) {
      const cfg = JSON.parse(cfgRow.config) as Record<string, unknown>;
      const pending = cfg.pendingTechniqueAck;
      if (pending && typeof pending === 'object') {
        const p = pending as { techniqueId?: unknown; techniqueName?: unknown; loadedAtIso?: unknown; fromTurnNumber?: unknown };
        if (
          typeof p.techniqueId === 'string' &&
          typeof p.techniqueName === 'string' &&
          typeof p.loadedAtIso === 'string' &&
          typeof p.fromTurnNumber === 'number'
        ) {
          initialPendingTechniqueAck = {
            techniqueId: p.techniqueId,
            techniqueName: p.techniqueName,
            loadedAtIso: p.loadedAtIso,
            fromTurnNumber: p.fromTurnNumber,
          };
        }
      }
    }
  } catch { /* malformed config — start fresh, agent can re-engage gate by re-reading */ }

  // Initial state
  let state = initState({
    agentId,
    contextWindow,
    isAutoRouted,
    configuredModelId,
    turnNumber,
    triggeredByIMessage,
    triggeredByA2AReplyIntent: a2aReplyContext,
    imFlagSetAtRunStart,
    lastUserMessageContent,
    inboundChannel,
    inboundContext,
    shouldNudgeTracker: false, // Phase 2.1 may compute this; baseline disabled
    pendingTechniqueAck: initialPendingTechniqueAck,
  });

  // ── v2.5.46: pre-turn close-out gate detection ──
  // Look up in_progress tasks the agent appears to have abandoned. Pre-
  // v2.7.17 this used `updated_at < turnStartedAt` (any task not touched
  // THIS turn), which made the gate fire every time the user interrupted
  // mid-conversation - even though the agent was actively working the task
  // a minute ago. Now uses a wall-clock threshold so genuinely abandoned
  // tasks are still caught but active mid-conversation work isn't.
  //
  // Per user spec ("if we default to agents creating tasks, they MUST
  // also close them out"): tracker hygiene is still a hard precondition,
  // just with a sane idle window before it kicks in.
  try {
    // (1) Tasks the agent is in_progress on but hasn't touched in the
    // last CLOSE_OUT_IDLE_MINUTES. Any tracker tool call (status update,
    // notes add/edit, complete_step) bumps updated_at, so an actively-
    // worked task naturally stays inside the window.
    const CLOSE_OUT_IDLE_MINUTES = 10;
    const inProgressDanglers = db.prepare(`
      SELECT id, title, 'in_progress' AS kind FROM tasks
      WHERE assigned_to = ?
        AND status = 'in_progress'
        AND is_paused = 0
        AND datetime(updated_at) < datetime('now', ?)
      ORDER BY updated_at ASC
      LIMIT 10
    `).all(agentId, `-${CLOSE_OUT_IDLE_MINUTES} minutes`) as Array<{ id: string; title: string; kind: string }>;

    // (2) Stranded on_deck tasks. Catches the Presenton-shaped failure:
    // agent created a project, did some of it, then abandoned it (often
    // because compaction made them forget the project existed and they
    // spun up a duplicate). The orphans sit in on_deck forever because
    // the existing in_progress-only gate never sees them and the PM's
    // STALE check only chats, doesn't auto-resolve.
    //
    // Criteria: on_deck task assigned to this agent, in a project this
    // agent created, the project has zero in_progress tasks, and the
    // task hasn't been touched in 30+ minutes. The 30-minute floor
    // prevents this from firing inside the same conversation as the
    // creation — only catches genuinely abandoned work between sessions.
    const strandedRows = db.prepare(`
      SELECT t.id, t.title, 'stranded' AS kind FROM tasks t
      INNER JOIN projects p ON p.id = t.project_id
      WHERE t.assigned_to = ?
        AND t.status = 'on_deck'
        AND t.is_paused = 0
        AND (t.scheduled_start IS NULL OR datetime(t.scheduled_start) <= datetime('now'))
        AND t.schedule_status != 'waiting'
        AND p.created_by = ?
        AND p.status = 'active'
        AND datetime(t.updated_at) < datetime('now', '-30 minutes')
        AND NOT EXISTS (
          SELECT 1 FROM tasks sib
          WHERE sib.project_id = p.id AND sib.status = 'in_progress'
        )
      ORDER BY t.updated_at ASC
      LIMIT 10
    `).all(agentId, agentId) as Array<{ id: string; title: string; kind: string }>;

    const danglingRows = [...inProgressDanglers, ...strandedRows];
    if (danglingRows.length > 0) {
      state = advance(state, {
        danglingTaskIds: danglingRows.map((r) => r.id),
        nudgedForCloseOutThisTurn: true,
      });
      const inProgressList = inProgressDanglers
        .map((r) => `  - "${r.title}" (${r.id.slice(0, 8)})`)
        .join('\n');
      const strandedList = strandedRows
        .map((r) => `  - "${r.title}" (${r.id.slice(0, 8)})`)
        .join('\n');

      const sections: string[] = [];
      if (inProgressDanglers.length > 0) {
        sections.push(
          `${inProgressDanglers.length} in_progress task${inProgressDanglers.length === 1 ? '' : 's'} from a previous turn you never closed:\n${inProgressList}`
        );
      }
      if (strandedRows.length > 0) {
        sections.push(
          `${strandedRows.length} stranded on_deck task${strandedRows.length === 1 ? '' : 's'} (queued steps on a project you created but stopped working on more than 30 minutes ago, with no in_progress sibling):\n${strandedList}`
        );
      }

      const gateMsg = (
        `[System: REQUIRED close-out — you have abandoned work on the tracker.\n\n` +
        `${sections.join('\n\n')}\n\n` +
        `**This turn must start with a tracker tool call, not a user-facing reply.** ` +
        `Resolve at least one item before doing anything else - call tracker_complete_step (multi-step projects), ` +
        `tracker_update_status (status="complete" | "blocked" | "paused" with resume_at), ` +
        `tracker_add_notes (if you are STILL actively working it - then KEEP GOING on this same turn, do not stop after writing the note), ` +
        `or - if the whole project was abandoned/duplicated/superseded - tracker_close_project(project_id, status="cancelled", reason="..."). ` +
        `The engine will REFUSE every non-tracker tool call until one of those lands; after that the gate releases for the rest of the turn so you can keep resolving the others alongside other work. ` +
        `Do NOT generate a user-facing response on this turn until the gate is satisfied - the user does not expect a reply yet; they expect the tracker to come back in sync.]`
      );
      const gateMsgId = uuidv4();
      try {
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
          VALUES (?, ?, 'system', ?, datetime('now'))
        `).run(gateMsgId, agentId, gateMsg);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: gateMsgId, agentId, role: 'system' as const,
            content: gateMsg,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
      } catch (msgErr) {
        logger.warn('v2: close-out gate system message insert failed', {
          agentId, error: msgErr instanceof Error ? msgErr.message : String(msgErr),
        }, agentId);
      }
      logger.info('v2: pre-turn close-out gate armed', {
        agentId, danglingCount: danglingRows.length,
        sample: danglingRows.slice(0, 3).map((r) => `${r.id.slice(0, 8)}:${r.title}`),
      }, agentId);
    }
  } catch (err) {
    logger.warn('v2: dangling-task lookup failed; close-out gate disarmed for this turn', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // ── Post-compaction recall flag (auto-injected via intercept, v2.7.2) ──
  // If compaction fired an unacknowledged recall nudge (no
  // recall_recent_thread call since), arm the one-shot auto-recall that
  // fires on the agent's first significant tool call this turn.
  //
  // v2.7.2 — bounded by session_started_at. Previously this query swept
  // ALL of an agent's history for "Memory was just compacted", which
  // meant stale compaction nudges from prior sessions kept arming the
  // flag after a session_reset. Symptom: agent post-reset gets the
  // auto-recall on its very first tool call, recall replays a transcript
  // from before the reset, and the agent gets confused into duplicate
  // calls. The boundary makes the check session-local.
  try {
    const sessionRow = db.prepare(
      'SELECT session_started_at FROM agents WHERE id = ?',
    ).get(agentId) as { session_started_at: string | null } | undefined;
    const sessionBoundary = sessionRow?.session_started_at ?? null;
    const nudgeQuery = sessionBoundary
      ? `SELECT created_at FROM messages
         WHERE agent_id = ? AND role = 'system'
           AND content LIKE '[System: Memory was just compacted%'
           AND created_at >= ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      : `SELECT created_at FROM messages
         WHERE agent_id = ? AND role = 'system'
           AND content LIKE '[System: Memory was just compacted%'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`;
    const nudgeParams = sessionBoundary ? [agentId, sessionBoundary] : [agentId];
    const lastNudge = db.prepare(nudgeQuery).get(...nudgeParams) as { created_at: string } | undefined;
    if (lastNudge) {
      const recallQuery = sessionBoundary
        ? `SELECT created_at FROM messages
           WHERE agent_id = ? AND role = 'assistant'
             AND content LIKE '%"name":"recall_recent_thread"%'
             AND created_at >= ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`
        : `SELECT created_at FROM messages
           WHERE agent_id = ? AND role = 'assistant'
             AND content LIKE '%"name":"recall_recent_thread"%'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`;
      const recallParams = sessionBoundary ? [agentId, sessionBoundary] : [agentId];
      const lastRecall = db.prepare(recallQuery).get(...recallParams) as { created_at: string } | undefined;
      const nudgeTs = new Date((lastNudge.created_at.includes('Z') ? lastNudge.created_at : lastNudge.created_at + 'Z')).getTime();
      const recallTs = lastRecall
        ? new Date((lastRecall.created_at.includes('Z') ? lastRecall.created_at : lastRecall.created_at + 'Z')).getTime()
        : 0;
      if (nudgeTs > recallTs) {
        state = advance(state, { awaitingPostCompactRecall: true });
        logger.info('v2: post-compaction recall flag armed', { agentId }, agentId);
      }
    }
  } catch (err) {
    logger.warn('v2: post-compaction recall check failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  try {
    // ── Main loop ──
    //
    // v2.7.2 — `taskClosedWithTextThisTurn` is checked here at the
    // boundary because internal phase transitions during the body
    // (preCallGates → assemble → callLLM → postCallClassify → execute →
    // postExecution) keep overwriting `phase`, so setting `phase: 'done'`
    // mid-body never survives to the next boundary check. The flag, on
    // the other hand, only gets set (never cleared) once the
    // text-plus-close-out pattern is detected, so the next loop turn
    // sees it and exits — after the current iteration's close-out tool
    // has already run.
    while (
      state.phase !== 'done' &&
      state.loopCount < MAX_TOOL_LOOPS &&
      !state.taskClosedWithTextThisTurn
    ) {
      state = advance(state, { loopCount: state.loopCount + 1, phase: 'preCallGates' });

      // Stop / preempt checks
      if (stoppedAgents.has(agentId)) {
        stoppedAgents.delete(agentId);
        logger.info('v2 agent stopped by user', {}, agentId);
        setAgentStatus(agentId, 'idle');
        break;
      }
      if (preemptedAgents.has(agentId)) {
        preemptedAgents.delete(agentId);
        logger.info('v2 run preempted — queued wakeup will fire', {}, agentId);
        setAgentStatus(agentId, 'idle');
        break;
      }

      // Last-resort auto-block. Two conditions trip it:
      //   (1) Refusal count exceeded — agent kept calling gated sigs and
      //       ignored the refusals.
      //   (2) Drift exceeded — gate has been on for THRASH_GATE_DRIFT_LIMIT
      //       iterations and the agent kept dodging the gate by varying
      //       its calls (different ids, get_current_time, tracker_get_status)
      //       without ever calling tracker_update_status to wrap up. This
      //       is the "look around to avoid finishing" failure mode.
      // We block (not pause) so the task hits a real terminal state.
      const drift =
        state.thrashGateActivatedAtLoopCount !== null
          ? state.loopCount - state.thrashGateActivatedAtLoopCount
          : 0;
      if (
        !isPMAgent(agentId) &&
        (state.thrashGateRefusalCount >= THRASH_GATE_BREAKER_LIMIT || drift >= THRASH_GATE_DRIFT_LIMIT)
      ) {
        const breakerReason =
          state.thrashGateRefusalCount >= THRASH_GATE_BREAKER_LIMIT
            ? `agent ignored the thrash gate ${state.thrashGateRefusalCount}× without wrapping up`
            : `agent dodged the thrash gate for ${drift} iterations (varying call signatures to avoid the gate) without calling tracker_update_status`;
        try {
          const db2 = getDb();
          const task = db2.prepare(`
            SELECT id, title FROM tasks
            WHERE assigned_to = ? AND status = 'in_progress'
            ORDER BY updated_at DESC LIMIT 1
          `).get(agentId) as { id: string; title: string } | undefined;
          if (task) {
            const noteLine = `Engine auto-blocked: ${breakerReason}. Likely needs human review or a re-stated goal.`;
            db2.prepare(`
              UPDATE tasks
              SET status = 'blocked',
                  blocked_validated = 1,
                  updated_at = datetime('now')
              WHERE id = ?
            `).run(task.id);
            void import('../../tracker/task-log.js').then(({ writeTaskLog }) => {
              writeTaskLog({
                taskId: task.id,
                fromEntity: 'engine',
                entryKind: 'observation',
                fromStatus: 'in_progress',
                toStatus: 'blocked',
                actionTaken: 'engine auto-block (thrash gate ignored)',
                reason: 'thrash:gate-ignored',
                note: noteLine,
              });
            }).catch(() => { /* best effort */ });
            void import('../../tracker/schema.js').then(({ getTask: schemaGetTask }) => {
              const fresh = schemaGetTask(task.id);
              if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
            }).catch(() => { /* best effort */ });
            logger.warn('v2: thrash gate breaker tripped — task auto-blocked', {
              taskId: task.id, refusalCount: state.thrashGateRefusalCount, loopCount: state.loopCount,
            }, agentId);
          }
        } catch (err) {
          logger.warn('v2: thrash auto-block failed', { error: err instanceof Error ? err.message : String(err) }, agentId);
        }
        try {
          broadcast({
            type: 'chat:error',
            agentId,
            error: `Engine auto-blocked task — ${breakerReason}.`,
            code: 'TASK_THRASH_PAUSED',
            severity: 'warning',
            retryable: true,
          });
        } catch { /* best effort */ }
        setAgentStatus(agentId, 'idle');
        break;
      }

      // Task-thrash detector — steer + per-signature gate (not pause).
      //
      // When the model re-runs the SAME canonical signature 4+ times in 2
      // minutes without calling tracker_update_status, inject a specific
      // steer message that names the exact tool + args + count + window
      // and gate further calls to that one signature. The agent can keep
      // calling the same tool with DIFFERENT args (legitimate iteration
      // over a list of N items stays unblocked). Last resort: if the gate
      // has refused THRASH_GATE_BREAKER_LIMIT+ calls without a
      // tracker_update_status transition, the engine auto-blocks the task
      // so it reaches a clean terminal state instead of looping forever.
      if (!isPMAgent(agentId) && state.loopCount >= 4) {
        const thrash = detectTaskThrashing(agentId);
        if (thrash.thrashing && thrash.signature && !state.thrashGatedSignatures.includes(thrash.signature)) {
          // Pull the recent canonical sig back into a human-readable form
          // for the steer message. The signature itself is `name:{...json}`
          // — we extract the JSON tail to show args verbatim.
          const argsPart = thrash.signature.includes(':')
            ? thrash.signature.slice(thrash.signature.indexOf(':') + 1)
            : '{}';
          // The steer MUST reach the model. assembler.ts strips role='system'
          // messages from history, so writing one as `system` would be
          // invisible to the model (dashboard-only theater). pendingNudge
          // gets injected at the top of the next model call as a synthetic
          // `role: 'user'` message — that's the engine's waking-style
          // delivery channel. We also persist as `role: 'user'` so the
          // dashboard renders it AND any next assemble cycle keeps seeing
          // it (pendingNudge is single-shot).
          const steerMsg =
            `[Engine thrash gate] You've called \`${thrash.toolName}(${argsPart})\` ${thrash.count}× in the last ${Math.round(THRASH_WINDOW_MS/60000)} minutes. ` +
            `You already have the result from the first call; further calls with these exact args are refused.\n\n` +
            `Your next action MUST be one of:\n` +
            `  (a) Call \`${thrash.toolName}\` with DIFFERENT args (e.g., a different id / target) if you genuinely have more to read.\n` +
            `  (b) Reply to the user with the answer you can give using the data you already have.\n` +
            `  (c) Call tracker_update_status(status='complete') with a result + evidence if this is a tracker task.\n` +
            `  (d) Call tracker_update_status(status='blocked') if you genuinely cannot proceed.\n` +
            `  (e) Send the user a specific question if you need clarification.\n\n` +
            `If you keep hitting refused signatures the engine will auto-block this task to stop the loop.`;
          const steerMsgId = uuidv4();
          try {
            // Persist as role='user' so the assembler picks it up next time
            // and the dashboard shows it inline as the engine's voice.
            db.prepare(`
              INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
              VALUES (?, ?, 'user', ?, ?, datetime('now'))
            `).run(steerMsgId, agentId, steerMsg, turnNumber);
          } catch { /* best effort */ }
          logger.warn('v2: thrash gate activated for signature', {
            toolName: thrash.toolName, signature: thrash.signature,
            count: thrash.count, loopCount: state.loopCount,
          }, agentId);
          state = advance(state, {
            thrashGatedSignatures: [...state.thrashGatedSignatures, thrash.signature],
            thrashGateActivatedAtLoopCount: state.thrashGateActivatedAtLoopCount ?? state.loopCount,
            // Also set pendingNudge so the steer reaches the model on the
            // very NEXT iteration even if the assembler hasn't seen the
            // persisted user message yet.
            pendingNudge: steerMsg,
          });
          try {
            broadcast({
              type: 'chat:error',
              agentId,
              error: `Engine refusing further ${thrash.toolName} calls with these args — try different input, mark complete, or block.`,
              code: 'TASK_THRASH_PAUSED',
              severity: 'warning',
              retryable: true,
            });
          } catch { /* best effort */ }
          // Don't break — let the loop continue. The next model turn will
          // see the system message and pick a wrap-up path. The runOne
          // path enforces the gate on tool execution.
        }
      }

      // ── Turn time budget — auto-continue, don't halt ──
      // (Matches v1 runtime.ts:884-919.) When a turn runs longer than 15 min,
      // force a compaction and queue a wakeup so the agent picks up where it
      // left off. After MAX_TURN_AUTO_CONTINUATIONS consecutive checkpoints
      // we give up — usually indicates a stuck loop.
      if (Date.now() - state.turnStartMs > TURN_TIME_BUDGET_MS) {
        const elapsedMin = Math.round((Date.now() - state.turnStartMs) / 60000);
        const continuationCount = (turnContinuationCounts.get(agentId) ?? 0) + 1;

        if (continuationCount > MAX_TURN_AUTO_CONTINUATIONS) {
          turnContinuationCounts.delete(agentId);
          logger.error('v2 turn auto-continuation cap reached — stopping', {
            elapsedMin, continuationCount, max: MAX_TURN_AUTO_CONTINUATIONS, agentId,
          }, agentId);
          const totalMin = (MAX_TURN_AUTO_CONTINUATIONS + 1) * (TURN_TIME_BUDGET_MS / 60000);
          const stuckMsg = (
            `[System: This task has been running for about ${totalMin} minutes without finishing. ` +
            `Pausing — this usually means a stuck loop, an over-scoped task, or a slow model. ` +
            `Send a follow-up to resume, or break the work into smaller pieces.]`
          );
          const stuckId = uuidv4();
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'system', ?, ?, datetime('now'))
          `).run(stuckId, agentId, stuckMsg, turnNumber);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: stuckId, agentId, role: 'system' as const,
              content: stuckMsg,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
          break;
        }

        turnContinuationCounts.set(agentId, continuationCount);
        logger.warn('v2 turn time budget reached — auto-continuing with forced compaction', {
          elapsedMin, continuationCount, agentId,
        }, agentId);

        // Force compaction so next turn starts with summarized history.
        try {
          const effectiveModel =
            state.modelId === '__auto__' ? configuredModelId : state.modelId;
          await checkAndCompact(agentId, effectiveModel, getContextWindow(effectiveModel), { force: true });
        } catch (compErr) {
          logger.warn('v2 forced compaction at turn-budget checkpoint failed', {
            agentId, error: compErr instanceof Error ? compErr.message : String(compErr),
          }, agentId);
        }

        const sysMsg = (
          `[System: This turn ran for ${elapsedMin} minutes. Pausing here and continuing on a fresh turn ` +
          `(${continuationCount} of ${MAX_TURN_AUTO_CONTINUATIONS}). ` +
          `Your earlier conversation has been summarized — pick up where you left off. ` +
          `Check tracker_list_active for the task you were working on; do not start over.]`
        );
        const sysMsgId = uuidv4();
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
          VALUES (?, ?, 'system', ?, ?, datetime('now'))
        `).run(sysMsgId, agentId, sysMsg, turnNumber);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: sysMsgId, agentId, role: 'system' as const,
            content: sysMsg,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        // Queue wakeup so handleMessage's finally fires the loop again
        pendingWakeups.add(agentId);
        break;
      }

      // ── Pre-call compaction gate (Part V) ──
      // Check assembled context utilization BEFORE the model call. v2's
      // architecture is "compaction is a debug signal, not routine":
      //   <90%   noop (the common case)
      //   90–96% warn (log + chat:warning broadcast — every WARN is a v2 architecture bug)
      //   96–99% emergency compact (force checkAndCompact + queue wakeup)
      //   ≥99%   block (surrender turn — recovery cascade re-runs)
      const assembledEstimate = estimateAssembledTokens(agentId, contextWindow);
      const gateResult = compactionGate(assembledEstimate.total, contextWindow);
      if (gateResult.decision === 'warn') {
        // The chat:warning toast comes from compaction.ts internal WARN block
        // when checkAndCompact runs — but in WARN-only mode we don't call
        // checkAndCompact. Fire the broadcast directly so dashboard surfaces it.
        logger.warn(gateResult.reason ?? 'context utilization warning', {
          agentId, ratio: gateResult.ratio, assembledTokens: gateResult.assembledTokens,
        }, agentId);
        try {
          // User-facing: plain language. Internal reason goes to logs only.
          const ratioPct = (gateResult.ratio * 100).toFixed(0);
          broadcast({
            type: 'chat:error',
            agentId,
            error: `Agent's memory is getting full (${ratioPct}%). Working normally for now.`,
            code: 'CONTEXT_HIGH',
            severity: 'warning',
            retryable: false,
          });
        } catch { /* best effort */ }
        // Continue the turn — WARN is informational, not a blocker.
      } else if (gateResult.decision === 'compact') {
        logger.error(gateResult.reason ?? 'emergency compaction', {
          agentId, ratio: gateResult.ratio,
        }, agentId);
        try {
          const effectiveModel = isAutoRouted ? configuredModelId : configuredModelId;
          await checkAndCompact(agentId, effectiveModel, contextWindow, { force: true });
        } catch (compErr) {
          logger.warn('v2: emergency compaction failed', {
            agentId, error: compErr instanceof Error ? compErr.message : String(compErr),
          }, agentId);
        }
        // Queue wakeup so the next iteration assembles fresh post-compaction context
        pendingWakeups.add(agentId);
        break;
      } else if (gateResult.decision === 'block') {
        logger.error(gateResult.reason ?? 'context impossibly full', {
          agentId, ratio: gateResult.ratio,
        }, agentId);
        const blockMsg = (
          `[System: Memory is too full to continue this turn (${(gateResult.ratio * 100).toFixed(0)}%). ` +
          `Pausing — the DOJO will compact memory and resume automatically.]`
        );
        const blockMsgId = uuidv4();
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
          VALUES (?, ?, 'system', ?, ?, datetime('now'))
        `).run(blockMsgId, agentId, blockMsg, turnNumber);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: blockMsgId, agentId, role: 'system' as const,
            content: blockMsg,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        // Force compaction then wakeup so we recover next turn
        try {
          await checkAndCompact(agentId, configuredModelId, contextWindow, { force: true });
        } catch { /* best effort */ }
        pendingWakeups.add(agentId);
        break;
      }

      // ── v2.5.11 — Routine gap-based compaction trigger ──
      // The token gate above only fires at high utilization. Long-running
      // agents whose fresh tail stays bounded never trip it, so messages
      // silently fall outside the fresh tail without ever being summarized.
      // This check fires when too many uncompacted messages have accumulated
      // outside the fresh tail, regardless of token level.
      //
      // v2.5.12 — Per-call cap: maxChunksPerRun=1 so a backlog drains
      // incrementally instead of all at once. skipContinuityBrief=true so
      // routine drains don't pay brief cost or spam chat with dividers.
      //
      // v2.5.14 — CRITICAL: fire-and-forget. Previously the agent's turn
      // awaited checkAndCompact, which awaited a summarizer LLM call, which
      // had only the OpenAI SDK's 10-minute default timeout. A hung
      // summarizer call would block the turn for up to 10 minutes with no
      // error and no logs. Now: kick off the drain in the background with
      // a 60s wall-clock abort, and the agent's turn proceeds immediately.
      // backgroundDrains flag prevents re-entry while a drain is in-flight
      // for this agent (so slow drains can't pile up; one in-flight max).
      if (gateResult.decision === 'noop') {
        const gapCount = getUncompactedGapCount(agentId, contextWindow);
        if (gapCount > UNCOMPACTED_GAP_THRESHOLD && !backgroundDrains.has(agentId)) {
          backgroundDrains.add(agentId);
          const drainAbort = new AbortController();
          const drainTimeout = setTimeout(() => {
            logger.warn('v2: background drain wall-clock timeout (60s) — aborting', {
              agentId,
            }, agentId);
            drainAbort.abort();
          }, 60_000);
          logger.info('v2: kicking off background gap-drain (fire-and-forget)', {
            agentId, gapCount, gapThreshold: UNCOMPACTED_GAP_THRESHOLD,
            maxChunksPerRun: 1, wallClockTimeoutMs: 60_000,
          }, agentId);
          checkAndCompact(agentId, configuredModelId, contextWindow, {
            maxChunksPerRun: 1,
            skipContinuityBrief: true,
            abortSignal: drainAbort.signal,
          })
            .then((result) => {
              logger.info('v2: background gap-drain complete', {
                agentId,
                leafCreated: result.leafCreated,
                tokensReclaimed: result.tokensReclaimed,
              }, agentId);
            })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              logger.warn('v2: background gap-drain failed or aborted', {
                agentId, error: msg,
              }, agentId);
            })
            .finally(() => {
              clearTimeout(drainTimeout);
              backgroundDrains.delete(agentId);
            });
        }
      }

      // ── Phase: assemble context ──
      state = advance(state, { phase: 'assemble' });
      const ctx = await assembleContext(agentId, contextModelId, { latestUserSource, ttsEngine: latestTtsEngine });
      let systemPrompt = ctx.systemPrompt;
      const messages = ctx.messages;

      // ── Technique matcher (Part VI #5, Phase 5) ──
      // Replaces v1's "MANDATORY: Check Techniques Before Starting Work"
      // prompt instruction with engine-side fuzzy matching: when the user
      // sends a message, the engine matches their intent against published
      // techniques and surfaces relevant ones in the system prompt. The
      // agent doesn't have to remember to check the index.
      //
      // Only fires:
      //   - on the first loop iteration of a turn (not per tool call)
      //   - when there is a last user message (not on auto-continuations,
      //     A2A wakes, or PM pokes — those carry their own context)
      //   - not for the PM agent (situation reports land as role='user',
      //     don't need technique hints injected on every poke tick).
      if (state.loopCount === 1 && lastUserMessageContent && !isPMAgent(agentId)) {
        try {
          const techniques = listTechniques({ state: 'published' }).map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description ?? undefined,
            tags: t.tags,
          }));
          const matches = techniqueMatcher({ query: lastUserMessageContent, techniques });
          if (matches.length > 0) {
            // Two modes:
            //   - STRONG MATCH (score >= 0.5): the engine loads TECHNIQUE.md
            //     and WRAPS the user's most recent message with the technique
            //     body, framed as authoritative guidance from the user. The
            //     wrap is in-message (user-role, adjacent to the ask) rather
            //     than appended to the system prompt — frontier models weight
            //     user-role instructions and recent tokens far more than
            //     buried system-prompt rules. v2.2.8 inlined into the system
            //     prompt and the model still ignored it; v2.3.2 puts the
            //     technique where the model actually pays attention.
            //   - WEAK MATCH (score < 0.5): keep the existing hint behavior
            //     in the system prompt; agent decides whether to load.
            //
            // Cap at one auto-injected technique per turn to keep token cost
            // bounded. If the technique is too large to inline (>25K chars ≈
            // 6K tokens), still wrap the user message but with a load-it
            // instruction instead of the full body.
            const STRONG_MATCH_THRESHOLD = 0.5;
            const MAX_INLINE_CHARS = 25_000;
            const strongMatch = matches[0].score >= STRONG_MATCH_THRESHOLD ? matches[0] : null;
            const weakMatches = strongMatch
              ? matches.slice(1).filter((m) => m.score < STRONG_MATCH_THRESHOLD)
              : matches;

            let injectedTechniqueId: string | null = null;
            let userMessageWrap: string | null = null;
            if (strongMatch) {
              try {
                const { getTechniqueDetail, recordTechniqueUsage } = await import('../../techniques/store.js');
                const detail = getTechniqueDetail(strongMatch.technique.id);
                if (detail?.instructions && detail.instructions.length > 0) {
                  const md = detail.instructions;
                  const tooLarge = md.length > MAX_INLINE_CHARS;
                  if (tooLarge) {
                    userMessageWrap =
                      `[DOJO: This task is covered by the "${strongMatch.technique.name}" technique. The full instructions are too long to inline (${md.length} chars) — load it via use_technique('${strongMatch.technique.id}') before doing the work. Do not improvise an alternative approach.]\n\n`;
                  } else {
                    userMessageWrap =
                      `[DOJO: This task is covered by the "${strongMatch.technique.name}" technique. Follow the procedure below as written — do not improvise an alternative approach.]\n\n` +
                      `--- TECHNIQUE: ${strongMatch.technique.name} ---\n${md}\n--- END TECHNIQUE ---\n\n`;
                  }
                  injectedTechniqueId = strongMatch.technique.id;
                  try { recordTechniqueUsage(strongMatch.technique.id, agentId); } catch { /* best effort */ }
                  logger.info('v2 techniqueMatcher: wrapping user message with strong-match technique', {
                    agentId,
                    techniqueId: strongMatch.technique.id,
                    techniqueName: strongMatch.technique.name,
                    score: strongMatch.score,
                    contentChars: md.length,
                    inlinedFully: !tooLarge,
                  }, agentId);
                }
              } catch (loadErr) {
                logger.warn('v2 techniqueMatcher: strong-match load failed — falling back to hint', {
                  agentId,
                  techniqueId: strongMatch.technique.id,
                  error: loadErr instanceof Error ? loadErr.message : String(loadErr),
                }, agentId);
              }
            }

            // Apply the wrap to the most recent user message in `messages`.
            // The DB-stored row is untouched — only this in-flight model call
            // sees the wrap. Handles both string and content-block forms.
            if (userMessageWrap) {
              for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i];
                if (m.role !== 'user') continue;
                if (typeof m.content === 'string') {
                  m.content = userMessageWrap + m.content;
                } else if (Array.isArray(m.content)) {
                  const blocks = m.content as unknown as Array<Record<string, unknown>>;
                  const firstTextIdx = blocks.findIndex((b) => b.type === 'text');
                  if (firstTextIdx >= 0) {
                    blocks[firstTextIdx] = {
                      ...blocks[firstTextIdx],
                      text: userMessageWrap + ((blocks[firstTextIdx].text as string) ?? ''),
                    };
                  } else {
                    blocks.unshift({ type: 'text', text: userMessageWrap });
                  }
                }
                break;
              }
            }

            // Weak matches (and the strong match if its load failed) get the
            // legacy "consider these" hint.
            const hintMatches = injectedTechniqueId === null
              ? matches
              : weakMatches;
            if (hintMatches.length > 0) {
              const lines = hintMatches.map((m) => {
                const reason = m.score >= 0.6 ? 'strong match' : 'possible match';
                const desc = m.technique.description ? ` — ${m.technique.description}` : '';
                return `- \`${m.technique.name}\` (${reason})${desc}\n  Load with \`use_technique('${m.technique.id}')\` if applicable.`;
              });
              const hintHeader = injectedTechniqueId
                ? `\n\n## Other Techniques That Might Also Apply\n\n`
                : `\n\n## Possibly Relevant Techniques\n\n`;
              systemPrompt += hintHeader +
                `Based on the user's message, the DOJO matched these techniques. Load any that fit the task; ignore otherwise.\n\n` +
                lines.join('\n');
            }
            logger.debug('v2 techniqueMatcher: surfaced matches', {
              agentId,
              matchCount: matches.length,
              autoInjected: injectedTechniqueId,
              names: matches.map((m) => m.technique.name),
            }, agentId);
          }
        } catch (err) {
          // "no such table: techniques" fires during integration test runs
          // (mocked in-memory DB without the techniques table) and pre-migration
          // fresh installs. It's not a production failure mode — log at debug,
          // not warn, so it doesn't pollute the WARN-rate acceptance signal.
          const msg = err instanceof Error ? err.message : String(err);
          const isMissingTable = /no such table/i.test(msg);
          if (isMissingTable) {
            logger.debug('v2 techniqueMatcher: techniques table not present (expected in tests/fresh DBs)', { agentId }, agentId);
          } else {
            logger.warn('v2 techniqueMatcher failed (non-fatal)', { agentId, error: msg }, agentId);
          }
        }
      }

      // ── Multi-step detection (v2.3.3) ──
      // Engine-side detection of prompts that need a tracker project.
      // When confident (heuristic high, or local-LLM classifier confirms),
      // create the project + initial task directly so the agent can't
      // forget to do it. Same lesson as the technique matcher above:
      // system-prompt instructions don't reliably get followed.
      //
      // Same fire conditions as technique matcher: loopCount === 1 with
      // a real user message (not auto-continuation / A2A / PM poke).
      //
      // v2.7.27: skip for the PM agent. The PM's situation reports land as
      // role='user' messages on its conversation; the classifier was treating
      // them as multistep user intent and auto-creating tracker projects
      // titled "Tracker review -- N active tasks:". Polluted the PM's view
      // every poke tick. PM never wants engine-auto-created projects.
      if (state.loopCount === 1 && lastUserMessageContent && !isPMAgent(agentId)) {
        try {
          const { detectMultistep, getMultistepConfig } = await import('./classifiers/multistep.js');
          const cfg = getMultistepConfig();
          if (cfg.enabled) {
            // Skip if there's already an active tracker task assigned to
            // this agent — assume it's still being worked. This avoids
            // creating a sibling project on a follow-up message.
            const db = getDb();
            const existingTask = db.prepare(`
              SELECT id FROM tasks
              WHERE assigned_to = ? AND status IN ('on_deck', 'in_progress', 'paused')
              LIMIT 1
            `).get(agentId) as { id: string } | undefined;

            if (!existingTask) {
              const decision = await detectMultistep(lastUserMessageContent, cfg);
              logger.info('v2 multistep classifier ran', {
                agentId,
                source: decision.source,
                multistep: decision.multistep,
                name: decision.name,
                signals: decision.heuristic.signals,
              }, agentId);

              if (decision.multistep) {
                const { createProject } = await import('../../tracker/schema.js');
                const { ENGINE_AUTO_MARKER } = await import('./classifiers/multistep.js');

                // Engine names projects/tasks with a slice of the user's
                // prompt. This is intentionally ugly — the PM agent gets
                // dispatched immediately after creation to rename both
                // via its local model (see the rename handoff below).
                // Async naming keeps the user-facing turn latency clean.
                const fallbackName = lastUserMessageContent
                  .split('\n')[0]
                  .slice(0, 50)
                  .trim()
                  .replace(/[.!?]+$/, '');
                const projectTitle = decision.name ?? fallbackName ?? 'Multi-step task';
                const taskTitle = decision.name ?? fallbackName ?? 'Initial task';

                try {
                  // createdBy == agentId so createProject's auto-start
                  // condition fires (assignee === createdBy on the first
                  // step → status='in_progress'). Otherwise the task lands
                  // in on_deck and waits for someone to pull it forward.
                  // Matches the pattern when an agent calls
                  // tracker_create_project on itself.
                  //
                  // Description carries the ENGINE_AUTO_MARKER prefix so
                  // tracker_create_project's dup guard can detect this
                  // project as engine-auto-created and steer the agent
                  // toward tracker_edit_task instead of refusing them into
                  // a parallel project.
                  const created = createProject({
                    title: projectTitle,
                    description: ENGINE_AUTO_MARKER + lastUserMessageContent.slice(0, 2000),
                    level: 1,
                    createdBy: agentId,
                    tasks: [{
                      title: taskTitle,
                      description: lastUserMessageContent.slice(0, 2000),
                      assignedTo: agentId,
                      priority: 'normal',
                    }],
                  });
                  logger.info('v2 multistep: auto-created tracker project', {
                    agentId,
                    projectId: created.projectId,
                    taskIds: created.taskIds,
                    title: projectTitle,
                    source: decision.source,
                  }, agentId);

                  // Inject the standard task-assignment notification —
                  // same payload tracker_create_task uses, including the
                  // explicit "When finished, call tracker_update_status"
                  // instruction. Persists to DB (survives compaction)
                  // and broadcasts WS for the dashboard. skipWake=true
                  // because we ARE the running turn — handleMessage
                  // would just queue a redundant follow-up.
                  const { injectTaskAssignmentNotification } = await import('../../tracker/notify.js');
                  const taskId = created.taskIds[0];
                  const notif = injectTaskAssignmentNotification({
                    assignedAgentId: agentId,
                    creatorAgentId: 'dojo-system',
                    taskId,
                    title: taskTitle,
                    description: lastUserMessageContent.slice(0, 2000),
                    projectId: created.projectId,
                    priority: 'normal',
                    skipWake: true,
                  });

                  // Push the same content into the in-flight messages
                  // array so the agent sees it THIS turn (not just on
                  // the next assemble). Goes after the user's prompt
                  // chronologically — agent reads "user said X" then
                  // "the engine assigned you a task for it."
                  if (notif.ok && notif.content) {
                    messages.push({ role: 'user', content: notif.content });
                  }

                  // ── PM rename handoff (async) ──
                  // The project + first task were named from a slice of the
                  // user prompt — that's ugly on the kanban. Fire a request
                  // at the PM agent to rename both via its local model.
                  // Fire-and-forget: the user-facing agent doesn't wait,
                  // and a failed PM call just leaves the slice-named rows
                  // in place (no worse than before). Async means the
                  // kanban shows the ugly name briefly (~seconds) until
                  // the PM rewrite lands.
                  try {
                    const { getPMAgentId, getPMAgentName, getPrimaryAgentName } = await import('../../config/platform.js');
                    const pmId = getPMAgentId();
                    const pmName = getPMAgentName();
                    const primaryName = getPrimaryAgentName();
                    if (pmId && pmName) {
                      const renameRequest = (
                        `[ENGINE RENAME REQUEST] An auto-created project needs better names. ` +
                        `The multi-step classifier just opened this from a user prompt and named both the project ` +
                        `and the first task with a slice of that prompt — looks bad on the kanban.\n\n` +
                        `Project id: ${created.projectId}\n` +
                        `Current project title: ${projectTitle}\n` +
                        `First task id: ${taskId}\n` +
                        `Current first-task title: ${taskTitle}\n\n` +
                        `Original user prompt:\n${lastUserMessageContent.slice(0, 1500)}\n\n` +
                        `Please call tracker_edit_project(project_id="${created.projectId}", title="<short 3-6 word umbrella name>") ` +
                        `and tracker_edit_task(task_id="${taskId}", title="<short 3-6 word first-step name>"). ` +
                        `The project name describes the WHOLE effort; the first-task name is the first concrete thing to do. ` +
                        `Make them distinct — don't reuse the same string for both. After both edits land, send NO message ` +
                        `back to anyone — this is a silent rename. Do not contact ${primaryName}.`
                      );
                      const renameMsgId = uuidv4();
                      db.prepare(`
                        INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
                        VALUES (?, ?, 'user', ?, datetime('now'))
                      `).run(renameMsgId, pmId, renameRequest);
                      broadcast({
                        type: 'chat:message',
                        agentId: pmId,
                        message: {
                          id: renameMsgId, agentId: pmId, role: 'user' as const,
                          content: renameRequest,
                          tokenCount: null, modelId: null, cost: null, latencyMs: null,
                          createdAt: new Date().toISOString(),
                        },
                      });
                      // Fire-and-forget wake. handleMessage queues itself
                      // if PM is busy.
                      void getAgentRuntime().handleMessage(pmId, renameRequest).catch(err => {
                        logger.warn('v2 multistep: PM rename wake failed (non-fatal)', {
                          error: err instanceof Error ? err.message : String(err),
                        }, agentId);
                      });
                      logger.info('v2 multistep: dispatched PM rename request', {
                        agentId, pmId, projectId: created.projectId, taskId,
                      }, agentId);
                    }
                  } catch (renameErr) {
                    logger.warn('v2 multistep: PM rename dispatch failed (non-fatal)', {
                      agentId,
                      error: renameErr instanceof Error ? renameErr.message : String(renameErr),
                    }, agentId);
                  }
                } catch (createErr) {
                  logger.warn('v2 multistep: createProject failed (non-fatal)', {
                    agentId,
                    error: createErr instanceof Error ? createErr.message : String(createErr),
                  }, agentId);
                }
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isMissingTable = /no such table/i.test(msg);
          if (isMissingTable) {
            logger.debug('v2 multistep: tracker tables not present (expected in tests/fresh DBs)', { agentId }, agentId);
          } else {
            logger.warn('v2 multistep classifier failed (non-fatal)', { agentId, error: msg }, agentId);
          }
        }
      }

      // Inject user-uploaded attachments (images, PDFs) as content blocks.
      // Without this, the agent never sees images/PDFs the user attached —
      // it only sees the text content of those messages and hallucinates.
      // Same path v1 uses (runtime.ts:1929 in v1).
      //
      // v2.3.18: oversized images get downscaled to fit the 5MB model cap
      // here. Persist a one-shot system note for any FRESH resize so the
      // user knows what happened (later turns hit the on-disk cache and
      // stay silent).
      const { injectAttachmentBlocks } = await import('../runtime.js');
      // Defensive default — older mocks may return undefined.
      const freshResizes = injectAttachmentBlocks(messages, agentId) ?? [];
      if (freshResizes.length > 0) {
        try {
          // v2.3.19 — rectifier supplies the agent-facing note directly.
          // Fall back to the legacy size-based formatter for back-compat
          // when only originalSize/finalSize are present.
          const { formatBytes } = await import('../image-prep.js');
          const lines = freshResizes.map((r) => {
            if (r.note) return r.note;
            const orig = r.originalSize ?? 0;
            const fin = r.finalSize ?? 0;
            return `Image \`${r.filename}\` was downscaled from ${formatBytes(orig)} to ${formatBytes(fin)} to fit the model's 5 MB per-image limit.`;
          });
          const noteContent = `[Engine: input preparation]\n${lines.join('\n')}`;
          const noteId = uuidv4();
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'system', ?, ?, datetime('now'))
          `).run(noteId, agentId, noteContent, turnNumber);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: noteId, agentId, role: 'system' as const,
              content: noteContent,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          logger.warn('v2: failed to persist image-resize system note (non-fatal)', {
            agentId, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
      }

      // Inject pendingNudge if present (synthetic user message, not persisted).
      // Per v1 runtime.ts:940-947 — only inject if last message is assistant
      // (so alternation stays valid). Then clear the nudge.
      if (state.pendingNudge && (messages.length === 0 || messages[messages.length - 1].role === 'assistant')) {
        messages.push({ role: 'user', content: state.pendingNudge });
        state = advance(state, { pendingNudge: null });
      }

      // Empty-messages guard (preserve v1 behavior at runtime.ts:1014-1020)
      if (messages.length === 0) {
        logger.info('v2: assembled context has zero messages — clean exit', {
          agentId,
          loopCount: state.loopCount,
        }, agentId);
        setAgentStatus(agentId, 'idle');
        break;
      }

      // ── Phase: model call ──
      // (Auto-routing + capability gate + retry-fallback + TRUE streaming.)
      state = advance(state, { phase: 'callLLM' });
      const messageId = uuidv4();
      state = advance(state, { currentMessageId: messageId });

      // ── Auto-routing model selection (matches v1 runtime.ts:954-988) ──
      // For auto-routed agents, pick the right model for THIS query. Lock
      // the model across tool loops so we don't switch mid-task.
      let modelId: string;
      let routerTier: string | null = null;
      const excludedModels: string[] = [];

      if (isAutoRouted) {
        if (state.lockedModelId && state.loopCount > 1) {
          modelId = state.lockedModelId;
          routerTier = state.lockedTier;
          logger.info('v2 auto-router: using locked model (mid-task)', {
            modelId, tier: routerTier,
          }, agentId);
        } else {
          const { scoreQuery } = await import('../../router/scorer.js');
          const { selectModel } = await import('../../router/selector.js');
          const scoringResult = scoreQuery(
            systemPrompt,
            messages as Array<{ role: string; content: string | object[] }>,
          );
          routerTier = scoringResult.tier;
          const selected = selectModel(scoringResult.tier, agentId, undefined, ['tools']);
          if (!selected) {
            throw new AgentError('Auto-router: no models available in any tier', agentId, { code: 'NO_MODEL' });
          }
          modelId = selected.modelId;
          logger.info(`v2 auto-router: tier=${scoringResult.tier} → ${modelId}`, {
            tier: scoringResult.tier,
            modelId,
            fallbackUsed: selected.fallbackUsed,
          }, agentId);
        }
      } else {
        modelId = configuredModelId;
      }
      state = advance(state, { modelId, routerTier });

      // ── Pre-flight capability enforcement (matches v1 runtime.ts:995) ──
      // Routes images through the fallback vision model when configured
      // (replacing each image block with a text description), or strips
      // them if no fallback is set. Returns useTools=false if model
      // lacks tool support (with banner). Now async because the
      // fallback caption call is a network round-trip.
      const { enforceModelCapabilities } = await import('../runtime.js');
      const { useTools } = await enforceModelCapabilities(agentId, modelId, messages);

      // If tools are disabled, inject a one-shot note so the model knows it
      // can only respond with text. Only inject on first iteration when last
      // message is assistant (alternation safety).
      if (!useTools && state.loopCount === 1 && messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
        const toolNote = (
          `[System note: Your current model does not support tool calling. You can only respond with text. ` +
          `If the user asks you to do something that requires tools (file access, web search, tracker, etc.), ` +
          `explain that your model doesn't support it and suggest they switch to a tool-capable model in Settings.]`
        );
        messages.push({ role: 'user', content: toolNote });
      }

      // ── Call model with retry-and-fallback (matches v1 runtime.ts:1028-1116) ──
      // For auto-routed agents, try up to 3 different models in the tier.
      // For fixed-model agents, throw on first failure.
      const maxAttempts = isAutoRouted ? 3 : 1;
      let result: Awaited<ReturnType<typeof callModel>> | undefined;
      let callSucceeded = false;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const abortController = new AbortController();
        activeAbortControllers.set(agentId, abortController);

        try {
          result = await callModel({
            agentId,
            modelId,
            messages,
            systemPrompt,
            tools: useTools,
            routerTier: routerTier ?? undefined,
            // Real abort signal — when stopAgent fires controller.abort(), the
            // underlying SDK call (Anthropic/OpenAI/Ollama) actually cancels
            // the in-flight fetch and throws here. Without this signal, stop
            // would only halt the runtime loop AFTER the model call finished.
            abortSignal: abortController.signal,
            // TRUE streaming — broadcast each chunk as it arrives.
            onChunk: (chunk) => {
              if (abortController.signal.aborted) return;
              broadcast({
                type: 'chat:chunk',
                agentId,
                messageId,
                content: chunk,
                done: false,
              });
              // v2.9.23 — phone-call streaming TTS. Accumulate chunks
              // into a buffer and flush each completed sentence to
              // CallSession.queueAgentSay as it appears. Effect: audio
              // starts playing on the first sentence, instead of
              // waiting for the full model response. Same idea as
              // voice mode's clause splitter but landing on the
              // Twilio CallSession's TTS queue instead of the voice
              // WS stream.
              if (phoneStreamCallSid) {
                phoneStreamBuffer += chunk;
                // Boundary: sentence-end punctuation followed by
                // whitespace. Sentence-level keeps the synth boundary
                // clean for both Kokoro and Hume.
                const flushParts: string[] = [];
                let last = 0;
                const re = /[.!?\n]+\s+/g;
                let m: RegExpExecArray | null;
                while ((m = re.exec(phoneStreamBuffer)) !== null) {
                  const end = m.index + m[0].length;
                  const part = phoneStreamBuffer.slice(last, end).trim();
                  if (part) flushParts.push(part);
                  last = end;
                }
                if (last > 0) phoneStreamBuffer = phoneStreamBuffer.slice(last);
                if (flushParts.length > 0) {
                  // v2.10.1 — queueAgentSay is now just an enqueue
                  // (the CallSession runs a single-flight drain
                  // worker), so synchronous push is fine and order
                  // is preserved by the worker. No IIFE / no
                  // parallel synths.
                  void (async () => {
                    try {
                      const { getCallSession } = await import('../../twilio/call-session.js');
                      const session = getCallSession(phoneStreamCallSid as string);
                      if (!session || session.isEnded()) return;
                      for (const part of flushParts) {
                        if (abortController.signal.aborted) return;
                        // Fire-and-forget: queueAgentSay enqueues
                        // and returns; the drain worker handles
                        // serial synthesis.
                        void session.queueAgentSay(part);
                      }
                      phoneStreamFlushedAny = true;
                    } catch { /* best effort; one-shot fallback runs at turn end */ }
                  })();
                }
              }
            },
            // Reasoning / thinking chunks (DeepSeek native, OpenRouter
            // unified). The dashboard renders these in a collapsible
            // "Thinking…" panel above the assistant bubble — separate
            // from the final-answer text stream.
            onReasoningChunk: (chunk) => {
              if (abortController.signal.aborted) return;
              broadcast({
                type: 'chat:reasoning_chunk',
                agentId,
                messageId,
                content: chunk,
                done: false,
              });
            },
          });
          activeAbortControllers.delete(agentId);
          callSucceeded = true;
          break;
        } catch (err) {
          activeAbortControllers.delete(agentId);

          if (stoppedAgents.has(agentId)) {
            stoppedAgents.delete(agentId);
            setAgentStatus(agentId, 'idle');
            return;
          }
          if (preemptedAgents.has(agentId)) {
            preemptedAgents.delete(agentId);
            logger.info('v2 run preempted — queued wakeup will fire', {}, agentId);
            setAgentStatus(agentId, 'idle');
            return;
          }

          // Not auto-routed OR exhausted attempts — rethrow.
          // (v1's catch path in handleMessage handles further recovery —
          // Dreamer overflow, provider 4xx, healer notification, etc. Phase 6
          // moves all of that into agent/v2/recovery.ts.)
          if (!isAutoRouted || attempt >= maxAttempts - 1) {
            throw err;
          }

          // Auto-routed: try the next model in the fallback chain.
          excludedModels.push(modelId);
          // Clear model lock so fallback can pick a different model.
          state = advance(state, { lockedModelId: null, lockedTier: null });
          const { selectModel } = await import('../../router/selector.js');
          const fallbackTier = routerTier ?? state.lockedTier ?? 'standard';
          const fallback = selectModel(fallbackTier, agentId, excludedModels, ['tools']);
          if (!fallback) {
            logger.error('v2 auto-router: no fallback models available', {
              failedModel: modelId, tier: fallbackTier, excludedModels, attempt,
            }, agentId);
            throw err;
          }
          logger.warn(`v2 auto-router: ${modelId} failed → falling back to ${fallback.modelId}`, {
            failedModel: modelId,
            fallbackModel: fallback.modelId,
            tier: routerTier,
            error: err instanceof Error ? err.message.slice(0, 100) : String(err),
          }, agentId);
          modelId = fallback.modelId;
          state = advance(state, { modelId });
        }
      }

      if (!callSucceeded || !result) {
        throw new AgentError('Model call failed after all attempts', agentId, { code: 'MODEL_CALL_FAILED' });
      }

      // ── Lock model for tool loops ──
      // For auto-routed agents that just kicked off tool calls, pin the
      // chosen model for the remainder of this turn so tools+follow-up calls
      // use the same model.
      if (isAutoRouted && !state.lockedModelId && result.toolCalls.length > 0) {
        state = advance(state, { lockedModelId: modelId, lockedTier: routerTier });
        logger.info('v2 auto-router: locking model for tool loop', { modelId, tier: routerTier }, agentId);
      }

      // Cost recording happens inside callModel (model.ts records once per
      // provider path). The v2 loop must NOT call recordCost again — doing so
      // double-bills the cost tracker. Verified against logs 2026-05-04.
      //
      // Embedding queueing: callModel does NOT queue embeddings — that's the
      // runtime's job. v1 calls queueEmbedding for assistant text responses
      // (runtime.ts), so v2 does the same.
      // Skip embedding the no-reply sentinel — it's not real content and the
      // matching assistant message row never gets persisted.
      const isNoReplySentinel =
        !!result.content &&
        result.toolCalls.length === 0 &&
        /^\s*\[no-reply\]\s*$/i.test(result.content);
      if (result.content && result.content.trim().length > 0 && !isNoReplySentinel) {
        try {
          queueEmbedding('message', messageId, agentId, result.content);
        } catch { /* best effort */ }
      }

      state = advance(state, { lastResponse: result, toolCalls: result.toolCalls });

      // ── Phase: post-call classification ──
      state = advance(state, { phase: 'postCallClassify' });

      // Empty response handling — v1 has 3-phase retry. Phase 2 baseline:
      // single output-truncation check; if not truncated and no text/tools,
      // surface as toast and break.
      if (result.toolCalls.length === 0 && (!result.content || result.content.trim().length === 0)) {
        const trunc = outputTruncationClassifier({
          stopReason: result.stopReason,
          contentLength: 0,
          currentBudget: state.outputTokensEscalated,
        });
        if (trunc.truncated && trunc.escalateTo !== null) {
          // Output was truncated — escalate budget and retry.
          state = advance(state, { outputTokensEscalated: trunc.escalateTo });
          continue;
        }
        // Clean end-of-turn after tools — legitimate exit, no error.
        if (state.toolCallsExecutedThisTurn > 0) {
          // v1 line 1167-1171: agent did work and has nothing more to say.
          break;
        }
        // No tools called and no text — empty response. v1 runtime.ts:1166-1199
        // does a 3-phase fallback before giving up. Many empties are transient
        // (streaming hiccup, model hesitation) and resolve on a silent retry.
        // Phase 1: silent retry (no nudge, just re-run the model).
        if (!state.retriedEmptyResponse) {
          logger.warn('v2: model returned empty response, retrying silently', {
            loopCount: state.loopCount, stopReason: result.stopReason,
          }, agentId);
          state = advance(state, { retriedEmptyResponse: true });
          continue;
        }
        // Phase 2: explicit nudge — inject a [System: ...] note via pendingNudge
        // so the assemble phase wraps it as a synthetic user message next turn.
        if (!state.nudgedForEmptyResponse) {
          logger.warn('v2: model returned empty after silent retry, nudging', {
            loopCount: state.loopCount, stopReason: result.stopReason,
          }, agentId);
          state = advance(state, {
            nudgedForEmptyResponse: true,
            pendingNudge:
              "[System: You returned an empty response. Please respond to the user's last message or call a tool to continue your task. If you are finished, say so clearly.]",
          });
          continue;
        }
        // Phase 3: give up — toast the user, no DB changes.
        logger.warn('v2: model returned empty after nudge, breaking', {
          loopCount: state.loopCount, stopReason: result.stopReason,
        }, agentId);
        state = advance(state, { pendingNudge: null });
        broadcast({
          type: 'chat:error',
          agentId,
          error: 'Agent gave an empty reply. Send your message again to retry.',
          code: 'MODEL_FAILED',
          severity: 'warning',
          retryable: true,
        });
        break;
      }

      // Sanitize text before persistence (#39, v1 runtime.ts:1208-1219).
      // Weak models emit literal `\n` and over-pad blank lines.
      result.content = sanitizeAssistantText(result.content ?? null) ?? '';

      // Dedup check (#40, v1 runtime.ts:1221-1232). If the model produced
      // the exact same text as the most recent assistant message AND there
      // are no tool calls, break the loop without persisting. Catches the
      // "model regenerated identical text" failure mode (multiple triggers,
      // model stalls). Tool-bearing turns are exempt — even with identical
      // text, the tool calls themselves carry new state.
      if (result.content && result.toolCalls.length === 0) {
        const lastAssistant = db
          .prepare(
            "SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1",
          )
          .get(agentId) as { content: string } | undefined;
        if (lastAssistant && lastAssistant.content === result.content) {
          logger.warn('v2: skipping duplicate assistant response (identical to last message)', {
            loopCount: state.loopCount,
          }, agentId);
          break;
        }
      }

      // Broadcast streaming complete + persist assistant message.
      const persistenceDecision = outputPersistenceClassifier({
        responseText: result.content ?? null,
        toolCallsThisTurn: result.toolCalls,
        isInterAgentTrigger:
          lastUserMessageContent?.includes('[SOURCE: AGENT MESSAGE FROM') ||
          lastUserMessageContent?.includes('[SOURCE: GROUP BROADCAST FROM') ||
          lastUserMessageContent?.includes('[SOURCE: PM AGENT POKE FROM') ||
          lastUserMessageContent?.startsWith('[A2A:') || false,
        sentToAgentThisTurn: state.sentToAgentThisTurn,
      });

      let persistedContent: string | null = result.content;
      // v2.5.7 — strip system routing tags the LLM may have copied from
      // prior conversation history (e.g. "[SENT VIA IMESSAGE to David]")
      // before persisting OR routing to iMessage. This cleans both the
      // dashboard render path and the iMessage outbound path at the source,
      // and keeps the next turn's LLM context free of the hallucinated tags
      // (so we don't reinforce the pattern).
      if (persistedContent) {
        const { stripSystemTags } = await import('../../services/imessage-bridge.js');
        const cleaned = stripSystemTags(persistedContent);
        persistedContent = cleaned || null;
      }
      if (persistenceDecision.decision === 'suppress' && result.toolCalls.length === 0) {
        logger.debug('v2: suppressed trailing text', {
          agentId,
          reason: persistenceDecision.reason,
        }, agentId);
        persistedContent = null;
      }

      // ── Duplicate-final-answer prevention (v2.7.2, scoped down v2.7.3) ──
      //
      // The v2.7.2 fix exited the loop whenever the agent paired wrap-up
      // text with ANY task-closing tool call (tracker_close_project,
      // tracker_complete_step, tracker_update_status with terminal
      // status, complete_task). The intent was good (skip the duplicate
      // "All set." follow-up turn) but the trigger was way too broad:
      //
      //   • Multi-step user asks where step 1 is a close-out got cut
      //     off after step 1 and never reached step 2.
      //   • Agents naturally mark intermediate task transitions with
      //     "Step done, moving on to X" — that paired text+close-out
      //     killed the loop mid-flow.
      //   • The v2.7.3 DB-based "any remaining queued work?" check
      //     helped for tracker-tracked workflows but still cut off
      //     conversational multi-step asks where the next step lives
      //     only in the user's prompt, not in the tracker.
      //
      // Narrowed in v2.7.3 to fire ONLY for `complete_task` — the
      // sub-agent self-termination tool. Its semantics are unambiguous:
      // "I am a sub-agent, my work is over, terminate me and report
      // back to parent." Letting the loop run one more iteration after
      // complete_task would only produce a wasted "all done" follow-up
      // before the agent gets terminated anyway.
      //
      // Every tracker close-out path is now allowed to flow into the
      // next loop iteration. The worst case is one extra model call
      // that emits a brief duplicate "all set" line — minor polish
      // issue. The previous trigger broke real multi-step work, which
      // is a far worse failure mode.
      const isSubAgentExit = (tc: { name: string }): boolean => tc.name === 'complete_task';
      const hasSubAgentExit = result.toolCalls.some(isSubAgentExit);
      const hasWrapUpText = !!(result.content && result.content.trim().length >= 10);

      if (
        !state.taskClosedWithTextThisTurn &&
        hasSubAgentExit &&
        hasWrapUpText
      ) {
        state = advance(state, {
          taskClosedWithTextThisTurn: true,
          // Force loop exit AFTER this iteration's tool execution. The
          // complete_task tool still runs (it's already in result.toolCalls
          // and processed below this block). The next while-loop check
          // sees phase==='done' and exits without calling the model again.
          phase: 'done',
        });
        logger.info('v2: sub-agent complete_task + wrap-up text — phase set to done, no second model call', {
          agentId,
        }, agentId);
      }

      // No-reply sentinel: the agent emits `[no-reply]` (case-insensitive,
      // possibly with surrounding whitespace) when the incoming message
      // closes the conversation (goodnight, that's all, etc.) and there's
      // nothing actionable to respond to. We swallow the literal sentinel
      // (so it doesn't get echoed via iMessage or rendered in chat) and
      // persist a system marker instead, so the agent's next turn sees
      // that the prior turn ended silently. Skipping persistedContent here
      // means lastAssistantTextForIM stays unset, which suppresses the
      // iMessage routing at end-of-turn. Critical for preventing endless
      // back-and-forth chatter on iMessage.
      //
      // Two forms: (a) the entire message IS the sentinel — swallow the
      // bubble entirely, persist a [conversation closed] system marker.
      // (b) the message ENDS with the sentinel (optionally wrapped in
      // backticks/asterisks) — strip just the sentinel so the user sees
      // the actual reply text. This handles the common model mistake of
      // appending the sentinel after a real reply (2026-06-02 bug fix:
      // the primary agent was tail-appending `[no-reply]` to user-facing
      // messages and the literal text was rendering in chat).
      const NO_REPLY_TAIL_RE = /\s*[`*_]*\s*\[no-reply\]\s*[`*_]*\s*$/i;
      if (
        persistedContent &&
        result.toolCalls.length === 0 &&
        NO_REPLY_TAIL_RE.test(persistedContent) &&
        !/^\s*[`*_]*\s*\[no-reply\]\s*[`*_]*\s*$/i.test(persistedContent)
      ) {
        const cleaned = persistedContent.replace(NO_REPLY_TAIL_RE, '').trimEnd();
        if (cleaned.length > 0) {
          logger.info('v2: stripped trailing [no-reply] sentinel from user-facing message', {
            agentId, originalLength: persistedContent.length, cleanedLength: cleaned.length,
          }, agentId);
          persistedContent = cleaned;
        }
      }
      if (
        persistedContent &&
        result.toolCalls.length === 0 &&
        /^\s*[`*_]*\s*\[no-reply\]\s*[`*_]*\s*$/i.test(persistedContent)
      ) {
        persistedContent = null;
        // Clear the streaming bubble in the dashboard. We need BOTH events:
        //  - chat:chunk done:true ends the bubble's streaming state (without
        //    this the thinking dots stay forever, since the normal done:true
        //    at line ~923 only fires when persistedContent or tools exist).
        //  - chat:message with empty content tells the dashboard to drop the
        //    bubble entirely so the chat doesn't show an empty assistant row.
        broadcast({
          type: 'chat:chunk',
          agentId,
          messageId,
          content: '',
          done: true,
        });
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: messageId, agentId, role: 'assistant' as const,
            content: '',
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        const sysId = uuidv4();
        const sysContent = '[Agent ended turn without replying — conversation closed]';
        try {
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'system', ?, ?, datetime('now'))
          `).run(sysId, agentId, sysContent, turnNumber);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: sysId, agentId, role: 'system' as const,
              content: sysContent,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          logger.warn('v2: failed to persist no-reply marker', {
            agentId, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
        logger.info('v2: agent ended turn silently via [no-reply] sentinel', {
          agentId, loopCount: state.loopCount,
        }, agentId);
      }


      // ── XML-fallback detection (matches v1 runtime.ts:1240) ──
      // Weak/local models that don't support structured tool calling emit
      // tool calls via the XML text-fallback parser. Their tool IDs are
      // synthetic (`text_tool_*`). Persisting them as structured tool_use
      // blocks would corrupt the next turn — the provider can't reference
      // IDs it didn't generate. Instead we persist text-only, then broadcast
      // a collapsed view with calls + results inline so the user sees them.
      const hasXmlFallbackTools = result.toolCalls.some((tc) =>
        tc.id.startsWith('text_tool_'),
      );

      // Drain attachments queued by show_to_user during prior tool calls
      // in this turn. The runtime owns assistant-message persistence, so
      // we attach here rather than letting the tool insert a synthetic
      // message (which would break tool_use/tool_result alternation).
      //
      // v2.9.20: ONLY drain on text-bearing iterations. Tool-only
      // iterations (no text + tool_use blocks) render as compact tool
      // pills in non-wordy mode and have no slot to display
      // attachments - draining onto them silently swallowed the files.
      // The 2026-06-06 JJ-report incident lost the deliverable this
      // way: show_to_user → tracker_complete_step → end. Attachments
      // drained onto the tracker_complete_step pill and vanished. Now
      // the queue persists across tool iterations and only drains
      // when text accompanies the persist - and an end-of-turn safety
      // net catches anything still queued so files can't be lost.
      const { drainPendingAttachments } = await import('../pending-attachments.js');
      const hasTerminalTextThisIter = !!(persistedContent && persistedContent.trim().length > 0);
      const queuedAttachments = hasTerminalTextThisIter ? drainPendingAttachments(agentId) : [];
      const queuedAttachmentsJson =
        queuedAttachments.length > 0 ? JSON.stringify(queuedAttachments) : null;

      // Build content for persistence (text + tool_use blocks if any)
      const effectiveModelIdForPersist =
        state.modelId === '__auto__' ? configuredModelId : state.modelId;

      if (result.toolCalls.length > 0 && !hasXmlFallbackTools) {
        // v2.9.16: voice-mode filler. When a voice-triggered turn is
        // about to run tools AND the model produced no pre-tool text
        // of its own ("let me check that"), push a short random
        // acknowledgment into the active TTS burst so the user doesn't
        // sit in silence while tools execute. Once per turn, works
        // with both local (Kokoro) and cloud (Hume) TTS engines via
        // the engine-agnostic push handle on the voice session.
        if (
          !voiceFillerFired &&
          latestUserSource === 'voice' &&
          (persistedContent ?? '').trim().length === 0
        ) {
          try {
            const { pickFillerPhrase } = await import('../../voice/filler-phrases.js');
            const { pushVoiceFiller } = await import('../../voice/voice-ws.js');
            const phrase = pickFillerPhrase();
            const pushed = pushVoiceFiller(agentId, phrase);
            if (pushed) {
              voiceFillerFired = true;
              logger.info('Voice filler pushed before tool execution', {
                agentId, phrase, toolCount: result.toolCalls.length,
              }, agentId);
            }
          } catch (err) {
            logger.warn('Voice filler push failed (non-fatal)', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        }

        // v2.9.23 — same filler logic for live phone calls. Tool calls
        // are the only path that produces noticeable latency on phone
        // (a plain text reply now streams sentence-by-sentence via the
        // onChunk pipe above). When the model jumps straight to tools
        // with no opener text, push a short filler to the CallSession
        // so the caller hears something instead of dead air. Caller
        // hears "On it" / "One sec" / "Let me check" within ~150 ms
        // of finishing their utterance.
        if (
          !voiceFillerFired &&
          phoneStreamCallSid &&
          inboundChannel === 'phone' &&
          (persistedContent ?? '').trim().length === 0
        ) {
          try {
            const { pickFillerPhrase } = await import('../../voice/filler-phrases.js');
            const { getCallSession } = await import('../../twilio/call-session.js');
            const phrase = pickFillerPhrase();
            const session = getCallSession(phoneStreamCallSid);
            if (session && !session.isEnded()) {
              await session.queueAgentSay(phrase);
              voiceFillerFired = true;
              logger.info('Phone filler pushed before tool execution', {
                agentId, callSid: phoneStreamCallSid, phrase, toolCount: result.toolCalls.length,
              }, agentId);
            }
          } catch (err) {
            logger.warn('Phone filler push failed (non-fatal)', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        }
        const assistantContent: Anthropic.ContentBlockParam[] = [];
        if (persistedContent) {
          assistantContent.push({ type: 'text', text: persistedContent });
        }
        for (const tc of result.toolCalls) {
          assistantContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, token_count, model_id, cost, latency_ms, turn_number, reasoning_content, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, NULL, ?, ?, datetime('now'))
        `).run(
          messageId,
          agentId,
          JSON.stringify(assistantContent),
          queuedAttachmentsJson,
          result.outputTokens,
          effectiveModelIdForPersist,
          null,
          turnNumber,
          result.reasoningContent ?? null,
        );
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: messageId,
            agentId,
            role: 'assistant' as Message['role'],
            content: JSON.stringify(assistantContent),
            tokenCount: null,
            modelId: effectiveModelIdForPersist,
            cost: null,
            latencyMs: null,
            createdAt: new Date().toISOString(),
            attachments: queuedAttachments.length > 0 ? queuedAttachments : undefined,
            reasoningContent: result.reasoningContent ?? undefined,
          },
        });
        // v2.7.24 — also track text-with-tools iterations as deliverable
        // assistant text. Previously this branch ran (because there are
        // tool calls) without updating lastAssistantTextForIM, which meant
        // a turn shaped "text + tool call → tool result → [no-reply]" would
        // leave the channel-routing block with nothing to deliver. The
        // user's substantive answer (the text in iter 1) never reached
        // iMessage / Teams / email. Capturing the LAST iteration's text
        // regardless of whether tools rode with it gives the routing
        // block the right value to deliver at end-of-turn.
        if (persistedContent && persistedContent.trim().length > 0) {
          state = advance(state, { lastAssistantTextForIM: persistedContent.trim() });
        }
      } else if (persistedContent) {
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, token_count, model_id, cost, latency_ms, turn_number, reasoning_content, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, NULL, ?, ?, datetime('now'))
        `).run(
          messageId,
          agentId,
          persistedContent,
          queuedAttachmentsJson,
          result.outputTokens,
          effectiveModelIdForPersist,
          null,
          turnNumber,
          result.reasoningContent ?? null,
        );
        if (persistedContent.trim().length > 0) {
          state = advance(state, { lastAssistantTextForIM: persistedContent.trim() });
        }
        // Per v1 runtime.ts:1303-1318 — text-only response. The streaming
        // chunks already delivered the text live, so we'd dupe-render if we
        // unconditionally fired chat:message. With attachments present,
        // however, the dashboard's chat:message handler updates the streaming
        // bubble in-place to ATTACH the files — that's the only way the
        // attachments reach the live UI without a page reload.
        if (queuedAttachments.length > 0) {
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: messageId,
              agentId,
              role: 'assistant' as Message['role'],
              content: persistedContent,
              tokenCount: null,
              modelId: effectiveModelIdForPersist,
              cost: null,
              latencyMs: null,
              createdAt: new Date().toISOString(),
              attachments: queuedAttachments,
            },
          });
        }
      }

      // Broadcast streaming complete (only if we actually streamed something)
      if ((persistedContent && persistedContent.trim().length > 0) || result.toolCalls.length > 0) {
        broadcast({
          type: 'chat:chunk',
          agentId,
          messageId,
          content: '',
          done: true,
          modelId: state.modelId === '__auto__' ? configuredModelId : state.modelId,
        });
      }

      // No tools? Loop is done.
      if (result.toolCalls.length === 0) {
        // ── v2.7.17: "added a note then stopped" detector ──
        // Common failure: agent is mid-project, calls tracker_add_notes as
        // a status checkpoint, then ends the turn silently because the
        // model treats the note as a stopping point. The user is left
        // wondering why the agent went idle. Detect that pattern and
        // fire a one-shot nudge before the turn ends.
        //
        // Conditions:
        //   - had any tool calls this turn
        //   - LAST tool call was tracker_add_notes
        //   - the target task is still in_progress
        //   - not already nudged this turn (one-shot, no loop)
        if (
          !state.nudgedForAddNotesStopThisTurn &&
          state.toolResults.length > 0
        ) {
          const lastTool = state.toolResults[state.toolResults.length - 1];
          if (lastTool && lastTool.name === 'tracker_add_notes') {
            // Pull the task_id from the original tool call args. The args
            // live on the matching toolCall record by id; search both lists.
            let nudgedTaskId: string | null = null;
            for (let i = state.toolCalls.length - 1; i >= 0; i--) {
              const tc = state.toolCalls[i];
              if (tc.id === lastTool.toolCallId && tc.name === 'tracker_add_notes') {
                const tid = (tc.arguments as { task_id?: unknown })?.task_id;
                if (typeof tid === 'string') nudgedTaskId = tid;
                break;
              }
            }
            if (nudgedTaskId) {
              const row = db.prepare('SELECT status, title FROM tasks WHERE id = ?').get(nudgedTaskId) as { status?: string; title?: string } | undefined;
              if (row?.status === 'in_progress') {
                const titleShort = (row.title ?? '').slice(0, 60);
                const nudgeText = (
                  `[System: you just added a note to "${titleShort}" (${nudgedTaskId.slice(0, 8)}) but did not say what comes next. ` +
                  `That task is STILL in_progress. If you have more work to do on it, KEEP GOING - call your next tool now, do not end the turn. ` +
                  `If you are genuinely waiting on something (user input, an external response, a scheduled time), say so explicitly: ` +
                  `update the task status to "blocked" or "paused" with a clear reason, OR write one sentence in your reply telling the user what you are waiting for. ` +
                  `Silently going idle after tracker_add_notes leaves the user with no idea what is happening.]`
                );
                const nudgeId = uuidv4();
                db.prepare(`
                  INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
                  VALUES (?, ?, 'system', ?, ?, datetime('now'))
                `).run(nudgeId, agentId, nudgeText, turnNumber);
                broadcast({
                  type: 'chat:message',
                  agentId,
                  message: {
                    id: nudgeId, agentId, role: 'system' as const,
                    content: nudgeText,
                    tokenCount: null, modelId: null, cost: null, latencyMs: null,
                    createdAt: new Date().toISOString(),
                  },
                });
                state = advance(state, { nudgedForAddNotesStopThisTurn: true });
                logger.info('v2 add-notes-stop nudge fired', { agentId, taskId: nudgedTaskId }, agentId);
                continue; // re-enter the loop so the model sees the nudge
              }
            }
          }
        }

        // ── v2.7.17: "going idle with in_progress task" detector ──
        // Broader sibling of the add-notes-stop nudge. Catches every case
        // where the agent ends a turn while a task assigned to them is
        // still in_progress AND they did not transition it this turn.
        // Walks them through the decision matrix - keep going, mark
        // complete, mark paused (waiting on user), or mark blocked
        // (needs escalation). One-shot so a model that insists on
        // stopping doesn't trigger a loop.
        //
        // Skip if the close-out gate is already armed for this turn
        // (the gate's own message + dispatcher already covers the case)
        // or the add-notes-stop nudge just fired (we just told them).
        if (
          !state.nudgedForGoingIdleWithInProgressThisTurn &&
          !state.nudgedForAddNotesStopThisTurn &&
          !state.nudgedForCloseOutThisTurn
        ) {
          // Find in_progress tasks assigned to this agent. Use the same
          // criterion the close-out gate uses but at end-of-turn instead
          // of start: any in_progress task at all (even one touched this
          // turn) qualifies, because the issue isn't staleness - it's
          // that the agent went idle without resolving its state.
          const openTasks = db.prepare(`
            SELECT id, title FROM tasks
            WHERE assigned_to = ?
              AND status = 'in_progress'
              AND is_paused = 0
            ORDER BY updated_at DESC
            LIMIT 5
          `).all(agentId) as Array<{ id: string; title: string }>;

          // Skip if no in_progress tasks - then the agent is fine to idle.
          // Also skip if the agent ALREADY transitioned a task this turn
          // (any tracker_update_status / tracker_complete_step call), since
          // that signals they DID make a deliberate state choice and just
          // happened to leave another task in_progress for legitimate reasons.
          const transitionedThisTurn = state.toolResults.some(
            tr => tr.name === 'tracker_update_status' || tr.name === 'tracker_complete_step' || tr.name === 'tracker_close_project',
          );

          if (openTasks.length > 0 && !transitionedThisTurn) {
            // v2.10.2 — detect scheduler-triggered turns AND scan this
            // turn's tool_results for side-effecting calls that
            // returned success. Pre-fix, the agent had to read a
            // 4-option menu and construct result+evidence themselves,
            // and frequently just emitted "08 done" as text. When
            // we can see "you just ran gmail_send and got [SENT]",
            // surfacing that inline makes the close-out mechanical.
            //
            // Signal source is `state.toolResults` (in-memory, this
            // turn) rather than task_log — most tools don't write
            // per-task log entries when called, so a task_log scan
            // would almost always come up empty.
            const isSchedulerTriggered = (lastUserMessageContent ?? '').includes('[SOURCE: SCHEDULER');
            const NON_IDEMPOTENT_TOOLS = new Set([
              'gmail_send', 'outlook_send', 'gmail_reply', 'outlook_reply',
              'imessage_send', 'sms_send', 'teams_send_message',
              'voice_call', 'calendar_create', 'calendar_update',
              'drive_upload', 'docs_create', 'sheets_create', 'slides_create',
              'share_publicly', 'exec',
            ]);
            const recentSideEffects: Array<{ name: string; preview: string }> = [];
            for (let i = state.toolResults.length - 1; i >= 0 && recentSideEffects.length < 4; i--) {
              const tr = state.toolResults[i];
              if (!tr.name || !NON_IDEMPOTENT_TOOLS.has(tr.name)) continue;
              if (tr.isError) continue;
              const preview = (tr.content ?? '').replace(/\s+/g, ' ').slice(0, 160);
              recentSideEffects.push({ name: tr.name, preview });
            }
            const taskList = openTasks
              .map(t => `  - "${t.title.slice(0, 60)}" (${t.id.slice(0, 8)})`)
              .join('\n');
            const schedulerHint = isSchedulerTriggered
              ? `\n**This turn was scheduler-triggered.** Scheduler-fired tasks rarely need option (1) KEEP GOING — the scheduler does the repetition, not you. The right answer here is almost always option (2) DONE.\n`
              : '';
            const auditHint = recentSideEffects.length > 0
              ? `\nYou successfully called ${recentSideEffects.length === 1 ? 'a side-effecting tool' : 'side-effecting tools'} this turn:\n` +
                recentSideEffects.map(s => `  - \`${s.name}\` returned: ${s.preview}`).join('\n') + `\n\n` +
                `These are NON-IDEMPOTENT actions that already executed. Re-running them would duplicate the side effect (double email, double text, double charge). The work is done. Close the task NOW:\n` +
                `\`tracker_update_status(task_id="${openTasks[0].id}", status="complete", result="<one-line summary of what landed>", evidence=[{kind: "tool_call_ref", claim: "${recentSideEffects[0].name} succeeded"}])\`\n`
              : '';
            const nudgeText = (
              `[System: you are about to end this turn with ${openTasks.length} task${openTasks.length === 1 ? '' : 's'} still in_progress and assigned to you:\n` +
              `${taskList}\n` +
              schedulerHint +
              auditHint +
              `\nPick exactly one of these before ending the turn:\n\n` +
              `  1. KEEP GOING - call your next tool NOW to continue from EXACTLY where you stopped. Long file reads, batch operations, multi-step processes — don't restart, don't re-read content you already processed, just advance to the next line / next item / next step.\n` +
              `  2. DONE - tracker_update_status(task_id, status="complete", result="...", evidence=[...]) (or tracker_complete_step for multi-step projects).\n` +
              `  3. WAITING ON USER (already asked them) - tracker_update_status(task_id, status="paused", notes="waiting for X"). PM will ignore this task entirely; no pokes.\n` +
              `  4. BLOCKED (needs escalation - user does not know yet) - tracker_update_status(task_id, status="blocked", notes="why"). PM will surface this to the primary user.\n\n` +
              `If you go idle with a task still in_progress, the engine will auto-pause it and escalate to PM. Pre-fix for non-idempotent tasks (gmail_send, sms_send, voice_call, exec hitting live APIs), PM was then forced into a re-run remediation that duplicated the side effect. Save everyone the work: close the task now.]`
            );
            const nudgeId = uuidv4();
            db.prepare(`
              INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
              VALUES (?, ?, 'system', ?, ?, datetime('now'))
            `).run(nudgeId, agentId, nudgeText, turnNumber);
            broadcast({
              type: 'chat:message',
              agentId,
              message: {
                id: nudgeId, agentId, role: 'system' as const,
                content: nudgeText,
                tokenCount: null, modelId: null, cost: null, latencyMs: null,
                createdAt: new Date().toISOString(),
              },
            });
            state = advance(state, { nudgedForGoingIdleWithInProgressThisTurn: true });
            logger.info('v2 going-idle-with-in_progress nudge fired', {
              agentId, openTaskCount: openTasks.length, taskIds: openTasks.map(t => t.id),
            }, agentId);
            continue; // re-enter the loop so the model sees the nudge
          }
        }

        // 2026-06-02 hardcap: if the going-idle-with-in_progress nudge
        // already fired this turn and the model STILL produced a user-
        // facing "Done" / "All set" message without calling
        // tracker_update_status, AUTO-PAUSE the danglers AND suppress
        // the misleading assistant text. The user must not see "Done"
        // while the tracker still shows in_progress; that's the exact
        // failure shape David reported on the iMessage profile run.
        if (
          state.nudgedForGoingIdleWithInProgressThisTurn &&
          !state.toolResults.some(
            tr => tr.name === 'tracker_update_status' || tr.name === 'tracker_complete_step' || tr.name === 'tracker_close_project',
          ) &&
          persistedContent && persistedContent.trim().length > 0
        ) {
          // Re-query in-progress tasks at the moment of escalation.
          const danglerRows = db.prepare(`
            SELECT id, title FROM tasks
            WHERE assigned_to = ?
              AND status = 'in_progress'
              AND is_paused = 0
            ORDER BY updated_at DESC
            LIMIT 10
          `).all(agentId) as Array<{ id: string; title: string }>;
          if (danglerRows.length > 0) {
            // Delete the just-streamed assistant message so the user does
            // not see "Done" while the tracker shows in_progress.
            try {
              db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
            } catch (delErr) {
              logger.warn('v2: idle-with-in_progress hardcap — failed to delete suppressed assistant message', {
                agentId, messageId, error: delErr instanceof Error ? delErr.message : String(delErr),
              }, agentId);
            }
            try {
              broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
              broadcast({
                type: 'chat:message',
                agentId,
                message: {
                  id: messageId, agentId, role: 'assistant' as const,
                  content: '',
                  tokenCount: null, modelId: null, cost: null, latencyMs: null,
                  createdAt: new Date().toISOString(),
                },
              });
            } catch { /* best effort */ }

            const note = `[${new Date().toISOString()}] Auto-paused by engine: agent "${agentId}" ignored the going-idle-with-in_progress nudge (produced closeout text without calling tracker_update_status). User: reassign or resolve manually from the dashboard.`;
            // v2.9.22 — engine-initiated pause is authoritative; PM does
            // not need to re-validate it via UNVALIDATED_PAUSE. The
            // dedicated escalateCloseoutMissToPM A2A below already gives
            // PM the verb menu (retask / override / validate). Pre-fix
            // (pause_validated=0), PM would re-flag the auto-pause every
            // tick, reject as "empty reason" (because PM read pause
            // reasons from observation/legacy_note entries, not auto_sweep),
            // revert to in_progress, and the cycle started over until
            // someone killed the agent (production incident 2026-06-07).
            const pauseStmt = db.prepare(`
              UPDATE tasks
              SET status = 'paused', is_paused = 1, status_before_pause = 'in_progress',
                  pause_validated = 1,
                  updated_at = datetime('now')
              WHERE id = ? AND status = 'in_progress'
                AND repeat_interval IS NULL
            `);
            // RECURRING TASKS CARVE-OUT.
            // Pre-fix this UPDATE matched every in_progress task without
            // checking repeat_interval, so a single missed close-out on
            // a daily recurring task (Tomorrow Brief, the user's
            // example) silently paused the WHOLE recurring schedule —
            // is_paused=1 makes the scheduler skip it forever. The
            // right behavior for recurring tasks is: fail THIS run,
            // recompute next_run_at, let the schedule fire normally
            // tomorrow. forceResetStuckRecurringTask does exactly that.
            const { forceResetStuckRecurringTask } = await import('../../scheduler/runner.js');
            const recurringResetIds: string[] = [];
            let pausedCount = 0;
            const pausedIds: string[] = [];
            for (const r of danglerRows) {
              const isRecurring = db.prepare(`SELECT repeat_interval FROM tasks WHERE id = ?`).get(r.id) as { repeat_interval: number | null } | undefined;
              if (isRecurring?.repeat_interval) {
                try { forceResetStuckRecurringTask(r.id); recurringResetIds.push(r.id); } catch { /* best effort */ }
                continue;
              }
              const res = pauseStmt.run(r.id);
              if (res.changes > 0) {
                pausedCount++;
                pausedIds.push(r.id);
                // Phase B.0: audit the auto-pause as a transition entry.
                try {
                  const { writeTaskLog } = await import('../../tracker/task-log.js');
                  writeTaskLog({
                    taskId: r.id,
                    fromEntity: 'engine',
                    entryKind: 'auto_sweep',
                    fromStatus: 'in_progress',
                    toStatus: 'paused',
                    actionTaken: 'idle-with-in_progress hardcap auto-pause',
                    reason: 'agent produced closeout text without calling tracker_update_status after the nudge fired',
                    note,
                  });
                } catch { /* best effort */ }
              }
            }

            const parts: string[] = [];
            if (pausedCount > 0) {
              parts.push(`${pausedCount} one-shot dangling task${pausedCount === 1 ? '' : 's'} auto-paused (ids: ${pausedIds.slice(0, 5).map((id) => id.slice(0, 8)).join(', ')}${pausedIds.length > 5 ? '...' : ''})`);
            }
            if (recurringResetIds.length > 0) {
              parts.push(`${recurringResetIds.length} recurring task${recurringResetIds.length === 1 ? '' : 's'} reset to fire on schedule (ids: ${recurringResetIds.slice(0, 5).map((id) => id.slice(0, 8)).join(', ')}${recurringResetIds.length > 5 ? '...' : ''}) — your missed close-out failed THIS run, not the whole schedule`);
            }
            const escMsg = (
              `[System: idle-with-in_progress nudge was unsatisfied AND you produced user-facing text — your reply was suppressed (the bubble was removed from the user's view). ${parts.join('; ')}. ` +
              `Next time you finish a task, the FIRST action of your final turn must be tracker_update_status(status="complete", result="...", evidence=[...]). The user did not see your closeout; there is nothing to reply to.${pausedCount > 0 ? ' PM will re-validate the paused one-shot state and may revert.' : ''}]`
            );
            const escId = uuidv4();
            try {
              db.prepare(`
                INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
                VALUES (?, ?, 'system', ?, ?, datetime('now'))
              `).run(escId, agentId, escMsg, turnNumber);
              broadcast({
                type: 'chat:message',
                agentId,
                message: {
                  id: escId, agentId, role: 'system' as const,
                  content: escMsg,
                  tokenCount: null, modelId: null, cost: null, latencyMs: null,
                  createdAt: new Date().toISOString(),
                },
              });
            } catch { /* best effort */ }
            try {
              const { getTask } = await import('../../tracker/schema.js');
              for (const id of pausedIds) {
                const t = getTask(id);
                if (t) broadcast({ type: 'tracker:task_updated', data: t } as never);
              }
            } catch { /* best effort */ }
            logger.warn('v2 idle-with-in_progress hardcap fired — auto-paused + suppressed reply', {
              agentId, pausedCount, pausedIds, recurringResetCount: recurringResetIds.length, recurringResetIds,
            }, agentId);
            // v2.9.13: actively escalate to PM with full context (the
            // suppressed text, the goals, the verb menu) so PM can
            // retask the agent instead of rubber-stamping the pause
            // via the next periodic situation report.
            if (pausedIds.length > 0) {
              try {
                const { escalateCloseoutMissToPM } = await import('../../tracker/pm-agent.js');
                await escalateCloseoutMissToPM({
                  agentId,
                  pausedTaskIds: pausedIds,
                  suppressedText: persistedContent ?? '',
                  source: 'idle-hardcap',
                });
              } catch (escErr) {
                logger.warn('v2: idle hardcap closeout-miss escalation failed (non-fatal)', {
                  agentId, error: escErr instanceof Error ? escErr.message : String(escErr),
                }, agentId);
              }
            }
            setAgentStatus(agentId, 'idle');
            break;
          }
        }

        // v2.5.31 — Hardcap: if the missed-reply nudge already fired once
        // for this assign id and the LLM STILL produced text-no-tool, end
        // the turn instead of nudging again. This is the loop-breaker for
        // models that genuinely can't be talked into a tool call by a
        // system message (they pattern-match "user wants summary" and
        // ignore the directive). Pre-fix this looped ~30 times before
        // the time/token budget killed it (loop.txt 2026-05-13).
        if (
          a2aReplyAssignMessageId &&
          state.nudgedForMissedReplyOnAssignId === a2aReplyAssignMessageId &&
          !state.sentToAgentThisTurn &&
          persistedContent && persistedContent.trim().length > 0
        ) {
          const stopMsg = (
            `[System: Ending turn — the missed-reply nudge fired but the agent kept writing text instead of calling send_to_agent. ` +
            `The inbound A2A message remains marked as unreplied; manual intervention may be needed. ` +
            `(Hardcap engaged to prevent the v2.5.30-and-earlier nudge spiral.)]`
          );
          const stopId = uuidv4();
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'system', ?, ?, datetime('now'))
          `).run(stopId, agentId, stopMsg, turnNumber);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: stopId, agentId, role: 'system' as const,
              content: stopMsg,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
          break;
        }

        // Missed-reply nudge (subsumes v1 runtime.ts:1344-1378)
        const replyDecision = a2aReplyEnforcer({
          triggeredByReplyNeededIntent: a2aReplyContext !== null,
          sentToAgentThisTurn: state.sentToAgentThisTurn,
          alreadyNudgedForMissedReply:
            !!a2aReplyAssignMessageId && state.nudgedForMissedReplyOnAssignId === a2aReplyAssignMessageId,
          agentProducedText: !!(persistedContent && persistedContent.trim().length > 0),
          intent: a2aReplyContext?.intent,
          threadShort: a2aReplyContext?.threadShort,
          fromName: a2aReplyContext?.fromName,
          // v2.5.31 — soften the nudge text when we know the agent already
          // replied earlier on this thread. Prevents the "system says
          // receiver got nothing but I sent the message" cognitive
          // dissonance that drove the loop.txt spiral.
          priorReplyOnSameThread:
            !!a2aReplyContext?.threadShort && hasPriorReplyOnThread(agentId, a2aReplyContext.threadShort),
        });
        if (replyDecision.decision === 'nudge') {
          const nudgeId = uuidv4();
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'system', ?, ?, datetime('now'))
          `).run(nudgeId, agentId, replyDecision.nudgeText, turnNumber);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: nudgeId, agentId, role: 'system' as const,
              content: replyDecision.nudgeText,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
          // Mark the nudge as fired for this assign id so the next
          // iteration's enforcer call returns no_action and the hardcap
          // above engages if the agent doubles down on text.
          if (a2aReplyAssignMessageId) {
            state = advance(state, { nudgedForMissedReplyOnAssignId: a2aReplyAssignMessageId });
          }
          // Continue loop so the agent reads the nudge and retries
          continue;
        }

        // ── End-of-turn tracker close-out check (v2.5.40) ──
        // Common failure: agent opens a project, marks task 1 in_progress,
        // does the work, never marks it complete (or any subsequent task).
        // Stella's poke chain eventually catches it but costs a 30-min
        // wait. Detect at the moment of failure: agent is ending the turn
        // with text, has at least one in_progress task assigned, AND made
        // no tracker_update_status / tracker_complete_step call this turn.
        //
        // Hardcap mirrors the A2A enforcer: if the agent already saw the
        // nudge once this turn and STILL produces text without updating
        // tracker status, end the turn cleanly. Don't loop forever.
        const agentProducedText = !!(persistedContent && persistedContent.trim().length > 0);
        if (agentProducedText) {
          // ── v2.5.46: pre-turn close-out gate — one-shot enforcement ──
          // The pre-turn system message already gave the agent a chance
          // to engage with the tracker BEFORE generating any response.
          // If they produced text instead of calling a tracker tool,
          // they've forfeited the chance. Auto-pause the danglers
          // immediately and end the turn.
          //
          // No "second chance" hard nudge: the prior implementation
          // streamed a second response to the user before the duplicate
          // detector could suppress it — the user saw two responses.
          // One shot, then engine takeover.
          if (
            state.danglingTaskIds.length > 0 &&
            !state.closeOutGateSatisfied
          ) {
            // ── Suppress the duplicate user-facing summary ──
            // The agent just streamed a response that the user has seen in
            // real-time. Without this block, that text remained in the DB
            // and on screen as a second reply — the failure shape the user
            // reported on the Presenton run (May 2026). The gate already
            // told the agent "do NOT generate a user-facing response on
            // this turn"; if they did anyway, we erase the bubble.
            //
            // Steps:
            //   1. Delete the just-persisted assistant message so the next
            //      turn's assembled context doesn't include it (the agent
            //      can't reference work that the user never saw).
            //   2. Broadcast chat:chunk done:true content:'' to close out
            //      the streaming bubble in the dashboard.
            //   3. Broadcast chat:message with empty content to make the
            //      bubble disappear from the chat (matches the [no-reply]
            //      sentinel handling at the top of this same block).
            try {
              db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
            } catch (delErr) {
              logger.warn('v2: close-out — failed to delete suppressed assistant message', {
                agentId, messageId, error: delErr instanceof Error ? delErr.message : String(delErr),
              }, agentId);
            }
            try {
              broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
              broadcast({
                type: 'chat:message',
                agentId,
                message: {
                  id: messageId, agentId, role: 'assistant' as const,
                  content: '',
                  tokenCount: null, modelId: null, cost: null, latencyMs: null,
                  createdAt: new Date().toISOString(),
                },
              });
            } catch { /* best effort */ }

            try {
              // Distinguish the two kinds of danglers so the auto-pause
              // logic only touches in_progress rows (paused makes sense
              // there); on_deck stragglers stay on_deck — the user can
              // decide whether to reassign or close the project.
              const inProgressIds = db
                .prepare(
                  `SELECT id FROM tasks WHERE id IN (${state.danglingTaskIds.map(() => '?').join(',')}) AND status = 'in_progress'`,
                )
                .all(...state.danglingTaskIds) as Array<{ id: string }>;
              const onDeckIds = state.danglingTaskIds.filter(
                (id) => !inProgressIds.some((r) => r.id === id),
              );

              const noteTemplate = `[${new Date().toISOString()}] Auto-paused by engine: agent "${agentId}" ignored the pre-turn close-out gate (produced a user-facing response without calling tracker_update_status / tracker_complete_step / tracker_add_notes / tracker_close_project). User: reassign or resolve manually from the dashboard.`;
              // v2.9.22 — pause_validated=1 for the same reason as the
              // going-idle hardcap path above. Engine pause is the
              // authority; PM gets a dedicated closeout_miss A2A
              // (below) and doesn't need to re-flag via UNVALIDATED_PAUSE.
              const updateStmt = db.prepare(`
                UPDATE tasks
                SET status = 'paused', is_paused = 1, status_before_pause = 'in_progress',
                    pause_validated = 1,
                    notes = COALESCE(notes, '') || ? || char(10),
                    updated_at = datetime('now')
                WHERE id = ? AND status = 'in_progress'
                  AND repeat_interval IS NULL
              `);
              // Same recurring carve-out as the going-idle hardcap above.
              // Single missed close-out on a recurring task fails THIS
              // run via forceResetStuckRecurringTask, not the whole
              // schedule.
              const { forceResetStuckRecurringTask } = await import('../../scheduler/runner.js');
              const recurringResetIds: string[] = [];
              let pausedCount = 0;
              const pausedIds: string[] = [];
              for (const tid of inProgressIds.map((r) => r.id)) {
                const isRecurring = db.prepare(`SELECT repeat_interval FROM tasks WHERE id = ?`).get(tid) as { repeat_interval: number | null } | undefined;
                if (isRecurring?.repeat_interval) {
                  try { forceResetStuckRecurringTask(tid); recurringResetIds.push(tid); } catch { /* best effort */ }
                  continue;
                }
                const res = updateStmt.run(noteTemplate, tid);
                if (res.changes > 0) {
                  pausedCount++;
                  pausedIds.push(tid);
                }
              }

              if (pausedCount > 0 || recurringResetIds.length > 0 || onDeckIds.length > 0) {
                const parts: string[] = [];
                if (pausedCount > 0) {
                  parts.push(
                    `${pausedCount} one-shot in_progress dangler${pausedCount === 1 ? '' : 's'} auto-paused (ids: ${inProgressIds.slice(0, 5).map((r) => r.id.slice(0, 8)).join(', ')}${inProgressIds.length > 5 ? '...' : ''})`,
                  );
                }
                if (recurringResetIds.length > 0) {
                  parts.push(`${recurringResetIds.length} recurring task${recurringResetIds.length === 1 ? '' : 's'} reset to fire on schedule (ids: ${recurringResetIds.slice(0, 5).map((id) => id.slice(0, 8)).join(', ')}${recurringResetIds.length > 5 ? '...' : ''}) — your missed close-out failed THIS run, not the whole schedule`);
                }
                if (onDeckIds.length > 0) {
                  parts.push(
                    `${onDeckIds.length} stranded on_deck task${onDeckIds.length === 1 ? '' : 's'} left in place for you to resolve next turn (ids: ${onDeckIds.slice(0, 5).map((id) => id.slice(0, 8)).join(', ')}${onDeckIds.length > 5 ? '...' : ''}) — call tracker_close_project on the parent project, or reassign the tasks`,
                  );
                }
                const closeOutMsg = (
                  `[System: pre-turn close-out gate was unsatisfied AND you produced user-facing text — your reply was suppressed (the bubble was removed from the user\'s view) and the danglers were resolved by the engine: ${parts.join('; ')}. ` +
                  `Next time the gate fires, the FIRST thing you do this turn must be a tracker tool call. The user sent NO new prompt to read — there is nothing to reply to until the tracker is in sync.]`
                );
                const closeOutMsgId = uuidv4();
                try {
                  db.prepare(`
                    INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
                    VALUES (?, ?, 'system', ?, ?, datetime('now'))
                  `).run(closeOutMsgId, agentId, closeOutMsg, turnNumber);
                  broadcast({
                    type: 'chat:message',
                    agentId,
                    message: {
                      id: closeOutMsgId, agentId, role: 'system' as const,
                      content: closeOutMsg,
                      tokenCount: null, modelId: null, cost: null, latencyMs: null,
                      createdAt: new Date().toISOString(),
                    },
                  });
                } catch { /* best effort */ }
                try {
                  const { getTask } = await import('../../tracker/schema.js');
                  for (const tid of state.danglingTaskIds) {
                    const updatedTask = getTask(tid);
                    if (updatedTask) {
                      broadcast({ type: 'tracker:task_updated', data: updatedTask } as never);
                    }
                  }
                } catch { /* best effort */ }
                logger.warn('v2: close-out one-shot escalation — auto-paused + suppressed reply', {
                  agentId, pausedCount, onDeckCount: onDeckIds.length, totalDangling: state.danglingTaskIds.length,
                }, agentId);
                // v2.9.13: notify PM with the suppressed text + verbs.
                if (pausedIds.length > 0) {
                  try {
                    const { escalateCloseoutMissToPM } = await import('../../tracker/pm-agent.js');
                    await escalateCloseoutMissToPM({
                      agentId,
                      pausedTaskIds: pausedIds,
                      suppressedText: persistedContent ?? '',
                      source: 'pre-turn-gate',
                    });
                  } catch (escErr) {
                    logger.warn('v2: pre-turn gate closeout-miss escalation failed (non-fatal)', {
                      agentId, error: escErr instanceof Error ? escErr.message : String(escErr),
                    }, agentId);
                  }
                }
              }
            } catch (escErr) {
              logger.error('v2: close-out one-shot escalation failed', {
                agentId, error: escErr instanceof Error ? escErr.message : String(escErr),
              }, agentId);
            }
            break;
          }

          if (
            state.nudgedForTrackerCloseThisTurn &&
            !state.trackerStatusUpdatedThisTurn
          ) {
            // Hardcap: nudge fired once and was ignored. End the turn.
            // Stella will catch the dangling tasks on her next poke pass.
            logger.warn('v2: tracker close-out nudge ignored — ending turn anyway', {
              agentId,
            }, agentId);
            break;
          }

          if (
            !state.nudgedForTrackerCloseThisTurn &&
            !state.trackerStatusUpdatedThisTurn &&
            state.nonTrackerToolCalls > 0
          ) {
            let openTasks: Array<{ id: string; title: string }> = [];
            try {
              const { listTasks } = await import('../../tracker/schema.js');
              const inProgress = listTasks({ status: 'in_progress', assignedTo: agentId });
              openTasks = inProgress.map((t) => ({ id: t.id, title: t.title }));
            } catch (err) {
              logger.warn('Tracker close-out nudge: listTasks failed', {
                agentId, err: err instanceof Error ? err.message : String(err),
              }, agentId);
            }
            if (openTasks.length > 0) {
              const taskList = openTasks
                .map((t) => `  - "${t.title}" (${t.id.slice(0, 8)})`)
                .join('\n');
              // v2.5.42 — rewritten to a direct, action-only command.
              // Prior wording was a paragraph with an "or end your turn
              // silently" escape hatch. Field test showed DeepSeek V4 Pro
              // ignoring the escape and re-running the whole response,
              // producing a duplicate reply to the user. The user noticed
              // immediately ("notice that something triggered him to do
              // it twice now"). New wording: tool call ONLY, no text,
              // explicit "do not repeat your prior message" guardrail.
              const nudgeText = (
                `[System: ${openTasks.length} in_progress task${openTasks.length === 1 ? '' : 's'} assigned to you was not closed out this turn:\n` +
                `${taskList}\n` +
                `REQUIRED ACTION: call tracker_complete_step (for multi-step projects) or tracker_update_status (complete | blocked | paused) on each task above. Make ONLY the tool call(s). Do NOT write any user-facing text — the user already received your previous response and a duplicate reply is worse than a stale tracker. ` +
                `If a task is genuinely still in progress, end your turn now with NO text output (no tool call, no message); the engine will continue you on the next user turn.]`
              );
              const nudgeId = uuidv4();
              db.prepare(`
                INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
                VALUES (?, ?, 'system', ?, ?, datetime('now'))
              `).run(nudgeId, agentId, nudgeText, turnNumber);
              broadcast({
                type: 'chat:message',
                agentId,
                message: {
                  id: nudgeId, agentId, role: 'system' as const,
                  content: nudgeText,
                  tokenCount: null, modelId: null, cost: null, latencyMs: null,
                  createdAt: new Date().toISOString(),
                },
              });
              state = advance(state, { nudgedForTrackerCloseThisTurn: true });
              logger.info('v2: tracker close-out nudge fired', {
                agentId, openTaskCount: openTasks.length,
              }, agentId);
              continue;
            }
          }
        }

        break;
      }

      // ── Engine-injected ack — DISABLED ──
      //
      // The v2 plan called for an engine-written ack ("Working on it…") to fire
      // when the agent goes straight to a tool call without text. In practice
      // this turned out to be both noise AND structurally broken: the ack was
      // persisted as a system message into the messages table BETWEEN the
      // assistant's tool_use and its matching tool_result — which violates the
      // conversation invariant (tool_use and tool_result must be in adjacent
      // messages). The assembler's defensive `sanitizeToolPairs` would then
      // drop both messages from context, and the model would re-issue the
      // tool call on the next turn because it lost memory of running it.
      //
      // The chat:tool_call broadcast (fired by executePhase below) already
      // serves the "agent is working" signal. The ack adds no information
      // and broke the conversation invariant. Removed 2026-05-04.
      //
      // INVARIANT (Part XIX, sharpened): never insert any persisted message
      // between an assistant tool_use and its matching tool_result. If we
      // ever want a transient "thinking" indicator, it must be broadcast-only,
      // never written to the messages table.
      //
      // The `ackInjector` classifier (agent/v2/classifiers/ack.ts) and its
      // tests are kept for potential future use as a broadcast-only path.

      // ── Tracker enforcer (engine-side insertion, Q22) ──
      // Phase 2 baseline: classifier runs but engine-side task creation is
      // deferred to Phase 4 (where it integrates cleanly with the assembler's
      // session-start scaffolding). For now we just log the decision.
      const trackerDecision = trackerEnforcer({
        plannedTools: result.toolCalls,
        agentHasTrackerTools: state.shouldNudgeTracker,
        trackerToolCalledThisTurn: state.trackerToolCalledThisTurn,
        agentHasInProgressTask: false, // Phase 4: query tracker
      });
      if (trackerDecision.decision === 'create') {
        logger.debug('v2: trackerEnforcer wants to create task (deferred to Phase 4)', {
          agentId,
          reason: trackerDecision.reason,
        }, agentId);
      }

      // ── Phase: execute tools (partitioned) ──
      state = advance(state, { phase: 'execute' });
      const batches = partitionTools(result.toolCalls);
      const turnToolResults: Array<{
        toolCallId: string;
        name: string;
        content: string;
        isError: boolean;
        contentBlocks?: Array<{ type: string; [key: string]: unknown }>;
      }> = [];

      let stoppedMidBatch = false;
      let calledCompleteTask = false;
      let calledFireAndForgetGen = false;
      let recentSigs = state.recentToolSignatures;

      outer: for (const batch of batches) {
        if (stoppedMidBatch) break;

        // Per-call processing (used in both parallel and serial paths).
        const runOne = async (tc: ToolCall) => {
          // ── Technique-acknowledgement gate (v2.7.6) ──
          // If the agent recently called technique_read / use_technique
          // and hasn't acknowledged yet, only allow the small allowlist
          // of tools that can clear or extend the gate. Everything else
          // gets a structured refusal. Mirrors the close-out gate
          // pattern below — engine-enforced, not prompt-enforced.
          const TECHNIQUE_GATE_ALLOWED = new Set([
            'technique_read',
            'use_technique',
            'technique_acknowledge',
            'list_techniques',
            // recall/memory tools stay allowed so the agent can
            // bootstrap context if it forgot the technique mid-flow.
            'recall_recent_thread',
            'memory_grep',
            'memory_describe',
          ]);
          if (state.pendingTechniqueAck && !TECHNIQUE_GATE_ALLOWED.has(tc.name)) {
            const p = state.pendingTechniqueAck;
            const refusalText =
              `🛑 BLOCKED by engine: technique-acknowledgement gate.\n\n` +
              `You called technique_read / use_technique for "${p.techniqueName}" (turn ${p.fromTurnNumber}, ${p.loadedAtIso}) but haven't acknowledged reading it yet. ` +
              `Engine policy: every fresh technique load requires a technique_acknowledge call before ANY other tool can run — otherwise agents keep skipping past the technique and acting on cached memory.\n\n` +
              `Call this next, then your "${tc.name}" call will work on the following iteration:\n` +
              `  technique_acknowledge(name="${p.techniqueId}", summary="<your-paraphrase-of-the-key-steps, at-least-100-chars>")\n\n` +
              `Tools allowed while the gate is on: ${[...TECHNIQUE_GATE_ALLOWED].join(', ')}.`;
            try {
              broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
              broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: refusalText.slice(0, 500) });
            } catch { /* best effort */ }
            return {
              toolCallId: tc.id,
              name: tc.name,
              content: refusalText,
              isError: true,
            };
          }

          // Loop-break check
          const loopCheck = loopDetector(tc, recentSigs);
          recentSigs = bumpLoopSignature(recentSigs, loopCheck.signature, RECENT_TOOL_WINDOW);
          if (loopCheck.decision === 'block') {
            try {
              broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
              broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: loopCheck.refusalMessage!.slice(0, 500) });
            } catch { /* best effort */ }
            return {
              toolCallId: tc.id,
              name: tc.name,
              content: loopCheck.refusalMessage!,
              isError: true,
            };
          }

          // ── Thrash-gate refusal (per-canonical-signature) ──
          // The iteration-top thrash detector added this signature to the
          // gate when it caught the agent repeating the same call. The
          // gate refuses ONLY this exact (tool, normalized_args) combo —
          // the agent can keep calling the same tool with DIFFERENT args.
          // The refusal message names the exact call so DeepSeek can't
          // miss it (unlike a buried system message). Refusal count tracks
          // how many times the agent ignored the gate.
          if (state.thrashGatedSignatures.length > 0) {
            const thisSig = canonicalToolSignature(tc.name, tc.arguments);
            if (state.thrashGatedSignatures.includes(thisSig)) {
              const argsPart = thisSig.includes(':') ? thisSig.slice(thisSig.indexOf(':') + 1) : '{}';
              const refusal =
                `BLOCKED by engine thrash gate — \`${tc.name}(${argsPart})\` is refused. ` +
                `You've already called this exact signature multiple times and have the result from the first call.\n\n` +
                `Pick a different next action:\n` +
                `  (a) Call \`${tc.name}\` with DIFFERENT args (a different id / target) if you have more to read.\n` +
                `  (b) Call tracker_update_status(status='complete', result='...', evidence=[...]) using the data you've already gathered.\n` +
                `  (c) Call tracker_update_status(status='blocked', notes='<specific obstacle>') if you genuinely cannot proceed.\n` +
                `  (d) Send the user a direct question if you need clarification.`;
              state = advance(state, { thrashGateRefusalCount: state.thrashGateRefusalCount + 1 });
              logger.warn('v2: thrash gate refused tool call', {
                toolName: tc.name, signature: thisSig,
                refusalCount: state.thrashGateRefusalCount,
              }, agentId);
              try {
                broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
                broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: refusal.slice(0, 500) });
              } catch { /* best effort */ }
              return {
                toolCallId: tc.id,
                name: tc.name,
                content: refusal,
                isError: true,
              };
            }
          }
          // ── Anti-hoarding gate (v2.5.43) ──
          // Refuse loading-tool calls past LOADING_GATE_THRESHOLD when no
          // structuring (tracker_create_*, file_write/append/patch,
          // scratchpad_set, tracker_update_status, etc.) has happened
          // this turn. Engine enforcement of the corpus-synthesis pattern
          // — prompt-level guidance was being ignored on prod by
          // DeepSeek V4 Pro. See classifiers/hoarding.ts for full
          // rationale. The structuring call itself is NEVER refused
          // (we check loading-only), and once any structuring happens
          // the gate is permanently off for the rest of the turn.
          //
          // v2.7.8 — carve-out: trainer reading from its own techniques
          // directory doesn't count. The trainer's job IS reading the
          // technique files it manages; the gate fired on a trainer
          // doing exactly that (reading the 4 scripts + TECHNIQUE.md
          // of its own technique) and forced it to open a confused
          // "Edit Technique" tracker for what was a one-shot ask.
          if (
            !state.structuringToolCalledThisTurn &&
            isLoadingTool(tc.name) &&
            !isTrainerOwnTechniquesRead(agentId, tc.name, tc.arguments) &&
            state.loadingToolCallsThisTurn >= LOADING_GATE_THRESHOLD
          ) {
            const refusalText = buildHoardingRefusal(tc.name, state.loadingToolCallsThisTurn);
            // Broadcast refused call so it shows in the UI as a tool result
            try {
              broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
              broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: refusalText.slice(0, 500) });
            } catch { /* best effort */ }
            // Loud one-shot system message on first fire of the turn
            if (!state.nudgedForHoardingThisTurn) {
              const sysMsg = (
                `[System: anti-hoarding gate engaged. The ${tc.name} call you just made was refused because you've ` +
                `loaded ${state.loadingToolCallsThisTurn} sources this turn without scaffolding. Read the refusal ` +
                `text in your next tool result for the qualifying actions. The engine will continue refusing ` +
                `loading calls until you call one of: tracker_create_project, tracker_create_task, file_write, ` +
                `file_append, file_patch, or scratchpad_set.]`
              );
              const sysMsgId = uuidv4();
              try {
                db.prepare(`
                  INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
                  VALUES (?, ?, 'system', ?, ?, datetime('now'))
                `).run(sysMsgId, agentId, sysMsg, turnNumber);
                broadcast({
                  type: 'chat:message',
                  agentId,
                  message: {
                    id: sysMsgId, agentId, role: 'system' as const,
                    content: sysMsg,
                    tokenCount: null, modelId: null, cost: null, latencyMs: null,
                    createdAt: new Date().toISOString(),
                  },
                });
              } catch (sysErr) {
                logger.warn('v2: hoarding-gate sys-message insert failed', {
                  agentId, err: sysErr instanceof Error ? sysErr.message : String(sysErr),
                }, agentId);
              }
              state = advance(state, { nudgedForHoardingThisTurn: true });
              logger.info('v2: hoarding gate fired', {
                agentId, tool: tc.name, loadingCount: state.loadingToolCallsThisTurn,
              }, agentId);
            }
            return {
              toolCallId: tc.id,
              name: tc.name,
              content: refusalText,
              isError: true,
            };
          }
          // ── Pre-turn close-out gate (v2.5.46) ──
          // Refuse non-tracker tool calls when the agent has dangling
          // in_progress tasks from a previous turn. The agent MUST
          // engage with the tracker (status update, complete_step, or
          // add_notes for "still working") before doing other work.
          // Once any qualifying tracker call lands, the gate disengages
          // for the rest of the turn (re-arms next turn if there are
          // still danglers).
          const CLOSE_OUT_TRACKER_TOOLS = new Set([
            'tracker_update_status',
            'tracker_complete_step',
            'tracker_add_notes',
            'tracker_close_project',      // bulk-resolve a whole stranded project
            'tracker_get_status',         // read-only allowed (investigate before resolving)
            'tracker_list_active',        // ditto
            'tracker_edit_task',           // editing the task counts as engagement
            'tracker_pause_schedule',
            'tracker_resume_schedule',
            'tracker_resolve_missed_runs',
            'load_tool_docs',              // schema lookup must work — agents may need to fetch
                                           // schemas for the close-out tools above before calling them
          ]);
          if (
            state.danglingTaskIds.length > 0 &&
            !state.closeOutGateSatisfied &&
            !CLOSE_OUT_TRACKER_TOOLS.has(tc.name)
          ) {
            const taskListShort = state.danglingTaskIds.slice(0, 5).map((id) => id.slice(0, 8)).join(', ');
            const refusalText = (
              `Refused: engine close-out gate. You have ${state.danglingTaskIds.length} in_progress ` +
              `task(s) from a previous turn that you never closed (ids: ${taskListShort}${state.danglingTaskIds.length > 5 ? '...' : ''}). ` +
              `Before any other tool call, resolve at least one with tracker_complete_step, ` +
              `tracker_update_status (complete | blocked | paused), or — if you're genuinely still working ` +
              `on it across turns — tracker_add_notes to signal "in flight." After ANY one of those, the gate ` +
              `disengages for the rest of this turn and "${tc.name}" will work normally.`
            );
            try {
              broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
              broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: refusalText.slice(0, 500) });
            } catch { /* best effort */ }
            logger.info('v2: close-out gate refused call', {
              agentId, tool: tc.name, danglingCount: state.danglingTaskIds.length,
            }, agentId);
            return {
              toolCallId: tc.id,
              name: tc.name,
              content: refusalText,
              isError: true,
            };
          }
          // Broadcast tool call
          try {
            broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
          } catch { /* best effort */ }
          // Track sentToAgentThisTurn for downstream classifiers
          if (tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group') {
            state = advance(state, { sentToAgentThisTurn: true });
          }
          // ── Close-out gate satisfaction (v2.5.46) ──
          // If the agent is taking a qualifying tracker action this
          // turn (status update, complete_step, add_notes, close_project),
          // disengage the close-out gate for the remainder of the turn.
          // They can keep resolving the other dangling tasks but they're
          // no longer forced to.
          if (
            state.danglingTaskIds.length > 0 &&
            !state.closeOutGateSatisfied &&
            (tc.name === 'tracker_update_status' || tc.name === 'tracker_complete_step' || tc.name === 'tracker_add_notes' || tc.name === 'tracker_close_project')
          ) {
            state = advance(state, { closeOutGateSatisfied: true });
            logger.info('v2: close-out gate satisfied', { agentId, tool: tc.name }, agentId);
          }
          // Thrash-gate clear on any tracker transition. Any successful
          // tracker_update_status (complete/blocked/paused/in_progress) is
          // forward progress — the gate's purpose was to force the agent
          // to wrap up, so wrapping up clears it.
          if (
            (tc.name === 'tracker_update_status' || tc.name === 'tracker_complete_step' || tc.name === 'tracker_close_project') &&
            (state.thrashGatedSignatures.length > 0 || state.thrashGateRefusalCount > 0 || state.thrashGateActivatedAtLoopCount !== null)
          ) {
            state = advance(state, {
              thrashGatedSignatures: [],
              thrashGateRefusalCount: 0,
              thrashGateActivatedAtLoopCount: null,
            });
            logger.info('v2: thrash gate cleared on tracker transition', { agentId, tool: tc.name }, agentId);
          }
          // ── Post-compaction recall (v2.7.10 — auto-injection REMOVED) ──
          //
          // The v2.7.2 hard-intercept that auto-ran recall_recent_thread
          // and pasted ~15K chars of prior thread content as a system
          // message on the next significant tool call has been removed.
          // It was the root cause of context spirals on scheduled
          // multi-task projects (real production failure: 17-email
          // campaign agent kept double-sending and falsely-completing
          // because each compaction triggered a re-injection that bloated
          // the fresh tail, which triggered another compaction, which
          // re-injected even more recent history).
          //
          // recall_recent_thread remains available as a TOOL the agent
          // calls on demand if it actually needs to look up earlier
          // content. The "── Memory Compacted ──" divider still appears
          // so the agent knows compaction happened. No system message
          // gets injected into the message log on its behalf.
          //
          // The awaitingPostCompactRecall flag stays in state for now
          // (dead-ended here) so the flag-arming logic doesn't fail; a
          // later cleanup pass can delete it once we're sure nothing
          // else reads it.
          if (state.awaitingPostCompactRecall) {
            state = advance(state, { awaitingPostCompactRecall: false, nudgedForPostCompactRecall: true });
          }
          // ── Anti-hoarding accounting (v2.5.43) ──
          // Flip structuring flag the moment the call is dispatched (not
          // after — we want sibling parallel loading calls in the SAME
          // batch to also satisfy the gate if they're paired with a
          // structuring sibling). Increment loading count on dispatch
          // so the next batch's gate check sees the right number even
          // if the executor below still has work to do.
          if (isStructuringTool(tc.name)) {
            state = advance(state, { structuringToolCalledThisTurn: true });
          } else if (isLoadingTool(tc.name) && !isTrainerOwnTechniquesRead(agentId, tc.name, tc.arguments)) {
            state = advance(state, { loadingToolCallsThisTurn: state.loadingToolCallsThisTurn + 1 });
          }
          // Execute (with safety wrapper)
          let toolResult;
          try {
            toolResult = await executeTool(agentId, tc);
            // Transfer content blocks from the tool call (set by file_read for images/PDFs)
            const contentBlocks = (tc as unknown as Record<string, unknown>).__contentBlocks as
              | Array<{ type: string; [key: string]: unknown }>
              | undefined;
            if (contentBlocks) {
              (toolResult as { contentBlocks?: unknown }).contentBlocks = contentBlocks;
            }
            // v2.5.9 — Just-in-time visibility hint. When a tool result
            // contains a URL or a shared-uploads file path, append a small
            // informational note reminding the agent that tool results are
            // only visible to itself, not to the user. Informational only —
            // does NOT pressure the agent to share anything, just makes
            // sure it knows the user can't "see above". Skips sub-agents
            // (their results go to their parent agent, not the user).
            if (isPrimaryAgent(agentId)) {
              toolResult = appendVisibilityHintIfRelevant(toolResult);
            }
            // v2.7.22 — soft nudge toward [no-reply] after bookkeeping
            // tools. Applies to all agents (sub-agents close out via
            // complete_task; primary agents via tracker_update_status
            // / vault_remember / etc.). See BOOKKEEPING_NUDGE comment.
            toolResult = appendBookkeepingNudgeIfRelevant(toolResult);
          } catch (toolErr) {
            const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            logger.error('v2: tool crashed', { tool: tc.name, error: errMsg }, agentId);
            toolResult = {
              toolCallId: tc.id,
              name: tc.name,
              content: `Error: Tool "${tc.name}" crashed: ${errMsg}. Try a different approach or skip this step.`,
              isError: true,
            };
          }
          state = advance(state, { toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn + 1 });

          // v2.7.23 — track explicit channel-send tool calls so the
          // end-of-turn reply-destination resolver can skip auto-routing
          // for channels the agent already handled directly.
          if (!toolResult.isError) {
            if (tc.name === 'imessage_send') {
              state = advance(state, {
                explicitSendThisTurn: { ...state.explicitSendThisTurn, imessage: true },
              });
            } else if (tc.name === 'teams_send_message') {
              state = advance(state, {
                explicitSendThisTurn: { ...state.explicitSendThisTurn, teams: true },
              });
            } else if (tc.name === 'outlook_reply' || tc.name === 'gmail_reply') {
              state = advance(state, {
                explicitSendThisTurn: { ...state.explicitSendThisTurn, email: true },
              });
            } else if (tc.name === 'sms_send') {
              state = advance(state, {
                explicitSendThisTurn: { ...state.explicitSendThisTurn, sms: true },
              });
            }
          }

          // ── Technique-acknowledgement gate state sync (v2.7.6) ──
          // Engage the gate after a successful technique_read / use_technique
          // — UNLESS the agent already has a pending or acknowledged ack
          // for this same technique. The "first read of a new technique"
          // is what needs forced engagement; subsequent reads of the same
          // technique (navigating sections, re-reading after compaction,
          // etc.) are part of working WITH the technique, not loading it
          // fresh, and shouldn't force a re-ack.
          //
          // Match by techniqueId (the slug/id arg the agent passed). Display
          // names can drift; the slug is canonical.
          if (!toolResult.isError) {
            if (tc.name === 'technique_read' || tc.name === 'use_technique') {
              const reqName = typeof tc.arguments?.name === 'string' ? tc.arguments.name : null;
              if (reqName) {
                const alreadyEngaged =
                  state.pendingTechniqueAck !== null &&
                  state.pendingTechniqueAck.techniqueId === reqName;
                if (alreadyEngaged) {
                  // Same technique, gate already on — leave it alone.
                  // Agent is still working through the load; one ack
                  // covers all subsequent reads of this technique.
                } else {
                  // Check whether the agent has ALREADY acknowledged this
                  // same technique recently (no pending ack, but this is
                  // the same technique they engaged with earlier in the
                  // session). We persist the last-acknowledged technique
                  // alongside the pending one so re-reads while working
                  // don't trigger re-engagement.
                  let lastAckedId: string | null = null;
                  try {
                    const r = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
                    const cfg = r?.config ? JSON.parse(r.config) as Record<string, unknown> : {};
                    const last = cfg.lastAcknowledgedTechniqueId;
                    if (typeof last === 'string') lastAckedId = last;
                  } catch { /* config unreadable — treat as no prior ack */ }
                  if (lastAckedId === reqName && state.pendingTechniqueAck === null) {
                    // Same technique the agent already acked. Don't
                    // re-engage the gate — they're navigating around
                    // their working technique.
                    logger.debug('v2: technique re-read after prior ack — gate NOT re-engaged', {
                      agentId, tool: tc.name, techniqueId: reqName,
                    }, agentId);
                  } else {
                    // First read of this technique in this work-stream.
                    // Engage the gate.
                    let displayName = reqName;
                    const m = toolResult.content.match(/^══ TECHNIQUE FRESH READ ══ (.+?) \(/);
                    if (m) displayName = m[1];
                    const pending = {
                      techniqueId: reqName,
                      techniqueName: displayName,
                      loadedAtIso: new Date().toISOString(),
                      fromTurnNumber: turnNumber,
                    };
                    state = advance(state, { pendingTechniqueAck: pending });
                    try {
                      const r = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
                      const cfg = r?.config ? JSON.parse(r.config) as Record<string, unknown> : {};
                      cfg.pendingTechniqueAck = pending;
                      db.prepare("UPDATE agents SET config = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(cfg), agentId);
                    } catch (cfgErr) {
                      logger.warn('v2: failed to persist pendingTechniqueAck — gate will still apply in-memory but won\'t survive turn boundary', {
                        agentId, err: cfgErr instanceof Error ? cfgErr.message : String(cfgErr),
                      }, agentId);
                    }
                    logger.info('v2: technique-ack gate engaged', {
                      agentId, tool: tc.name, techniqueId: reqName,
                    }, agentId);
                  }
                }
              }
            } else if (tc.name === 'technique_acknowledge') {
              // Executor already cleared the persisted pending ack.
              // Record this technique as the "last acknowledged" so
              // future re-reads of the same technique don't re-engage
              // the gate (option-a behavior). Sync in-memory state.
              const ackedName = typeof tc.arguments?.name === 'string' ? tc.arguments.name : null;
              if (ackedName) {
                try {
                  const r = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
                  const cfg = r?.config ? JSON.parse(r.config) as Record<string, unknown> : {};
                  // Use the techniqueId from the pendingAck if the ack
                  // name resolved to a display name — keeps the
                  // re-read match working regardless of which form the
                  // agent passes.
                  const canonicalId = state.pendingTechniqueAck?.techniqueId ?? ackedName;
                  cfg.lastAcknowledgedTechniqueId = canonicalId;
                  db.prepare("UPDATE agents SET config = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(cfg), agentId);
                } catch { /* best effort */ }
              }
              if (state.pendingTechniqueAck) {
                state = advance(state, { pendingTechniqueAck: null });
                logger.info('v2: technique-ack gate cleared', { agentId, techniqueId: ackedName }, agentId);
              }
            }
          }

          // Permission denial suggestion appendix
          if (toolResult.isError && toolResult.content.includes('[BLOCKED]')) {
            try {
              const { getAgentPermissions } = await import('../permissions.js');
              const { getFilteredTools } = await import('../tools.js');
              const manifest = getAgentPermissions(agentId);
              const tools = getFilteredTools(agentId);
              const suggestions = permissionAlternativeFinder({
                toolName: tc.name,
                toolArgs: (tc.arguments ?? {}) as Record<string, unknown>,
                denyReason: toolResult.content,
                manifest,
                hasSendToAgent: tools.some((t) => t.name === 'send_to_agent'),
                hasCompleteTask: tools.some((t) => t.name === 'complete_task'),
              });
              if (suggestions.suggestions.length > 0) {
                toolResult = {
                  ...toolResult,
                  content: `${toolResult.content}\n\nAlternatives:\n${suggestions.suggestions.map((s) => `  • ${s}`).join('\n')}`,
                };
              }
            } catch { /* best effort */ }
          }
          // Broadcast result
          try {
            broadcast({
              type: 'chat:tool_result',
              agentId,
              tool: tc.name,
              result: toolResult.content.slice(0, 500),
            });
          } catch { /* best effort */ }
          if (tc.name === 'complete_task') calledCompleteTask = true;
          // Only a SUCCESSFUL generator call is terminal (the job started and
          // the asset arrives later via async delivery). An error result —
          // e.g. the param validator kicking the call back for a missing or
          // out-of-range value — must NOT exit the loop, or the agent never
          // gets the turn it needs to re-call with corrected values.
          if (FIRE_AND_FORGET_GEN_TOOLS.has(tc.name) && !toolResult.isError) calledFireAndForgetGen = true;
          return toolResult;
        };

        if (batch.category === 'safe') {
          // Parallel execution for safe reads
          const results = await Promise.all(batch.calls.map(runOne));
          turnToolResults.push(...results);
        } else {
          // Serial execution for everything else
          for (const tc of batch.calls) {
            // Stop check between each serial call
            if (stoppedAgents.has(agentId)) {
              stoppedAgents.delete(agentId);
              // Fill synthetic Cancelled for remaining calls (Part XIX preservation)
              const remaining = batch.calls.slice(batch.calls.indexOf(tc));
              for (const rem of remaining) {
                turnToolResults.push({
                  toolCallId: rem.id,
                  name: rem.name,
                  content: 'Cancelled by user (agent stopped).',
                  isError: true,
                });
              }
              stoppedMidBatch = true;
              break outer;
            }
            const r = await runOne(tc);
            turnToolResults.push(r);
          }
        }
      }

      // Update state with new signatures + results
      state = advance(state, {
        recentToolSignatures: recentSigs,
        toolResults: state.toolResults.concat(turnToolResults),
      });

      // ── Persist tool results ──
      // XML-fallback path (matches v1 runtime.ts:1542-1570): collapse tool
      // calls + results into a single plain-text assistant message and
      // broadcast that. The DB INSERT is IGNORE'd because messageId is the
      // same as the assistant message we already persisted (text-only above);
      // the broadcast carries the user-facing collapsed view. Net effect:
      // model context has plain text only, dashboard shows tool calls + results.
      if (hasXmlFallbackTools) {
        const collapsedParts: string[] = [];
        if (persistedContent) collapsedParts.push(persistedContent);
        for (let i = 0; i < result.toolCalls.length; i++) {
          const tc = result.toolCalls[i];
          const tr = turnToolResults[i];
          const argJson = JSON.stringify(tc.arguments);
          collapsedParts.push(`[Called ${tc.name}: ${argJson}]`);
          if (tr) {
            collapsedParts.push(`[Result${tr.isError ? ' ERROR' : ''}: ${tr.content}]`);
          }
        }
        const collapsedText = collapsedParts.join('\n');
        // Same messageId as the assistant first-persist — INSERT OR IGNORE
        // keeps the original text-only row intact.
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, token_count, model_id, cost, latency_ms, turn_number, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, NULL, NULL, ?, datetime('now'))
        `).run(
          messageId,
          agentId,
          collapsedText,
          result.outputTokens,
          effectiveModelIdForPersist,
          turnNumber,
        );
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: messageId,
            agentId,
            role: 'assistant' as Message['role'],
            content: collapsedText,
            tokenCount: null,
            modelId: effectiveModelIdForPersist,
            cost: null,
            latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        logger.info('v2: collapsed XML-fallback tool calls into plain text', {
          toolCount: result.toolCalls.length,
          tools: result.toolCalls.map((tc) => tc.name),
        }, agentId);
      } else {
        // Normal path: persist as a separate `tool` role message with
        // structured tool_result blocks. If a tool result has contentBlocks
        // (e.g. file_read on an image), use those instead of plain string —
        // the model sees the image via vision capabilities.
        const toolMessageId = uuidv4();
        const toolResultContent = turnToolResults.map((tr) => {
          const blocks = (tr as { contentBlocks?: Array<{ type: string; [key: string]: unknown }> }).contentBlocks;
          return {
            type: 'tool_result' as const,
            tool_use_id: tr.toolCallId,
            content: blocks
              ? (blocks as unknown as Anthropic.ToolResultBlockParam['content'])
              : tr.content,
            is_error: tr.isError,
          };
        }) as Anthropic.ToolResultBlockParam[];
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
          VALUES (?, ?, 'tool', ?, ?, datetime('now'))
        `).run(toolMessageId, agentId, JSON.stringify(toolResultContent), turnNumber);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: toolMessageId, agentId, role: 'tool' as Message['role'],
            content: JSON.stringify(toolResultContent),
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
      }

      clearErrors(agentId);

      if (stoppedMidBatch) {
        setAgentStatus(agentId, 'idle');
        break;
      }

      // ── Runtime tracker nudge (v2.5.40) ──
      // Detect "agent is doing real multi-step work but never opened a
      // tracker entry" mid-turn and inject a one-shot system reminder.
      // Multi-step work without a tracker task drifts and stalls — the PM
      // agent can't intervene because there's nothing to monitor — and on
      // the user's most recent test, an agent ran for tens of minutes,
      // hit compaction, and started re-reading sources it had already
      // lost from context. The reflex in the tool index header tells
      // agents to do this; this nudge is the runtime safety net for
      // agents that ignored it.
      const trackerInThisIter = result.toolCalls.filter(
        (tc) => tc.name.startsWith('tracker_'),
      ).length;
      const nonTrackerInThisIter = result.toolCalls.length - trackerInThisIter;
      // tracker_update_status / tracker_complete_step are the status-mutation
      // tools — they're the signal "agent advanced or closed a task this
      // turn", distinct from broad tracker engagement (which includes
      // tracker_create_project / tracker_list_active / tracker_get_status).
      const trackerStatusInThisIter = result.toolCalls.some(
        (tc) => tc.name === 'tracker_update_status' || tc.name === 'tracker_complete_step' || tc.name === 'tracker_close_project',
      );
      if (nonTrackerInThisIter > 0 || trackerInThisIter > 0) {
        state = advance(state, {
          nonTrackerToolCalls: state.nonTrackerToolCalls + nonTrackerInThisIter,
          trackerToolCalledThisTurn: state.trackerToolCalledThisTurn || trackerInThisIter > 0,
          trackerStatusUpdatedThisTurn: state.trackerStatusUpdatedThisTurn || trackerStatusInThisIter,
        });
      }
      const TRACKER_NUDGE_THRESHOLD = 8;
      if (
        !state.nudgedForTrackerThisTurn &&
        !state.trackerToolCalledThisTurn &&
        state.nonTrackerToolCalls > TRACKER_NUDGE_THRESHOLD
      ) {
        // Secondary check: agent may have an active task from a previous
        // turn that they're just continuing. Don't nudge them either.
        // Widened to include on_deck (queued) — the user said the v2.5.40
        // test fired a nudge right after Kevin cleanly completed a 3-task
        // project, because by the moment the check ran every task was
        // already `complete`. The fix is the trackerToolCalledThisTurn
        // gate above, but keep this as belt+suspenders for cross-turn
        // continuations and widen status so a queued task counts.
        let hasActiveTask = false;
        try {
          const { listTasks } = await import('../../tracker/schema.js');
          const candidates = listTasks({ assignedTo: agentId });
          hasActiveTask = candidates.some(
            (t) => t.status === 'in_progress' || t.status === 'on_deck',
          );
        } catch (err) {
          logger.warn('Tracker nudge: listTasks failed (treating as no active task)', {
            agentId, err: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
        if (!hasActiveTask) {
          const nudgeText = (
            `[System: you've made ${state.nonTrackerToolCalls} non-tracker tool calls this turn without an active tracker task assigned to you. ` +
            `This is the failure shape we want to catch — multi-step work without a tracker entry drifts and stalls (the PM agent can't intervene because there's nothing to monitor) and your context is filling up which means compaction is coming and you'll lose source detail you've already read. ` +
            `STOP what you're doing right now and call tracker_create_project(title="<short name>", level=2, tasks=[…one task per discrete batch…]) describing the steps for what you've been doing and what's left. ` +
            `Then update each task as you complete it via tracker_update_status, and use scratchpad_set to keep a running outline that survives compaction. ` +
            `Resume the work after the project is opened.]`
          );
          const nudgeId = uuidv4();
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'system', ?, ?, datetime('now'))
          `).run(nudgeId, agentId, nudgeText, turnNumber);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: nudgeId, agentId, role: 'system' as const,
              content: nudgeText,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
          state = advance(state, { nudgedForTrackerThisTurn: true });
          logger.info('v2: tracker nudge fired', {
            agentId, nonTrackerToolCalls: state.nonTrackerToolCalls,
          }, agentId);
        }
      }

      // ── complete_task / fire-and-forget generator exit conditions (Part XIX) ──
      if (calledCompleteTask) {
        logger.info('v2: complete_task called, exiting loop', { agentId }, agentId);
        break;
      }
      if (calledFireAndForgetGen) {
        logger.info('v2: fire-and-forget generator called, exiting loop (async delivery)', { agentId }, agentId);
        break;
      }

      // ── Phase: post-execution gates ──
      state = advance(state, { phase: 'postExecution' });

      // ── Repetition detection (matches v1 runtime.ts:1622-1634) ──
      // If the model produces the SAME text + SAME tool calls as the last
      // iteration, it's stuck. Nudge once. If still repeating, break with
      // STUCK_REPEATING. The loopDetector catches duplicate-tool-call
      // patterns; this catches duplicate-FULL-response patterns including
      // text-only responses.
      const currentResponseSig =
        (result.content ?? '') +
        '|' +
        result.toolCalls
          .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
          .sort()
          .join(',');
      if (state.lastResponseSig === currentResponseSig) {
        if (!state.nudgedForRepetition) {
          logger.warn('v2: agent repeating itself — nudging on next iteration', {
            loopCount: state.loopCount,
          }, agentId);
          state = advance(state, {
            nudgedForRepetition: true,
            pendingNudge:
              '[System: You are repeating yourself — your last two responses were identical. ' +
              'Try a different approach. If the task is complete, call complete_task or ' +
              'tracker_update_status. If you need help, explain what you are stuck on.]',
          });
          continue;
        }
        logger.warn('v2: breaking tool loop — agent still repeating after nudge', {
          loopCount: state.loopCount,
        }, agentId);
        broadcast({
          type: 'chat:error',
          agentId,
          error: 'Agent got stuck repeating itself. Send a follow-up to redirect it.',
          code: 'STUCK_REPEATING',
          severity: 'warning',
          retryable: true,
        });
        break;
      }
      state = advance(state, { lastResponseSig: currentResponseSig });

      // Permission denial counter
      const allBlocked = turnToolResults.every((tr) => tr.isError && tr.content.includes('[BLOCKED]'));
      if (allBlocked && turnToolResults.length > 0) {
        state = advance(state, {
          consecutivePermissionDenials: state.consecutivePermissionDenials + turnToolResults.length,
        });
      } else if (turnToolResults.length > 0) {
        state = advance(state, { consecutivePermissionDenials: 0 });
      }

      // ── No-results detection (matches v1 runtime.ts:1658-1678) ──
      // When search tools (vault_search, memory_grep, web_search, etc.)
      // repeatedly return "No results found" / "not in memory", the agent
      // is probably looking for something that doesn't exist. Nudge once,
      // then break with a NO_RESULTS error if it persists.
      const allNoResults =
        turnToolResults.length > 0 &&
        turnToolResults.every(
          (tr) =>
            tr.content.includes('No results found') ||
            tr.content.includes('not in memory'),
        );
      if (allNoResults && turnToolResults.every((tr) => !tr.isError)) {
        const nextNoResultsCount = state.consecutiveNoResultTools + 1;
        if (nextNoResultsCount >= 2) {
          if (!state.nudgedForNoResults) {
            logger.warn('v2: consecutive empty search results — nudging on next iteration', {
              loopCount: state.loopCount,
              consecutiveNoResultTools: nextNoResultsCount,
            }, agentId);
            state = advance(state, {
              nudgedForNoResults: true,
              pendingNudge:
                '[System: Multiple searches returned no results. The information may not exist in memory. ' +
                'Try responding based on what you already know, or ask the user for clarification.]',
              consecutiveNoResultTools: 0,
            });
            continue;
          }
          // Already nudged — break with NO_RESULTS error
          logger.warn('v2: breaking tool loop — still no results after nudge', {
            loopCount: state.loopCount,
          }, agentId);
          broadcast({
            type: 'chat:error',
            agentId,
            error: 'Agent stopped — searches kept coming up empty. The info may not be in memory yet.',
            code: 'NO_RESULTS',
            severity: 'warning',
            retryable: true,
          });
          break;
        }
        state = advance(state, { consecutiveNoResultTools: nextNoResultsCount });
      } else if (turnToolResults.length > 0) {
        state = advance(state, { consecutiveNoResultTools: 0 });
      }

      // Spinning detection (Part XVIII §F — engine asks model before breaking)
      const progressDecision = progressClassifier({
        toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn,
        consecutiveSmallDeltas: 0, // Phase 4 will track this
        consecutivePermissionDenials: state.consecutivePermissionDenials,
        consecutiveNoResultTools: 0, // Phase 4 will track this
        spinningNudgeCount: state.spinningNudgeCount,
        loopCount: state.loopCount,
      });
      if (!progressDecision.progressing) {
        // If we've already nudged 3 times and the agent kept going, break.
        if (progressDecision.signals?.includes('nudge cap')) {
          logger.warn('v2: spinning nudge cap reached — breaking', { agentId }, agentId);
          break;
        }
        // Otherwise inject a nudge and continue once.
        const nudgeText = buildSpinningNudge({
          toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn,
          consecutiveSmallDeltas: 0,
          consecutivePermissionDenials: state.consecutivePermissionDenials,
          consecutiveNoResultTools: 0,
          spinningNudgeCount: state.spinningNudgeCount,
          loopCount: state.loopCount,
        });
        const nudgeId = uuidv4();
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
          VALUES (?, ?, 'system', ?, ?, datetime('now'))
        `).run(nudgeId, agentId, nudgeText, turnNumber);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: nudgeId, agentId, role: 'system' as const,
            content: nudgeText,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        state = advance(state, { spinningNudgeCount: state.spinningNudgeCount + 1 });
      }

      // Loop continues — model will see tool results and respond
    }

    if (state.loopCount >= MAX_TOOL_LOOPS) {
      // Matches v1 runtime.ts:1683-1707. Hit the soft tool-loop cap but
      // (presumably) still making progress — auto-continue with a fresh
      // turn instead of dead-stopping. The continuity brief + tracker
      // tasks let the agent pick up where they left off.
      logger.warn('v2 hit MAX_TOOL_LOOPS — auto-continuing with fresh turn', {
        agentId, maxLoops: MAX_TOOL_LOOPS,
      }, agentId);
      const sysMsg = (
        `[System: This turn reached ${MAX_TOOL_LOOPS} tool calls. Starting a fresh turn ` +
        `to continue your work. Pick up where you left off.]`
      );
      const sysMsgId = uuidv4();
      db.prepare(`
        INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
        VALUES (?, ?, 'system', ?, ?, datetime('now'))
      `).run(sysMsgId, agentId, sysMsg, turnNumber);
      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: sysMsgId, agentId, role: 'system' as const,
          content: sysMsg,
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });
      // Schedule a self-continuation. Reassembles context fresh — the agent
      // sees its full history including the work it just did and continues
      // naturally. 1s delay lets DB writes settle.
      setTimeout(() => {
        try {
          getAgentRuntime().handleMessage(agentId, '').catch((err) => {
            logger.error('v2 auto-continuation after tool limit failed', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          });
        } catch (err) {
          logger.error('v2 auto-continuation failed to schedule', {
            agentId, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
      }, 1000);
    }

    // ── Phase: finalize ──
    state = advance(state, { phase: 'finalize' });

    // ── Reply-destination resolver (v2.7.23, OpenClaw-inspired) ──
    // The model just writes text; the engine decides which channel to
    // route it through. The 2.7.22 "model must call imessage_send for
    // every reply" pattern failed in practice (the model defaults to
    // streaming text and can't reliably switch to tool mode for short
    // conversational replies) — historical investigation logged
    // separately in the iMessage-routing fix notes.
    //
    // Routing rules (see reply-destination.ts):
    //   - inbound from channel X → reply auto-routes back to X
    //   - dashboard inbound / proactive turn → dashboard
    //   - AWAY OVERRIDE: dashboard destination + presence='away' +
    //     bridge configured → rewrite to iMessage so the user (who
    //     isn't at the dashboard) gets the message on their phone
    //
    // Dedup: if the agent already called the channel's explicit send
    // tool this turn (state.explicitSendThisTurn[channel]), skip the
    // auto-route — they handled it directly.
    if (isPrimaryAgent(agentId) && state.lastAssistantTextForIM) {
      try {
        const { resolveReplyDestination } = await import('./reply-destination.js');
        const { getPresence, isImessageConfigured } = await import('../../services/presence.js');
        const {
          sendResponseViaIMessage, getInboundSenderFor,
          isAgentInitiatedContact, clearAgentInitiatedContact, clearIMResponseFlag,
        } = await import('../../services/imessage-bridge.js');

        const destination = resolveReplyDestination({
          state,
          presence: getPresence(),
          imessageBridgeConfigured: isImessageConfigured(),
        });

        // Small helper: persist + broadcast the routing marker so wordy
        // mode shows it and the dashboard renderer can surface a "sent
        // via X" pill (the existing pill regex matches `Reply routed via
        // (iMessage|Teams|email)`).
        const persistRoutingMarker = (label: string) => {
          const tagId = uuidv4();
          const tagContent = `[Reply routed via ${label}]`;
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'system', ?, ?, datetime('now'))
          `).run(tagId, agentId, tagContent, turnNumber);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: tagId, agentId, role: 'system' as const,
              content: tagContent,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
        };

        // Option B relay guard: if this inbound came from someone the agent
        // proactively reached out to (a relay — "David asked me to ask
        // Mike"), the agent's end-of-turn text is a report for the original
        // requester, NOT an auto-reply to that contact. Suppress iMessage
        // routing and leave the text in the dashboard. Consume-once: clear
        // the relay flag so a genuine later exchange auto-routes normally.
        const relaySender = getInboundSenderFor(agentId);
        const isRelayReply =
          destination === 'imessage' && !!relaySender && isAgentInitiatedContact(agentId, relaySender);

        if (isRelayReply && relaySender) {
          clearAgentInitiatedContact(agentId, relaySender);
          clearIMResponseFlag(agentId);
          logger.info('Option B: suppressed iMessage auto-route on relay reply (kept in dashboard)', {
            agentId,
            inboundSender: relaySender,
          }, agentId);
        } else if (destination === 'imessage' && !state.explicitSendThisTurn.imessage && isImessageConfigured()) {
          // Label the badge with the recipient the bridge ACTUALLY delivered
          // to, never a hardcoded default. If the send was suppressed (sender
          // no longer authorized, empty body), skip the marker entirely so we
          // don't claim a delivery that didn't happen.
          const delivered = sendResponseViaIMessage(state.lastAssistantTextForIM, agentId);
          if (delivered) {
            persistRoutingMarker(`iMessage to ${delivered.name}`);
            logger.info('v2.7.23: routed reply via iMessage', {
              agentId,
              inboundChannel: state.inboundChannel,
              recipient: delivered.name,
              presence: getPresence(),
              textLength: state.lastAssistantTextForIM.length,
            }, agentId);
          } else {
            logger.info('v2.7.23: iMessage auto-reply suppressed (no valid recipient)', {
              agentId,
              inboundChannel: state.inboundChannel,
            }, agentId);
          }
        } else if (destination === 'teams' && !state.explicitSendThisTurn.teams && state.inboundContext?.chatId) {
          // v2.7.24 — Teams reply routing. Inbound Teams DM → reply
          // auto-routes back to the same chat_id via teams_send_message.
          // We invoke executeTool with a synthetic ToolCall so the
          // existing dispatcher handles auth, retries, audit logging.
          // Group chats stay 'message_tool' per the resolver (inbound
          // context populates chatType='group' for those), so this only
          // fires for DM-style Teams chats.
          try {
            const tc: ToolCall = {
              id: uuidv4(),
              name: 'teams_send_message',
              arguments: {
                chat_id: state.inboundContext.chatId,
                message: state.lastAssistantTextForIM,
              },
            };
            const result = await executeTool(agentId, tc);
            if (result.isError) {
              logger.warn('v2.7.24: teams auto-reply failed', { agentId, error: result.content }, agentId);
            } else {
              persistRoutingMarker(`Teams to chat ${state.inboundContext.chatId.slice(0, 8)}…`);
              logger.info('v2.7.24: routed reply via Teams', {
                agentId,
                chatId: state.inboundContext.chatId,
                textLength: state.lastAssistantTextForIM.length,
              }, agentId);
            }
          } catch (err) {
            logger.warn('v2.7.24: teams auto-reply crashed', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        } else if (destination === 'email' && !state.explicitSendThisTurn.email && state.inboundContext?.emailMessageId) {
          // v2.7.24 — email reply routing. Only fires when the inbound
          // was a "Re:" from a known safe-sender (set in preflight). For
          // those, the model's terminal text is sent as an in-thread
          // reply via outlook_reply (Outlook) or gmail_reply (Gmail).
          // Random new-email notifications keep the existing "agent
          // decides whether to surface" flow — they get inboundChannel=
          // 'dashboard', not 'email'.
          const toolName = state.inboundContext.emailService === 'gmail' ? 'gmail_reply' : 'outlook_reply';
          try {
            const tc: ToolCall = {
              id: uuidv4(),
              name: toolName,
              arguments: {
                message_id: state.inboundContext.emailMessageId,
                body: state.lastAssistantTextForIM,
              },
            };
            const result = await executeTool(agentId, tc);
            if (result.isError) {
              logger.warn('v2.7.24: email auto-reply failed', { agentId, tool: toolName, error: result.content }, agentId);
            } else {
              const subjectPreview = state.inboundContext.emailSubject?.slice(0, 40) ?? '(no subject)';
              persistRoutingMarker(`email reply (thread: "${subjectPreview}")`);
              logger.info('v2.7.24: routed reply via email', {
                agentId,
                emailService: state.inboundContext.emailService,
                subject: state.inboundContext.emailSubject,
                textLength: state.lastAssistantTextForIM.length,
              }, agentId);
            }
          } catch (err) {
            logger.warn('v2.7.24: email auto-reply crashed', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        } else if (destination === 'phone' && !state.explicitSendThisTurn.phone && state.inboundContext?.phoneCallSid) {
          // v2.9.18 - phone call reply routing. The agent just emitted
          // text in response to a caller utterance during an active
          // phone call. Push the text into the call's TTS pipeline so
          // it gets spoken back over the same call.
          // v2.9.23 — if streaming TTS already flushed sentences via
          // onChunk above, we ONLY queue whatever tail remains in
          // phoneStreamBuffer. If nothing was streamed (e.g. the
          // model returned in one shot, or onChunk never fired) we
          // fall back to the original one-shot push so we never
          // silently drop the reply.
          try {
            const { getCallSession } = await import('../../twilio/call-session.js');
            const session = getCallSession(state.inboundContext.phoneCallSid);
            if (!session) {
              logger.warn('v2.9.18: phone auto-reply skipped - no active session for callSid', {
                agentId, callSid: state.inboundContext.phoneCallSid,
              }, agentId);
            } else if (session.isEnded()) {
              logger.warn('v2.9.18: phone auto-reply skipped - call already ended', {
                agentId, callSid: state.inboundContext.phoneCallSid,
              }, agentId);
            } else if (phoneStreamFlushedAny) {
              // Streaming path took care of the body. Flush the
              // remaining tail (final sentence without trailing
              // punctuation-plus-whitespace) if any.
              const tail = phoneStreamBuffer.trim();
              if (tail) {
                await session.queueAgentSay(tail);
                phoneStreamBuffer = '';
              }
              persistRoutingMarker(`phone call to ${state.inboundContext.phoneFromNumber ?? '(unknown)'}`);
              logger.info('v2.9.23: routed reply via phone TTS (streamed)', {
                agentId,
                callSid: state.inboundContext.phoneCallSid,
                to: state.inboundContext.phoneFromNumber,
                tailLength: tail.length,
                totalTextLength: state.lastAssistantTextForIM.length,
              }, agentId);
            } else {
              await session.queueAgentSay(state.lastAssistantTextForIM);
              persistRoutingMarker(`phone call to ${state.inboundContext.phoneFromNumber ?? '(unknown)'}`);
              logger.info('v2.9.18: routed reply via phone TTS', {
                agentId,
                callSid: state.inboundContext.phoneCallSid,
                to: state.inboundContext.phoneFromNumber,
                textLength: state.lastAssistantTextForIM.length,
              }, agentId);
            }
          } catch (err) {
            logger.warn('v2.9.18: phone auto-reply crashed', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        } else if (destination === 'sms' && !state.explicitSendThisTurn.sms && state.inboundContext?.smsFromNumber) {
          // v2.9.18 - SMS reply routing. Inbound SMS from a known
          // sender → agent's terminal text auto-routes back via
          // Twilio sendSms to the original sender. From-number is
          // the same Twilio number that received the inbound (so
          // the thread looks continuous on the recipient's phone).
          try {
            const { sendSms } = await import('../../twilio/client.js');
            const { getDefaultFromNumber } = await import('../../twilio/auth.js');
            const fromNumber = state.inboundContext.smsToNumber ?? getDefaultFromNumber();
            if (!fromNumber) {
              logger.warn('v2.9.18: sms auto-reply skipped - no from-number available', { agentId }, agentId);
            } else {
              const r = await sendSms(state.inboundContext.smsFromNumber, state.lastAssistantTextForIM, fromNumber);
              if (!r.ok) {
                logger.warn('v2.9.18: sms auto-reply failed', { agentId, error: r.error }, agentId);
              } else {
                persistRoutingMarker(`SMS to ${state.inboundContext.smsFromNumber}`);
                logger.info('v2.9.18: routed reply via SMS', {
                  agentId,
                  to: state.inboundContext.smsFromNumber,
                  from: fromNumber,
                  textLength: state.lastAssistantTextForIM.length,
                }, agentId);
              }
            }
          } catch (err) {
            logger.warn('v2.9.18: sms auto-reply crashed', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        }
      } catch (err) {
        logger.warn('v2.7.23: reply-destination routing failed', {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
    }
    if (imFlagSetAtRunStart) clearIMResponseFlag(agentId);

    // v2.9.20 — show_to_user end-of-turn safety net.
    //
    // If the turn ended with attachments still queued from
    // show_to_user calls (the model didn't write terminal text
    // after queuing - common failure mode that lost JJ's report on
    // 2026-06-06), surface them now as a final assistant message
    // so they reach the user instead of vanishing. Uses any caption
    // strings the model passed to show_to_user as the bubble text;
    // falls back to a generic "Here are the files for you." when
    // no caption was provided.
    try {
      const { drainPendingAttachmentsWithCaptions } = await import('../pending-attachments.js');
      const stranded = drainPendingAttachmentsWithCaptions(agentId);
      if (stranded.attachments.length > 0) {
        const captionText = stranded.captions.length > 0
          ? stranded.captions.join('\n\n')
          : 'Here are the files for you.';
        const synthId = uuidv4();
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, turn_number, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, datetime('now'))
        `).run(synthId, agentId, captionText, JSON.stringify(stranded.attachments), turnNumber);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: synthId,
            agentId,
            role: 'assistant' as Message['role'],
            content: captionText,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
            attachments: stranded.attachments,
          },
        });
        logger.warn('show_to_user safety net fired - surfaced stranded attachments', {
          agentId,
          fileCount: stranded.attachments.length,
          captionCount: stranded.captions.length,
        }, agentId);
        if (stranded.attachments.length > 0) {
          state = advance(state, { lastAssistantTextForIM: captionText });
        }
      }
    } catch (err) {
      logger.warn('show_to_user safety net failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }

    stopStatusHeartbeat(agentId);

    // Clean turn end — clear the in-loop recovery streak. The agent reached
    // a natural exit without further recovery, so any prior recovery
    // attempts are presumed resolved (matches v1 runtime.ts:1404).
    recoveryRunStreak.delete(agentId);

    // Set agent back to idle (unless terminated)
    const currentAgent = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as
      | { status: string }
      | undefined;
    if (currentAgent && currentAgent.status !== 'terminated') {
      setAgentStatus(agentId, 'idle');
    }

    // Reset the persisted recovery_attempts counter on a successful turn.
    // Pre-2026-05-06 the counter only reset inside reset_session, so 3
    // transient errors spread over weeks would silently accumulate and
    // permanently suppress the Healer for the agent until the user
    // manually intervened. Only fire onAgentRecovered when attempts > 0
    // (there was actually something to recover from) to avoid spamming
    // the "recovered" toast on every healthy turn.
    if (currentAgent && currentAgent.status !== 'terminated') {
      try {
        const attemptsRow = db
          .prepare('SELECT recovery_attempts FROM agents WHERE id = ?')
          .get(agentId) as { recovery_attempts: number | null } | undefined;
        if ((attemptsRow?.recovery_attempts ?? 0) > 0) {
          const { onAgentRecovered } = await import('../../healer/injury-recovery.js');
          onAgentRecovered(agentId);
        }
      } catch { /* best effort */ }
    }

    // Post-turn checks (preserved)
    try {
      checkTimeouts();
    } catch (err) {
      logger.error('v2: post-turn timeout check failed', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }

    // Compaction is rare in v2 (Part V). For Phase 2 we skip the post-turn
    // call entirely — the pre-call compactionGate (added in Phase 4) will
    // handle it. v1's post-turn compaction call was the failure mode this
    // whole architecture is fixing.
  } catch (err) {
    // Best-effort cleanup before recovery so heartbeats / abort controllers
    // don't keep firing while the recovery cascade does its DB writes.
    stopStatusHeartbeat(agentId);
    activeAbortControllers.delete(agentId);

    // Phase 6 (2026-05-04) — v2 now owns its own recovery cascade.
    // recoverFromError handles all side effects: context-overflow recovery,
    // recoverable provider 4xx (with streak cap + system note), or generic
    // injury (recordError + last_error + healer notification + chat:error).
    //
    // No re-throw — handleMessage's outer catch is now a no-op for v2 errors,
    // and any exception escaping recoverFromError is itself logged but
    // swallowed (the agent is already in a degraded state; throwing further
    // would double-handle).
    try {
      const { recoverFromError } = await import('./recovery.js');
      await recoverFromError(state, err);
    } catch (recovErr) {
      logger.error('v2 recovery cascade itself threw — swallowing to avoid double-handle', {
        agentId,
        recoveryError: recovErr instanceof Error ? recovErr.message : String(recovErr),
        originalError: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }
}
