// Registered prompt-injection entries. Each `render` delegates to its section's renderer, most of them
// in prompt/assembler.ts, so one function owns each section's text.

import { isPresenceCheck, PRESENCE_HINT } from '../presence-check.js';
import { register } from './registry.js';
import { SystemSlot, MessageSlot, type SystemInjection, type MessageInjection, type AssemblyContext, type EngineMessage } from './types.js';
import { renderCounterpartyHeader } from '../../agent/v2/counterparty.js';
import { deliveryLabel, renderTailRestatement } from '../../agent/v2/turn-address.js';
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
import { userWords } from '../../agent/v2/turn-address.js';

// System-prompt entries
const SYSTEM_ENTRIES: SystemInjection[] = [
  {
    id: 'sys.time',
    target: 'system',
    slot: SystemSlot.Time,
    reason: 'Tells the agent where the clock lives (msg.current-time, in the tail) and how to judge the age of context; it carries no date, so the cached prefix does not roll at midnight.',
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
    reason: 'The published techniques this agent is granted, so it can find and use a matching procedure; the live user message outranks a technique.',
    render: (ctx) => generateTechniqueIndex(ctx.agentId),
  },
  {
    id: 'sys.techniques-draft',
    target: 'system',
    slot: SystemSlot.TechniquesDraft,
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
    reason:
      'Primary only: names the PM agent + tracker-first guidance (the PM watches ' +
      'the tracker; schedule work there, do not spawn watcher agents).',
    render: (ctx) => renderPmAwareness(ctx.agentId),
  },
  {
    id: 'sys.trainer-awareness',
    target: 'system',
    slot: SystemSlot.TrainerAwareness,
    reason: 'Primary only: names the Trainer agent (owns the technique library; the main agent may write techniques too).',
    render: (ctx) => renderTrainerAwareness(ctx.agentId),
  },
  {
    id: 'sys.healer-awareness',
    target: 'system',
    slot: SystemSlot.HealerAwareness,
    reason: 'Primary only: names the Healer agent (auto-triages injured/stuck agents).',
    render: (ctx) => renderHealerAwareness(ctx.agentId),
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
    id: 'sys.techniques-equipped',
    target: 'system',
    slot: SystemSlot.TechniquesEquipped,
    reason:
      'Full TECHNIQUE.md bodies for equipped techniques, pre-loaded; ladder-anchored ' +
      '(the live user message outranks a technique).',
    render: (ctx) => renderEquippedTechniques(ctx.agentId),
  },
];

// Message-side entries
const TOOL_NOTE_TEXT =
  `[System note: Your current model does not support tool calling. You can only respond with text. ` +
  `If the person you are talking to asks you to do something that requires tools (file access, web search, tracker, etc.), ` +
  `explain that your model doesn't support it and suggest they switch to a tool-capable model in Settings.]`;

// The per-turn volatile routing/presence context as ONE near-tail engine message: counterparty header,
// reply-destination tag (from the turn's address), channel landscape, phone and voice conduct,
// integration-reconnect lines, iMessage bridge state and the waiting/conversational hints. It changes
// turn to turn, so keeping it out of the system prefix lets the prefix cache across those changes.
function renderTurnContext(ctx: AssemblyContext): EngineMessage | null {
  const tc = ctx.turnContext;
  const parts: string[] = [];

  if (tc?.counterparty) {
    parts.push(renderCounterpartyHeader(tc.counterparty, {
      isEngineTurn: tc.isEngineTurn,
      isNotificationTurn: tc.isNotificationTurn,
      address: tc.address,
    }));
  }
  if (tc?.counterparty && tc.counterparty.kind !== 'agent' && !tc.isEngineTurn && !tc.isNotificationTurn && isPresenceCheck(ctx.lastUserMessageContent)) parts.push(PRESENCE_HINT);
  const rd = renderReplyDestination(ctx.replyDestination, ctx.smsFromNumber, ctx.phoneFromNumber, ctx.replyRecipientName);
  if (rd) parts.push(rd);
  const cl = renderChannelLandscape(ctx.inboundChannel);
  if (cl) parts.push(cl);
  const pc = renderPhoneConduct(ctx.inboundChannel, ctx.lastUserContent, ctx.turnContext);
  if (pc) parts.push(pc);
  // Voice-mode conduct; renderVoiceConduct returns null on phone turns, so it never doubles phone conduct.
  const vc = renderVoiceConduct(ctx.inboundChannel, ctx.turnContext);
  if (vc) parts.push(vc);
  // Integration-reconnect breadcrumbs (0+ parts); renderIntegrationReconnect keeps its own non-PM gate.
  for (const ir of renderIntegrationReconnect(ctx.agentId)) parts.push(ir);
  // Live iMessage bridge state; primary only, matching where the tool guidance describes the bridge.
  if (ctx.isPrimary) {
    let bridgeOn = false;
    try { bridgeOn = isIMBridgeRunning(); } catch { /* default off */ }
    parts.push(`iMessage bridge: ${bridgeOn ? 'on' : 'off'}`);
  }
  // othersWaiting head-of-line hint.
  if (tc?.counterparty?.kind === 'user' && (tc.othersWaiting ?? 0) > 0) {
    const n = tc.othersWaiting!;
    parts.push(`[Engine hint: ${n} other conversation${n === 1 ? ' is' : 's are'} waiting for you right now. If THIS request is quick, just answer it. If it's a large or multi-step task (research, a plan, a project), don't do all the deep work now while the others wait, send a brief acknowledgment, capture it with work_open(kind="project") / a tracker task, and end the turn so you can serve the others; then work the project across later turns. ${tc.address?.kind === 'person' ? `Your written reply goes to ${tc.address.name} by ${deliveryLabel(tc.address.deliveryChannel)}, as usual.` : 'Reply as usual.'} Speak only to the person this turn is for: your text output IS the message they receive, so write the reply itself, don't narrate your triage ("I have two things to handle, let me reply to X and check Y's thread") and don't mention other people's or other agents' threads to them. Deciding what order to work things in is yours to do silently; the engine will bring you back for the others.]`);
  }
  // conversational-turn hint, suppressed when othersWaiting covers it.
  if (tc?.conversationalTurn && !(tc?.othersWaiting && tc.othersWaiting > 0)) {
    parts.push(`[Engine hint: this is a quick conversational request, not a multi-step project. Handle it directly, answer it, do the small thing (set the reminder, move the event), or ask ONE clarifying question and then stop. Do NOT create a tracked project/task or loop in the PM for something this small. If you're missing a detail, just ask ${userWords(tc?.address)} once and wait, the conversation holds until they reply, so don't re-ask it later or keep working it in the background.]`);
  }

  if (parts.length === 0) return null;
  return { role: 'user', content: `[Turn context]\n\n${parts.join('\n\n')}` };
}

const MESSAGE_ENTRIES: MessageInjection[] = [
  {
    id: 'msg.tool-note',
    target: 'messages',
    slot: MessageSlot.ToolNote,
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
    reason:
      'Single-shot engine steering for the next iteration (set by the loop, e.g. ' +
      'a stop/redirect). The loop owns the alternation gate; the entry renders the nudge text.',
    render: (ctx) => (ctx.pendingSteer ? { role: 'user', content: ctx.pendingSteer } : null),
  },
  {
    id: 'msg.context-gap',
    target: 'messages',
    slot: MessageSlot.ContextGap,
    reason:
      'Ask-when-stuck (Layer 2): when an attachment/ambiguous ask arrives with ' +
      'no instruction, nudge the agent to ask one specific question instead of ' +
      'guessing. Advisory engine hint; the agent uses judgment.',
    render: (ctx) => {
      const hint = detectContextGap(ctx.lastUserMessageContent);
      return hint ? { role: 'user', content: hint } : null;
    },
  },
  // msg.tracker-notif (slot 1500) is deliberately not registered: a task-assignment notice is a persisted
  // row written by tracker/notify.ts (injectTaskAssignmentNotification), never an in-flight injection.
  {
    id: 'msg.delegation-hint',
    target: 'messages',
    slot: MessageSlot.DelegationHint,
    reason: 'When the user explicitly asks for the work to go to the agent\'s own helpers, an advice-voice hint: delegate, or say briefly why not. The loop computes the text; the entry renders it.',
    render: (ctx) => (ctx.delegationHint ? { role: 'user', content: ctx.delegationHint } : null),
  },
  {
    id: 'msg.technique-strong',
    target: 'messages',
    slot: MessageSlot.TechniqueStrong,
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
    reason: 'A weak-match "consider these techniques" hint, after the tail because its wording changes with each user message. The loop matcher computes it; the entry renders it.',
    render: (ctx) => {
      const h = ctx.techniqueWeakHint?.trimStart();
      return h ? { role: 'user', content: h } : null;
    },
  },
  {
    id: 'msg.turn-context',
    target: 'messages',
    slot: MessageSlot.TurnContext,
    reason: 'The per-turn routing and presence block (reply destination, channel landscape, phone and voice conduct, counterparty header, iMessage bridge state, waiting hints) as one near-tail message, so its changes never touch the cached prefix.',
    render: (ctx) => renderTurnContext(ctx),
  },
  {
    id: 'msg.deliveries',
    target: 'messages',
    slot: MessageSlot.Deliveries,
    reason: 'What this agent has already sent the counterparty in the served conversation, from the deliveries rows (memory/deliveries-lane.ts). Volatile, so it sits past the cache boundary, between turn-context and peer-status.',
    render: (ctx) => (ctx.deliveriesLane ? { role: 'user', content: ctx.deliveriesLane } : null),
  },
  {
    id: 'msg.relevant-memory',
    target: 'messages',
    slot: MessageSlot.RecalledMemory,
    reason: 'Per-message semantic recall and the answers already given to recalled asks (answered-edge.ts). It changes with every ask, so it rides the tail, behind peer-status.',
    render: (ctx) => (ctx.recallLane ? { role: 'user', content: ctx.recallLane } : null),
  },
  // Lanes that must render below the conversation: whatever a tool can mutate would otherwise re-bill
  // every token behind it when it moves. Emitted most-stable-first (1810 to 1840), ahead of turn-context.
  {
    id: 'msg.attempt-ledger',
    target: 'messages',
    slot: MessageSlot.AttemptLedgerTail,
    reason: 'The engine\'s record of work on the agent\'s active tasks (memory/work-board-lane.ts). Every work write moves it, so it renders below the conversation; first of the four tail lanes because it is the most stable.',
    render: (ctx) => (ctx.attemptLedgerLane ? { role: 'user', content: ctx.attemptLedgerLane } : null),
  },
  {
    id: 'msg.active-tasks',
    target: 'messages',
    slot: MessageSlot.ActiveTasksTail,
    reason: 'The agent\'s work board, from the same read as msg.attempt-ledger. Work tools and engine floors move it, so it renders below the conversation.',
    render: (ctx) => (ctx.activeTasksLane ? { role: 'user', content: ctx.activeTasksLane } : null),
  },
  {
    id: 'msg.scratchpad',
    target: 'messages',
    slot: MessageSlot.ScratchpadTail,
    reason: 'The agent\'s scratchpad. Three tools rewrite it mid-conversation (scratchpad_set, scratchpad_clear, reset_session), so it renders below the conversation, capped by LANE_LIMITS[\'lane.scratchpad\'].',
    render: (ctx) => (ctx.scratchpadLane ? { role: 'user', content: ctx.scratchpadLane } : null),
  },
  {
    id: 'msg.events',
    target: 'messages',
    slot: MessageSlot.EventsTail,
    reason: 'Recent events and notices from the fresh tail\'s row window. The window moves with every tool call, so it renders below the conversation; last of the four tail lanes because it is the most volatile.',
    render: (ctx) => (ctx.eventsLane ? { role: 'user', content: ctx.eventsLane } : null),
  },
  {
    id: 'msg.peer-status',
    target: 'messages',
    slot: MessageSlot.PeerStatus,
    reason: 'Live group-peer statuses. The cached group roster (sys.group) carries names only; idle and working flips land here, where they cost no cache.',
    render: (ctx) => {
      const line = renderPeerStatusLine(ctx.agentId);
      return line ? { role: 'user', content: line } : null;
    },
  },
  {
    id: 'msg.integration-status',
    target: 'messages',
    slot: MessageSlot.IntegrationStatusTail,
    reason: 'Each granted integration\'s current state, last successful use and unresolved failures, from the platform\'s own records, stated as superseding any earlier mention. It sits at the last stable seat of the tail.',
    render: (ctx) => (ctx.integrationStatusLane ? { role: 'user', content: ctx.integrationStatusLane } : null),
  },
  {
    id: 'msg.current-time',
    target: 'messages',
    slot: MessageSlot.CurrentTime,
    reason:
      'Precise clock time as the LAST (most volatile) message. The system prompt ' +
      'carries date-only (stable, cacheable); the per-minute clock time lives here ' +
      'so its per-call churn falls after the entire cached prefix (system + tools + ' +
      'conversation history) instead of breaking it. Always rendered.',
    // On a routed channel the clock message also restates who the written reply goes to; it is
    // re-sent every call, already past the cache breakpoint, so the addition costs no extra cache.
    render: (ctx) => {
      const restated = renderTailRestatement(ctx.turnContext?.address);
      return { role: 'user', content: restated ? `${renderCurrentTimeMessage()}\n${restated}` : renderCurrentTimeMessage() };
    },
  },
];

for (const entry of SYSTEM_ENTRIES) register(entry);
for (const entry of MESSAGE_ENTRIES) register(entry);
