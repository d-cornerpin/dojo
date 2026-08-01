// Registered prompt-injection entries.
//
// Each entry's `render` calls the SAME function the legacy parts producer calls,
// so the registry output is byte-identical to legacy for that slot by
// construction. Slots are migrated incrementally (R3 → R7); this file grows one
// entry at a time and the matching legacy block is deleted only at R7, after the
// registry has been byte-proven on the dev server.

import { register } from './registry.js';
import { SystemSlot, MessageSlot, type SystemInjection, type MessageInjection, type AssemblyContext, type EngineMessage } from './types.js';
import { renderCounterpartyHeader } from '../../agent/v2/counterparty.js';
import { isIMBridgeRunning } from '../../services/imessage-bridge.js';
import {
  renderTimeHeader,
  renderCurrentTimeMessage,
  generateToolsGuidance_v2,
  getSoulContent,
  renderPrecedenceLadder,
  renderVisibility,
  renderRuntimeInfo,
  renderVisionCapBanner,
  renderUserProfile,
  renderMessageSources,
  renderPmAwareness,
  renderTrainerAwareness,
  renderHealerAwareness,
  renderCompactionContinuity,
  renderGoogleAccess,
  renderMsAccess,
  renderIntegrationReconnect,
  renderEquippedTechniques,
  renderReplyDestination,
  renderChannelLandscape,
  renderPhoneConduct,
  renderVoiceConduct,
} from '../assembler.js';
import { assembleGroupContext, renderPeerStatusLine } from '../../agent/groups.js';
import { generateTechniqueIndex, generateDraftTechniqueContext } from '../../techniques/index-builder.js';
import { detectContextGap } from '../../agent/v2/classifiers/context-gap.js';

// ── System-prompt entries (R3 proof-of-concept: one static, one computed) ──
const SYSTEM_ENTRIES: SystemInjection[] = [
  {
    id: 'sys.time',
    target: 'system',
    slot: SystemSlot.Time,
    reason:
      'Temporal anchor: every agent must know the current date/time from turn 1 ' +
      'without a tool call, to judge the age and relevance of any context.',
    render: () => renderTimeHeader(),
  },
  {
    id: 'sys.tools',
    target: 'system',
    slot: SystemSlot.Tools,
    reason:
      'Tool guidance + the two-phase tool index: the model must know which tools ' +
      'exist and that it loads their docs on demand (load_tool_docs).',
    render: (ctx) => generateToolsGuidance_v2(ctx.agentId),
  },
  {
    id: 'sys.identity',
    target: 'system',
    slot: SystemSlot.Identity,
    precedenceTier: 6,
    reason:
      'The agent persona: SOUL.md (PM/Trainer/sensei soul) or, for a spawned ' +
      'sub-agent, the synthesized identity + owner standing rules. Defines who ' +
      'the agent is and its base conduct.',
    render: (ctx) => getSoulContent(ctx.agentId),
  },
  {
    id: 'sys.group',
    target: 'system',
    slot: SystemSlot.Group,
    reason:
      'Group/squad context: the roster and the "you are one participant, do not ' +
      'reply to every message" rule when the agent is in a group thread.',
    render: (ctx) => assembleGroupContext(ctx.agentId),
  },
  {
    id: 'sys.techniques-index',
    target: 'system',
    slot: SystemSlot.TechniquesIndex,
    precedenceTier: 2,
    reason:
      'The Available Techniques index (published techniques) so the agent can ' +
      'discover and use_technique() a matching procedure; ladder-anchored (the ' +
      'live user message outranks a technique).',
    render: () => generateTechniqueIndex(),
  },
  {
    id: 'sys.techniques-draft',
    target: 'system',
    slot: SystemSlot.TechniquesDraft,
    precedenceTier: 2,
    reason:
      'Draft-technique context for build-squad members: a technique under ' +
      'evaluation the squad should follow but flag friction on.',
    render: (ctx) => {
      const row = ctx.db
        .prepare('SELECT group_id FROM agents WHERE id = ?')
        .get(ctx.agentId) as { group_id: string | null } | undefined;
      if (!row?.group_id) return null;
      return generateDraftTechniqueContext(row.group_id) || null;
    },
  },
  {
    id: 'sys.precedence-ladder',
    target: 'system',
    slot: SystemSlot.PrecedenceLadder,
    reason:
      'Defines the instruction-precedence order (live user > task > convo > vault ' +
      '> USER.md > SOUL > engine hint) + the engine-prefix taxonomy, so a weak ' +
      'model resolves conflicts deterministically.',
    render: () => renderPrecedenceLadder(),
  },
  {
    id: 'sys.visibility',
    target: 'system',
    slot: SystemSlot.Visibility,
    reason:
      'The canonical user-visibility law: the user sees only their own messages ' +
      'plus the reply/attachments the agent delivers; tool results, a2a messages, ' +
      'and engine notes are invisible to them. States the FACT (engine-owned) the ' +
      'model keeps judgment over, killing the recurring "as you can see above" / ' +
      'un-relayed-peer-answer bug. Umbrella for the per-item tool-result + a2a tags.',
    render: () => renderVisibility(),
  },
  {
    id: 'sys.runtime',
    target: 'system',
    slot: SystemSlot.Runtime,
    reason: 'Runtime footer: agent id / model / host, for self-identification and debugging.',
    render: (ctx) => renderRuntimeInfo(ctx.agentId, ctx.modelId),
  },
  {
    id: 'sys.vision-cap',
    target: 'system',
    slot: SystemSlot.VisionCap,
    reason:
      'Honesty (Inv I): if the model lacks image input, tell it up front so it ' +
      'does not call image tools and hallucinate results it cannot see.',
    render: (ctx) => renderVisionCapBanner(ctx.agentId, ctx.modelId),
  },
  {
    id: 'sys.user-profile',
    target: 'system',
    slot: SystemSlot.UserProfile,
    precedenceTier: 5,
    reason: 'USER.md owner profile/preferences (tier-5 standing preferences), when sharing is enabled.',
    render: (ctx) => renderUserProfile(ctx.agentId),
  },
  {
    id: 'sys.message-sources',
    target: 'system',
    slot: SystemSlot.MessageSources,
    reason:
      'Decodes the [SOURCE: ...] tag taxonomy + the hard inter-agent reply rule; ' +
      'defers routing to the reply-destination tag and the prefix taxonomy to the ladder.',
    render: () => renderMessageSources(),
  },
  {
    id: 'sys.pm-awareness',
    target: 'system',
    slot: SystemSlot.PmAwareness,
    precedenceTier: 6,
    reason:
      'Primary only: names the PM agent + tracker-first guidance (the PM watches ' +
      'the tracker; schedule work there, do not spawn watcher agents).',
    render: (ctx) => renderPmAwareness(ctx.agentId),
  },
  {
    id: 'sys.trainer-awareness',
    target: 'system',
    slot: SystemSlot.TrainerAwareness,
    precedenceTier: 6,
    reason: 'Primary only: names the Trainer agent (owns save_technique/update_technique).',
    render: (ctx) => renderTrainerAwareness(ctx.agentId),
  },
  {
    id: 'sys.healer-awareness',
    target: 'system',
    slot: SystemSlot.HealerAwareness,
    precedenceTier: 6,
    reason: 'Primary only: names the Healer agent (auto-triages injured/stuck agents).',
    render: (ctx) => renderHealerAwareness(ctx.agentId),
  },
  {
    id: 'sys.compaction-continuity',
    target: 'system',
    slot: SystemSlot.CompactionContinuity,
    precedenceTier: 3,
    reason:
      'Persistent post-compaction signal (within 24h): tells the agent older ' +
      'history was summarized + the ordered recall sources if the live tail is unclear.',
    render: (ctx) => renderCompactionContinuity(ctx.agentId),
  },
  {
    id: 'sys.google-access',
    target: 'system',
    slot: SystemSlot.GoogleAccess,
    reason: 'Google Workspace access note (full/read) so the agent knows what it can do + that actions are logged.',
    render: (ctx) => renderGoogleAccess(ctx.agentId),
  },
  {
    id: 'sys.ms-access',
    target: 'system',
    slot: SystemSlot.MsAccess,
    reason: 'Microsoft 365 access note (full/read) + Teams-inbound reply guidance for work/school accounts.',
    render: (ctx) => renderMsAccess(ctx.agentId),
  },
  {
    id: 'sys.integration-reconnect',
    target: 'system',
    slot: SystemSlot.IntegrationReconnect,
    reason:
      'Honesty (Inv I): a configured-but-disconnected integration shows a reconnect ' +
      'breadcrumb instead of vanishing (so the agent does not claim the capability is ' +
      'unsupported). 0+ parts. FA-PT1 (C28): MOVED to the msg.turn-context tail message; ' +
      'the breadcrumb flips in/out of the prefix on live connection health, so keeping it ' +
      'in the cached system block busted the cache on every reconnect/expire. The render ' +
      'fn is called from renderTurnContext. This entry now emits nothing.',
    render: () => null,
  },
  {
    id: 'sys.techniques-equipped',
    target: 'system',
    slot: SystemSlot.TechniquesEquipped,
    precedenceTier: 2,
    reason:
      'Full TECHNIQUE.md bodies for equipped techniques, pre-loaded; ladder-anchored ' +
      '(the live user message outranks a technique).',
    render: (ctx) => renderEquippedTechniques(ctx.agentId),
  },
  {
    id: 'sys.reply-destination',
    target: 'system',
    slot: SystemSlot.ReplyDestination,
    precedenceTier: 7,
    reason:
      'Primary only: the engine-resolved per-turn route + the voice to write in. ' +
      'Sole routing authority (C5). C28 Part 1: MOVED to the msg.turn-context tail ' +
      'message so the volatile route no longer breaks the cached system prefix; the ' +
      'render fn is called from renderTurnContext. This SYSTEM entry now emits nothing.',
    render: () => null,
  },
  {
    id: 'sys.channel-landscape',
    target: 'system',
    slot: SystemSlot.ChannelLandscape,
    precedenceTier: 7,
    reason:
      'Primary, non-dashboard inbound: channel presence (C11). C28 Part 1: MOVED to ' +
      'the msg.turn-context tail message (volatile per channel). This entry emits nothing.',
    render: () => null,
  },
  {
    id: 'sys.phone-conduct',
    target: 'system',
    slot: SystemSlot.PhoneConduct,
    precedenceTier: 6,
    reason:
      'Live phone-call conduct (C7). C28 Part 1: MOVED to the msg.turn-context tail ' +
      'message (present only on phone turns → volatile). This entry emits nothing.',
    render: () => null,
  },
  {
    id: 'sys.voice-conduct',
    target: 'system',
    slot: SystemSlot.VoiceConduct,
    precedenceTier: 6,
    reason:
      'Generic voice-mode conduct on a voice (non-phone) turn; TTS-conditional ' +
      'filler advice (C6). Mutually exclusive with phone-conduct. FA-PT1 (C28): MOVED ' +
      'to the msg.turn-context tail message (present only on voice turns, so it is ' +
      'volatile); leaving it in the prefix meant every voice/text modality switch and ' +
      'every non-voice turn interleaved into a voice conversation busted the cached ' +
      'system prefix. The render fn is called from renderTurnContext. This entry now ' +
      'emits nothing.',
    render: () => null,
  },
];

// ── Message-side entries (R3 PoC: one conditional, standalone injection) ──
// Note: msg.technique-strong was the plan's named PoC, but it is conjoined with
// the weak hint (shared async matcher + a once-only recordTechniqueUsage) and
// the weak hint does a raw `systemPrompt +=`, so it can't migrate cleanly in
// isolation, it migrates as a GROUP in R5. msg.context-gap is the clean
// representative: sync, standalone, conditional, message-side.
const TOOL_NOTE_TEXT =
  `[System note: Your current model does not support tool calling. You can only respond with text. ` +
  `If the user asks you to do something that requires tools (file access, web search, tracker, etc.), ` +
  `explain that your model doesn't support it and suggest they switch to a tool-capable model in Settings.]`;

// C28 Part 1: the per-turn volatile routing/presence context, rendered as ONE
// near-tail engine message instead of scattered across the cached system prefix.
// Combines (in fixed order): counterparty header, the [Reply destination] routing
// tag (sole routing authority, C5, its FIRST salient line), channel landscape,
// phone conduct (phone turns), the live iMessage bridge state (P-5), and the
// othersWaiting / conversational-turn just-in-time hints (moved from the system
// string, memory/assembler.ts). Everything here changes turn-to-turn, so keeping
// it OUT of the system prefix is what makes the prefix cache across channel /
// presence / waiting-count changes (all-provider fix, P-1).
function renderTurnContext(ctx: AssemblyContext): EngineMessage | null {
  const tc = ctx.turnContext;
  const parts: string[] = [];

  if (tc?.counterparty) {
    parts.push(renderCounterpartyHeader(tc.counterparty, {
      isEngineTurn: tc.isEngineTurn,
      isNotificationTurn: tc.isNotificationTurn,
      resolvedDestination: tc.resolvedReplyChannel,
    }));
  }
  const rd = renderReplyDestination(ctx.replyDestination, ctx.smsFromNumber, ctx.phoneFromNumber, ctx.replyRecipientName);
  if (rd) parts.push(rd);
  const cl = renderChannelLandscape(ctx.inboundChannel);
  if (cl) parts.push(cl);
  const pc = renderPhoneConduct(ctx.inboundChannel, ctx.lastUserContent, ctx.turnContext);
  if (pc) parts.push(pc);
  // FA-PT1: generic voice-mode conduct (C6), mutually exclusive with phone conduct.
  // Moved here from the cached system prefix (slot 2300) so a voice/text modality
  // switch (or a non-voice turn interleaved into a live voice conversation) no
  // longer busts the primary's whole system cache. Present only on voice turns, so
  // it lives on the volatile tail exactly like phone conduct (C28).
  const vc = renderVoiceConduct(ctx.inboundChannel, ctx.turnContext);
  if (vc) parts.push(vc);
  // FA-PT1: integration-reconnect honesty breadcrumb(s) (Inv I), 0+ parts. Moved
  // here from the system prefix (slot 1700): they flip in/out of the prefix on live
  // connection health (the same cache-busting class), so they ride the volatile tail
  // instead. Content identical; renderIntegrationReconnect keeps its own non-PM gate
  // and name-sorted determinism.
  for (const ir of renderIntegrationReconnect(ctx.agentId)) parts.push(ir);
  // P-5: live iMessage bridge state (the slot-700 tool guidance now carries only a
  // stable union sentence and points here). Primary only, matching where the tool
  // guidance describes the bridge.
  if (ctx.isPrimary) {
    let bridgeOn = false;
    try { bridgeOn = isIMBridgeRunning(); } catch { /* default off */ }
    parts.push(`iMessage bridge: ${bridgeOn ? 'on' : 'off'}`);
  }
  // othersWaiting head-of-line hint (moved verbatim from memory/assembler.ts).
  if (tc?.counterparty?.kind === 'user' && (tc.othersWaiting ?? 0) > 0) {
    const n = tc.othersWaiting!;
    parts.push(`[Engine hint: ${n} other conversation${n === 1 ? ' is' : 's are'} waiting for you right now. If THIS request is quick, just answer it. If it's a large or multi-step task (research, a plan, a project), don't do all the deep work now while the others wait, send a brief acknowledgment, capture it with work_open(kind="project") / a tracker task, and end the turn so you can serve the others; then work the project across later turns. Reply on this turn's channel as usual. Speak only to the person this turn is for: your text output IS the message they receive, so write the reply itself, don't narrate your triage ("I have two things to handle, let me reply to X and check Y's thread") and don't mention other people's or other agents' threads to them. Deciding what order to work things in is yours to do silently; the engine will bring you back for the others.]`);
  }
  // conversational-turn hint (moved verbatim; suppressed when othersWaiting covers it).
  if (tc?.conversationalTurn && !(tc?.othersWaiting && tc.othersWaiting > 0)) {
    parts.push(`[Engine hint: this is a quick conversational request, not a multi-step project. Handle it directly, answer it, do the small thing (set the reminder, move the event), or ask ONE clarifying question and then stop. Do NOT create a tracked project/task or loop in the PM for something this small. If you're missing a detail, just ask the user once and wait, the conversation holds until they reply, so don't re-ask it later or keep working it in the background.]`);
  }

  if (parts.length === 0) return null;
  return { role: 'user', content: `[Turn context]\n\n${parts.join('\n\n')}` };
}

const MESSAGE_ENTRIES: MessageInjection[] = [
  {
    id: 'msg.tool-note',
    target: 'messages',
    slot: MessageSlot.ToolNote,
    precedenceTier: 7,
    reason:
      'A model without tool support must be told it can only respond with text ' +
      '(so it does not promise tool actions it cannot perform). The loop owns the ' +
      'useTools + alternation gate; the entry owns the text + loopCount-1 gate.',
    when: (ctx) => ctx.loopCount === 1,
    render: () => ({ role: 'user', content: TOOL_NOTE_TEXT }),
  },
  {
    id: 'msg.pending-nudge',
    target: 'messages',
    slot: MessageSlot.PendingNudge,
    precedenceTier: 7,
    reason:
      'Single-shot engine steering for the next iteration (set by the loop, e.g. ' +
      'a stop/redirect). The loop owns the alternation gate; the entry renders the nudge text.',
    render: (ctx) => (ctx.pendingNudge ? { role: 'user', content: ctx.pendingNudge } : null),
  },
  {
    id: 'msg.context-gap',
    target: 'messages',
    slot: MessageSlot.ContextGap,
    precedenceTier: 7,
    reason:
      'Ask-when-stuck (Layer 2): when an attachment/ambiguous ask arrives with ' +
      'no instruction, nudge the agent to ask one specific question instead of ' +
      'guessing. Advisory engine hint; the agent uses judgment.',
    render: (ctx) => {
      const hint = detectContextGap(ctx.lastUserMessageContent);
      return hint ? { role: 'user', content: hint } : null;
    },
  },
  // ── STRIP (PHASE-3 T3, RULING P3-R1 item 2): `msg.tracker-notif` (slot 1500). ──
  //
  // requirement preserved: "an agent that has just been ASSIGNED work learns it was
  // assigned, and how to close it" — owned end to end by
  // `tracker/notify.ts:injectTaskAssignmentNotification`, which PERSISTS a
  // `[SOURCE: TRACKER TASK ASSIGNMENT]` engine-event row into the assignee's conversation,
  // broadcasts it to the dashboard, and WAKES the assignee. The entry was never that
  // mechanism: it was the SAME content pushed a second time into the in-flight array, for
  // the one case where the assignee was the agent already running (`skipWake: true`).
  //
  // Re-derived at `8f36cdb` before deciding, not inferred from the absence (#15):
  //   • its only injection site was the multistep classifier's auto-create block, deleted
  //     whole by `d00f270` (PHASE-2 T8c item 3 — 1,135 of 1,183 auto-created projects were
  //     empty; the classifier no longer creates anything);
  //   • `injectTaskAssignmentNotification` is ALIVE with two live callers,
  //     `tracker/tools.ts:891` and `:1214`, both agent-driven;
  //   • `skipWake: true` now has ZERO callers whole-tree (`git grep -n skipWake` →
  //     `notify.ts:42/:103/:193` and nothing else), so in every surviving path the assignee
  //     is a DIFFERENT agent, is woken, and reads the notice as a persisted row on its own
  //     next assembly. The same-turn duplicate is not merely unused; it is unreachable.
  // A registered entry with no injection site is exactly what the lane table makes
  // impossible, so it is removed rather than left registered and never rendered.
  // (`AssemblyContext.trackerNotif` goes with it; `skipWake` is enumerated for T9.)
  {
    id: 'msg.delegation-hint',
    target: 'messages',
    slot: MessageSlot.DelegationHint,
    precedenceTier: 7,
    reason:
      'F9: when the user EXPLICITLY routes work to the agent\'s own agents ("have ' +
      'one of your agents research it and report back to me"), the floor model was ' +
      'observed doing the work itself and never mentioning the choice. Advice-voice ' +
      'engine hint (tier 7): delegate, or briefly say why you are handling it ' +
      'directly, never silently override. Content is computed by the loop detector; ' +
      'the entry renders + injects it.',
    render: (ctx) => (ctx.delegationHint ? { role: 'user', content: ctx.delegationHint } : null),
  },
  {
    id: 'msg.technique-strong',
    target: 'messages',
    slot: MessageSlot.TechniqueStrong,
    precedenceTier: 2,
    reason:
      'Strong-match technique procedure injected as its OWN engine-marked message ' +
      'adjacent to the ask (C12), at technique-notes precedence, the live user ' +
      'message outranks it. Content (matcher + body) is computed by the loop; the ' +
      'entry renders + injects it.',
    render: (ctx) => (ctx.techniqueStrong ? { role: 'user', content: ctx.techniqueStrong } : null),
  },
  {
    id: 'msg.technique-weak',
    target: 'messages',
    slot: MessageSlot.TechniqueWeak,
    precedenceTier: 2,
    reason:
      'Weak-match "consider these techniques" hint. Was raw-appended to the system ' +
      'prompt (legacy), which broke prompt caching: the matched-strength wording ' +
      'changes per user message, so a volatile string lived inside the otherwise ' +
      'stable cached prefix. Now injected as a post-tail engine message (the R5 ' +
      'move the slot enum always anticipated), keeping the system prefix cacheable. ' +
      'Content is computed by the loop matcher; the entry renders + injects it.',
    render: (ctx) => {
      const h = ctx.techniqueWeakHint?.trimStart();
      return h ? { role: 'user', content: h } : null;
    },
  },
  {
    id: 'msg.turn-context',
    target: 'messages',
    slot: MessageSlot.TurnContext,
    precedenceTier: 7,
    reason:
      'C28 Part 1: the per-turn volatile routing/presence block (reply destination, ' +
      'the sole routing authority C5, channel landscape, phone conduct, counterparty ' +
      'header, live iMessage bridge state, othersWaiting / conversational-turn hints) ' +
      'as ONE near-tail engine message. Moved out of the cached system prefix so a ' +
      'channel/presence/waiting-count change no longer invalidates it (all-provider ' +
      'cache fix, P-1). Sits just before the current-time tail.',
    render: (ctx) => renderTurnContext(ctx),
  },
  {
    id: 'msg.deliveries',
    target: 'messages',
    slot: MessageSlot.Deliveries,
    precedenceTier: 7,
    reason:
      'PHASE-3 T7: THE DELIVERIES LANE — what this agent has already sent the ' +
      'counterparty, read from the `deliveries` rows (mig 121) by ' +
      '`memory/deliveries-lane.ts`, so the recipient\'s next turn sees the question it ' +
      'was asked. It replaces RC-1\'s cross-conversation ECHO ROW DUPLICATION (an extra ' +
      'assistant message written into the recipient\'s conversation) and the ' +
      'registry-exempt pending-question header that echo suppressed. Volatile by shape ' +
      '(relative times) and scoped to the conversation being served, so it lives past ' +
      'the cache boundary at 1860 — the physical position the header already held, ' +
      'between turn-context and peer-status. Content is rendered + fitted to the lane\'s ' +
      'declared reserve by the lane module; the loop supplies it because the dedup ' +
      'against the not-yet-stripped echo rows is a fact about the in-flight array.',
    render: (ctx) => (ctx.deliveriesLane ? { role: 'user', content: ctx.deliveriesLane } : null),
  },
  {
    id: 'msg.peer-status',
    target: 'messages',
    slot: MessageSlot.PeerStatus,
    precedenceTier: 7,
    reason:
      'Live group-peer statuses as a near-tail volatile message. The cached ' +
      'group roster (sys.group) carries member NAMES only; the idle/working ' +
      'state changes with every peer turn and every Dreamer batch, so it lives ' +
      'here where its churn costs no cache (2026-07-16 finding, same relocation ' +
      'pattern as msg.current-time).',
    render: (ctx) => {
      const line = renderPeerStatusLine(ctx.agentId);
      return line ? { role: 'user', content: line } : null;
    },
  },
  {
    id: 'msg.current-time',
    target: 'messages',
    slot: MessageSlot.CurrentTime,
    precedenceTier: 7,
    reason:
      'Precise clock time as the LAST (most volatile) message. The system prompt ' +
      'carries date-only (stable, cacheable); the per-minute clock time lives here ' +
      'so its per-call churn falls after the entire cached prefix (system + tools + ' +
      'conversation history) instead of breaking it. Always rendered.',
    render: () => ({ role: 'user', content: renderCurrentTimeMessage() }),
  },
];

for (const entry of SYSTEM_ENTRIES) register(entry);
for (const entry of MESSAGE_ENTRIES) register(entry);
