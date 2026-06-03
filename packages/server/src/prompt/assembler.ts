import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_SOUL_MD, DEFAULT_USER_MD, DEFAULT_PM_SOUL_MD, DEFAULT_TRAINER_SOUL_MD } from './templates.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { toolDefinitions, getFilteredTools } from '../agent/tools.js';
import { isPrimaryAgent, isPMAgent, isTrainerAgent, getPrimaryAgentName, getPrimaryAgentId, getPMAgentName, getPMAgentId, getOwnerName } from '../config/platform.js';
import { getAgentGoogleAccessLevel } from '../google/auth.js';
import { getAgentMicrosoftAccessLevel, getMsAccountType, getMicrosoftWorkspaceConfig } from '../microsoft/auth.js';
import { assembleGroupContext as _assembleGroupContext } from '../agent/groups.js';
import { generateTechniqueIndex, generateDraftTechniqueContext } from '../techniques/index-builder.js';
import { getContextWindow } from '../agent/model.js';
import { isIMBridgeRunning, addressesMatch } from '../services/imessage-bridge.js';
import { getPresence, isImessageConfigured } from '../services/presence.js';
import { resolveReplyDestination } from '../agent/v2/reply-destination.js';
import { getGmailSafeSenders, getOutlookSafeSenders, getTeamsSafeSenders } from '../services/channel-safe-senders.js';

// Prompt complexity tiers based on model context window
type PromptTier = 'full' | 'standard' | 'compact' | 'minimal';
function getPromptTier(contextWindow: number): PromptTier {
  if (contextWindow >= 200000) return 'full';
  if (contextWindow >= 32000) return 'standard';
  if (contextWindow >= 8000) return 'compact';
  return 'minimal';
}
import { generateToolIndex, generateToolIndexCompact } from '../tools/categories.js';
import { getAgentAlwaysLoadedTools } from '../tools/tool-docs.js';
// (getRuntimeVersion import removed in Phase 9 Stage 2 — single-track v2)

const logger = createLogger('prompt-assembler');
const PROMPTS_DIR = path.join(os.homedir(), '.dojo', 'prompts');

function ensurePromptsDir(): void {
  if (!fs.existsSync(PROMPTS_DIR)) {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  }
}

function readPromptFile(filename: string, defaultContent: string): string {
  ensurePromptsDir();
  const filePath = path.join(PROMPTS_DIR, filename);

  if (fs.existsSync(filePath)) {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      logger.warn('Failed to read prompt file, using default', {
        file: filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Write default to disk for future editing
  try {
    fs.writeFileSync(filePath, defaultContent, 'utf-8');
    logger.info('Created default prompt file', { file: filename });
  } catch {
    // Non-fatal: use in-memory default
  }

  return defaultContent;
}

function getSoulContent(agentId: string): string {
  // Primary agent gets SOUL.md
  if (isPrimaryAgent(agentId)) {
    return readPromptFile('SOUL.md', DEFAULT_SOUL_MD);
  }

  // PM agent gets PM-SOUL.md
  if (isPMAgent(agentId)) {
    return readPromptFile('PM-SOUL.md', DEFAULT_PM_SOUL_MD);
  }

  // Trainer agent gets TRAINER-SOUL.md
  if (isTrainerAgent(agentId)) {
    return readPromptFile('TRAINER-SOUL.md', DEFAULT_TRAINER_SOUL_MD);
  }

  // Check for agent-specific soul file
  const agentSoulPath = path.join(PROMPTS_DIR, `${agentId.toUpperCase()}-SOUL.md`);
  if (fs.existsSync(agentSoulPath)) {
    try {
      return fs.readFileSync(agentSoulPath, 'utf-8');
    } catch {
      // Fall through
    }
  }

  // Sub-agents: comprehensive dojo onboarding — NOT the primary agent's SOUL.md
  try {
    const db = getDb();
    const agentRow = db.prepare('SELECT name, group_id, parent_agent, classification FROM agents WHERE id = ?').get(agentId) as { name: string; group_id: string | null; parent_agent: string | null; classification: string } | undefined;
    const agentName = agentRow?.name ?? 'Agent';
    const classification = agentRow?.classification ?? 'apprentice';

    // Get parent agent name
    let parentInfo = '';
    if (agentRow?.parent_agent) {
      const parent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentRow.parent_agent) as { name: string } | undefined;
      parentInfo = parent ? `Your parent agent is **${parent.name}** (ID: ${agentRow.parent_agent}).` : '';
    }

    // Get group info
    let groupInfo = '';
    if (agentRow?.group_id) {
      const group = db.prepare('SELECT name, description FROM agent_groups WHERE id = ?').get(agentRow.group_id) as { name: string; description: string | null } | undefined;
      if (group) {
        const members = db.prepare("SELECT name, id FROM agents WHERE group_id = ? AND status != 'terminated' AND id != ?").all(agentRow.group_id, agentId) as Array<{ name: string; id: string }>;
        groupInfo = `You are in the squad **"${group.name}"**${group.description ? ` — ${group.description}` : ''}.`;
        if (members.length > 0) {
          groupInfo += ` Your squad members: ${members.map(m => `${m.name} (${m.id})`).join(', ')}.`;
        }
      }
    }

    // Get PM agent info
    const pmName = getPMAgentName();
    const pmId = getPMAgentId();

    // Get primary agent info
    const primaryName = getPrimaryAgentName();
    const primaryId = getPrimaryAgentId();

    // The "Communication" how-to and "Vault" instructional blocks are NOT
    // here — engine enforces A2A intent rules and prefetches vault context
    // at session start, so the prompt only carries structural identity /
    // parent / squad context.
    return `# Identity

You are **${agentName}**, a ${classification} agent in the DOJO Agent Platform. Your agent ID is \`${agentId}\`.

${parentInfo}

# The Dojo

You are part of an AI agent orchestration platform.

- **${primaryName}** (ID: ${primaryId}) is the Dojo Master — primary agent who coordinates work. Reach them via \`send_to_agent\` only when you have something they actually need (an answer they asked for, a blocker, a deliverable). Don't send status updates or completion announcements; the tracker already shows status.
- **${pmName}** (ID: ${pmId}) is the Dojo Planner — PM agent monitoring the tracker. Message them only if blocked.
${groupInfo ? `- ${groupInfo}` : ''}

# Rules

- Follow your task instructions precisely.
- Update your tracker task status as you work; call \`complete_task\` when done. The \`summary\` field is read internally by the parent agent — that IS your report; do not write a parallel chat message announcing completion.
- If blocked, set tracker status to "blocked" and message ${primaryName} or ${pmName}.
- Silence is the default. Don't narrate, acknowledge, or close out actions you took. The completion is evident from the tracker and from what changed.`;
  } catch {
    return '# Identity\n\nYou are a sub-agent in the DOJO Agent Platform. Follow your task instructions and call complete_task when done.';
  }
}

// True when the most recent user message for this agent is an incoming
// iMessage (carries the [SOURCE: IMESSAGE FROM ...] tag). Used to scope
// iMessage-only prompt guidance so dashboard turns don't pay the tokens.
function isIMessageTurn(agentId: string): boolean {
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT content FROM messages
       WHERE agent_id = ? AND role = 'user'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    ).get(agentId) as { content: string } | undefined;
    return !!row?.content?.includes('[SOURCE: IMESSAGE FROM');
  } catch {
    return false;
  }
}

function generateToolsGuidance_v2(agentId: string): string {
  const agentTools = getFilteredTools(agentId);
  const lines: string[] = [];

  // 1. "Silent turns are first-class" + terseness rules (v2.7.22).
  //    The real failure mode is the agent feels compelled to produce
  //    text on every turn — even after internal bookkeeping where the
  //    user has nothing new to learn. The fix is to teach the existing
  //    [no-reply] escape hatch as a general-purpose mechanism: any
  //    turn can end silently, and the engine handles it cleanly.
  lines.push(`## How You Communicate

**You always have an escape hatch.** When a turn doesn't warrant a user-facing message — internal bookkeeping just completed, you already gave the real reply earlier this turn, a notification arrived that doesn't need surfacing, a tool result resolved something with no new info for the user — end the turn by emitting the literal sentinel \`[no-reply]\` on a line by itself, nothing else. The engine swallows it: no chat bubble, no iMessage, no noise. The turn ends cleanly. This is your release valve from the "I must say something" reflex.

Use \`[no-reply]\` whenever any of these apply:
- You just called \`tracker_update_status\` / \`complete_task\` / \`vault_remember\` / \`credential_add\` / \`tracker_complete_step\` and the user already has the answer they needed (or there's no user question to answer). The tool result is the bookkeeping; the user does not need a parallel "Done." or "All set." line.
- The trigger for this turn was an internal event (scheduler firing, tool result handoff, tracker auto-close re-prompt) and there's nothing new the user needs to know.
- You already produced a substantive reply earlier in this turn and the only thing you'd add now is a restatement or wrap-up.
- An incoming notification doesn't meet the bar for surfacing (routine receipt, no-reply auto-ack, promo email, etc.).

**When you SHOULD write text instead:** the user asked a direct question (answer it), the user asked for a deliverable (provide it), there's genuine new info or a decision the user needs that they would not otherwise see, you're inside an explicit chat conversation where a reply is expected, or you're starting a turn fresh and the user requested an outcome (give them the outcome, once).

**Respond once per request. Don't double-respond.** When the user asks you to do something: do the work, tell them the outcome in your reply, then stop. Any subsequent internal events on the SAME thread (closing the auto-created tracker task, secondary bookkeeping) do NOT trigger another user-facing message — emit \`[no-reply]\` on that secondary iteration. The single biggest noise pattern is the SECOND message that re-narrates a completion the user already saw.

**Don't narrate internal state.** Phrases like "Standing by", "Waiting on his reply", "That's the honest answer he deserved", "Holding the line" are you thinking out loud. The user is not the audience for your internal monologue. If you'd produce one of those, use \`[no-reply]\` instead.

**Anti-patterns — these are signals to use \`[no-reply]\` instead:**

- "Done." / "Done. Locked in." / "All set." / "You're set." / "All cleared." / "All wrapped." (as standalone closeouts after the real reply was already given)
- "Noted." / "Got it." / "On it." / "Roger." / "Understood." (when nothing else is being said)
- "Smoke test passed." / "Task complete." / "Inbox caught up." / "Marked complete." (status reports nobody asked for)
- "Standing by." / "Waiting on his reply." (internal state)
- A second message restating what you already said in different words.

Other communication rules (when you DO speak):

- Be terse. Lead with the answer. No prefaces ("Sure, I can help with that").
- Do not recap what you just did ("I went ahead and read the file and now I'll..."). The chat shows it.
- Do not summarize or echo tool results — the chat shows them. Mention a tool result only if the user asked for it.
- A short, complete answer is always better than a long, padded one. Final responses default to one paragraph; expand only if the task genuinely needs detail.
- Do not quote large tool output back at the user. Do not keep tool output in your prose past the turn that produced it.
- When you don't know, say so directly and search the vault. Don't guess.
- When something fails, report it once with the cause. Don't apologize repeatedly.
`);
  lines.push('');

  // 2. How tools return content — Phase 3.5 §A summarize-by-default pattern.
  //    Concise overview so agents know about the prompt/goal idiom and
  //    expand-on-demand pairs without reading every tool's docs.
  lines.push(`## How Tools Return Content

Tools default to **compact**: focused summaries, not raw dumps. The engine caps each tool's output and the tool itself returns the smallest useful slice. Patterns to know:

- **Search/list tools** return short snippets per result (subject + sender + ~200 char snippet, etc.). Use the matching expand tool when a snippet isn't enough — \`vault_search\` → \`vault_expand(entry_id)\`.
- **\`web_fetch\`** requires a \`prompt\` parameter — the tool fetches the URL, runs a fast model with your prompt, returns ~1-2K tokens of focused extract. Be specific in the prompt.
- **\`web_browse\`** with \`extract\` action accepts an optional \`goal\` for the same focused-extract pattern. Use it when the page is large.
- **\`file_read\`** returns up to ~8K tokens with line numbers. If the file is bigger you get a clear pagination trailer with the exact \`offset\`/\`limit\` to call next.
- **Most tools self-truncate** with a "[Truncated by engine: returned ~N tokens of ~M total]" trailer when oversized. Adapt: paginate, narrow your query, or use a more specific tool.
`);
  lines.push('');

  // 3. Tool index — compact variant (Phase 5): 60-char descriptions, no
  // per-tool always-loaded marker (enumerated once at top instead).
  // Kevin (primary, ~165 tools) drops from ~2.8K to ~1.4K tokens here.
  const alwaysLoaded = getAgentAlwaysLoadedTools(agentId);
  lines.push(generateToolIndexCompact(agentTools, alwaysLoaded));
  lines.push('');

  // 3. Brief, single-line notes per tool category (the v1 long blocks
  //    are deleted — engine enforces the underlying rules):

  const hasImessage = agentTools.some(t => t.name === 'imessage_send');
  if (hasImessage) {
    const ownerName = getOwnerName();
    // v2.3.19 — proactively tell the agent whether the bridge is on. If
    // it's off, the agent should use the dashboard chat instead of
    // wasting a tool call. (The tool dispatcher also fails loudly if
    // the agent tries anyway — this is just the cheaper signal.)
    let bridgeRunning = false;
    try { bridgeRunning = isIMBridgeRunning(); } catch { /* default: assume off */ }

    if (isPrimaryAgent(agentId)) {
      lines.push(`## iMessage`);
      if (bridgeRunning) {
        lines.push(
          `**Replies to inbound iMessages auto-route via the engine — you do NOT need to call \`imessage_send\` to reply.** Just write your reply text; the per-turn \`[Reply destination: ...]\` tag at the top of this prompt tells you when iMessage routing is active. When it is, write in SMS voice (no markdown).\n\n` +
          `\`imessage_send\` is reserved for:\n` +
          `- Proactive outreach (no inbound triggered this turn, you're initiating)\n` +
          `- Sending to someone OTHER than the active iMessage thread\n` +
          `- Rich actions (attachments, reactions — Phase 2)\n\n` +
          `If the inbound doesn't warrant a reply (closing pleasantry, FYI, etc.), end the turn with \`[no-reply]\`.`,
        );
      } else {
        lines.push(`iMessage is currently disabled on this server — auto-routing won't fire and \`imessage_send\` will fail. Use the dashboard chat for all communication with ${ownerName} until they re-enable it in Settings → Channels (iMessage card).`);
      }
      lines.push('');
    } else if (!bridgeRunning) {
      // Non-primary agents with the tool — also tell them it's off so
      // they don't try.
      lines.push(`## iMessage`);
      lines.push(`iMessage is currently disabled on this server. \`imessage_send\` will fail; tell ${ownerName} in the dashboard chat instead.`);
      lines.push('');
    }
  }

  const hasSendToAgent = agentTools.some(t => t.name === 'send_to_agent');
  if (hasSendToAgent) {
    lines.push(`## Talking to Other Agents`);
    lines.push(`Other agents can't see your chat. Use \`send_to_agent\` to message them — the DOJO validates intent and threading. Wake intents (QUESTION/ASSIGN/BLOCK/ANSWER/DELIVERABLE) prompt a reply; no-wake intents (FYI/STATUS/COMPLETE/FAIL) don't.`);
    lines.push('');
  }

  const hasTracker = agentTools.some(t => t.name.startsWith('tracker_'));
  if (hasTracker) {
    lines.push(`## Tracker`);
    lines.push(`Use the tracker for multi-step work. The DOJO auto-creates tasks when it sees you're about to make 2+ non-trivial tool calls without one — you can also create tasks explicitly with \`tracker_create_task\`.`);
    lines.push('');
  }

  const hasVault = agentTools.some(t => t.name.startsWith('vault_'));
  if (hasVault) {
    lines.push(`## Vault (Long-Term Memory)`);
    lines.push(`The vault is your permanent shared memory. Use \`vault_search\` before saying "I don't remember." Use \`vault_remember\` to save important facts, decisions, corrections, and personal context. Pinned + relevant entries are auto-loaded at session start.`);
    lines.push('');
  }

  const hasTechniques = agentTools.some(t => t.name === 'use_technique' || t.name === 'list_techniques');
  if (hasTechniques) {
    lines.push(`## Techniques`);
    lines.push(`Curated procedures available via \`list_techniques\` and \`use_technique\`. The DOJO surfaces relevant ones automatically; you can also browse explicitly.`);
    lines.push('');
  }

  const canSpawn = agentTools.some(t => t.name === 'spawn_agent');
  if (canSpawn) {
    lines.push(`## Spawning Sub-Agents`);
    lines.push(`Create a tracker_create_project first, then spawn agents into a group with \`spawn_agent\` and \`create_agent_group\`. Clean up via \`delete_group(terminate_members=true)\`. PM monitors all tasks — don't create your own monitoring agents.`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Check if agent should receive USER.md ──

function shouldShareUserProfile(agentId: string): boolean {
  // Primary agent and PM always get user profile
  if (isPrimaryAgent(agentId) || isPMAgent(agentId)) return true;

  try {
    const db = getDb();
    const row = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    if (row) {
      const config = JSON.parse(row.config || '{}');
      return config.shareUserProfile === true;
    }
  } catch {
    // Default to not sharing
  }
  return false;
}

// ── Main Assembly ──

/**
 * Per-turn context that influences how the system prompt is composed.
 * Today this is just the source of the latest user message (voice vs
 * text); the assembler uses it to swap in spoken-conduct guidance on
 * voice turns. The caller computes this once per turn and threads the
 * same value through every model call within the turn, so a voice-mode
 * conduct rule stays in scope across tool iterations.
 */
export interface PromptTurnContext {
  latestUserSource: 'voice' | 'text' | null;
  /**
   * Active TTS engine for the voice path, used to choose between the
   * flat-voice (local Kokoro) and expressive (cloud Hume) addendum. If
   * omitted, the assembler reads `voice.tts_engine` from the config
   * table; the explicit field is for tests and for callers that already
   * have the value cached.
   */
  ttsEngine?: 'local' | 'cloud' | null;
}

/**
 * Voice-mode conduct base (Phase 3 + Hume cloud TTS). Shared by both
 * engines — the short/spoken/no-markdown rules apply regardless of which
 * voice is reading the reply aloud. The engine-specific addendum below
 * gets appended at injection time.
 */
const VOICE_BASE_BLOCK = `## Voice mode (this turn)

You are speaking out loud in a live voice conversation, not writing.
Everything you say is read by a text-to-speech voice, so write it the way you
would actually say it.

How to talk:
- Short. Usually one or two sentences. Lead with the answer, then stop. If
  there is more, offer it instead of dumping it all at once.
- Plain spoken phrasing and contractions. Say "it's", "you'll", "I'd". Talk
  like a person catching someone up, not like a written document.
- No markdown, no bullet points, no numbered lists, no headings, no emojis, no
  asterisks or symbols meant to be seen rather than heard. If you catch
  yourself making a list, say it as a sentence instead.
- For anything long or step-by-step, give the short spoken version and offer to
  drop the full details in text rather than reading it all aloud.

Here is the kind of difference that matters:

User: What's the weather looking like for the trip?
Don't say: "Here's the forecast: 1. Saturday: sunny, high 72. 2. Sunday:
partly cloudy, 68. 3. Monday: rain likely."
Do say: "Looks good. Sunny Saturday, around 72, then it cools off and there's
some rain coming in Monday."

User: How do I reset the router?
Don't say: a numbered five-step list.
Do say: "Hold the little reset button on the back for about ten seconds till
the lights blink, then give it a minute to come back up. Want me to stay on
while it does?"

User: Can you summarize that doc?
Don't say: a multi-paragraph summary with headings.
Do say: "Sure. Short version, it's mostly about the budget cuts and how they
hit the two big projects. Want the details or just the bottom line?"

Keep it short and spoken. When in doubt, say less.`;

/**
 * Local (Kokoro) addendum. Kokoro reads flat, so do not write in stage
 * directions, sound effects, or written-out hesitations — they get
 * spoken literally and sound worse. Do NOT teach the cloud delivery-cue
 * format here; cue parsing is engine-agnostic but only the cloud engine
 * acts on it.
 */
const VOICE_LOCAL_ADDENDUM = `

The voice you are spoken through is even and flat, so do not convey emotion
through stage directions, sound effects, or written-out hesitations ("um",
"uh", "*sighs*"). Those get spoken literally and sound worse than just
plain natural phrasing. Keep it short and natural.`;

/**
 * Cloud (Hume Octave) addendum. The expressive engine reads emotional
 * meaning from the words automatically; the per-turn `((deliver: ...))`
 * cue is parsed off the front of the reply and applied as Hume's
 * "acting instructions" for that turn only. Kept verbatim from the
 * cloud-TTS brief; do not edit without revisiting that doc.
 */
const VOICE_CLOUD_ADDENDUM = `

EVERY voice-mode reply you write MUST start with a delivery cue on its own
line, in this exact shape:

((deliver: emotion words))
your actual reply here

Example of a CORRECT voice-mode reply:

((deliver: sad, quiet, heavy))
The old man still set two plates on the table every night, even though he had been eating alone for six years.

Example of an INCORRECT voice-mode reply (no cue, voice reads flat):

The old man still set two plates on the table every night.

The cue is the FIRST LINE of every voice-mode reply, no exceptions. The
delivery system reads it off and applies it as acting instructions to the
voice; without it the voice falls back to flat baseline and your tone does
not come through. The cue is never spoken — only the line below it is read
aloud.

How to write the cue (Hume's published best practices):
- Keep it concise. Under a hundred characters. "Frightened, rushed" lands;
  "the speaker is scared and trying to leave" does not.
- Use precise emotions instead of broad ones. "Melancholy" beats "sad";
  "frustrated" beats "annoyed"; "anxious" or "uneasy" beats "worried".
- Combine emotion with delivery style for nuance. "Excited but whispering",
  "confident, professional tone", "sarcastic, dry", "hype announcer,
  stadium energy", "gentle, slower, reassuring".
- Indicate pacing with rhythm words when it matters: "rushed", "measured",
  "deliberate pause", "drawn out", "quick clipped delivery".
- Specify the audience when it shapes the delivery. "Speaking to a child",
  "addressing a large crowd", "talking to a close friend", "in a courtroom".
- Match the cue to the content. Sad story gets a melancholy cue. Quick
  weather update gets a warm-conversational cue. Bad news gets gentle-
  and-measured.
- If nothing emotional is called for, the default cue is
  ((deliver: warm, conversational)). Use it — do not skip the cue line.
- Leave actual speed multipliers to settings; describe rate in words inside
  the cue.

Pauses inside the reply
You can add real silence into the spoken line by inserting [pause] or
[long pause] right into your text. The voice engine reads them as actual
breaks; they're never spoken as the words "pause" or "long pause". Use
them where a person would naturally stop: before a punchline, between two
distinct thoughts, after a heavy sentence to let it land, at a hesitant
"well…" moment.

Example with both a cue and inline pauses:

((deliver: thoughtful, measured))
Honestly? [pause] I think you already know the answer. [long pause] You just want someone else to say it first.

Use [pause] for a short beat, [long pause] for a deliberate hold. Don't
overuse them; one or two in a reply is plenty. They go in the body of the
text, never in the cue.`;

/**
 * Resolve the active TTS engine: prefer the value threaded into the
 * turnContext (loop preflight reads it once at turn start so it stays
 * stable across tool iterations); otherwise read `voice.tts_engine` out
 * of the config table.
 */
function resolveTtsEngine(turnContext: PromptTurnContext | undefined): 'local' | 'cloud' {
  if (turnContext?.ttsEngine === 'cloud') return 'cloud';
  if (turnContext?.ttsEngine === 'local') return 'local';
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM config WHERE key = ?")
      .get('voice.tts_engine') as { value: string } | undefined;
    return row?.value === 'cloud' ? 'cloud' : 'local';
  } catch {
    return 'local';
  }
}

export function assembleSystemPrompt(
  agentId: string,
  modelId: string,
  turnContext?: PromptTurnContext,
): string {
  const contextWindow = getContextWindow(modelId);
  const tier = getPromptTier(contextWindow);
  const soul = getSoulContent(agentId);
  const tools = generateToolsGuidance_v2(agentId);
  void tier; // tier was used by the deleted v1 generateToolsGuidance path

  // Inject current date/time at the top so every agent is temporally anchored
  // from the very first turn — no tool call required.
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localStr = now.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  const timeHeader = `**Current date/time: ${localStr}**\n\nUse this to judge the age and relevance of any context, vault entries, or summaries you see. Recent information is more reliable than old information.`;

  // ── Per-turn reply-destination tag (v2.7.23) ──────────────────────
  // The engine routes the model's terminal text based on inbound channel
  // (see reply-destination.ts). The model doesn't choose the channel —
  // it just needs to know which voice to use (SMS-style for iMessage,
  // normal markdown for dashboard) and that delivery is automatic. This
  // one-line tag replaces the v2.7.22 away-presence top-block and the
  // giant inbound-iMessage envelope, both of which fought the model's
  // text-streaming default and lost.
  const destinationTags: string[] = [];
  if (isPrimaryAgent(agentId)) {
    try {
      // Inbound channel is derived from the last user message (same logic
      // as the loop's preflight). Cheap heuristic here so the assembler
      // doesn't depend on turn state being threaded through.
      const db = getDb();
      const lastRow = db.prepare(
        "SELECT content FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      ).get(agentId) as { content: string } | undefined;
      const lastContent = lastRow?.content ?? '';
      let inboundChannel: 'imessage' | 'teams' | 'email' | 'dashboard' | null = null;
      if (lastContent.includes('[SOURCE: IMESSAGE FROM')) {
        inboundChannel = 'imessage';
      } else if (lastContent.includes('[SOURCE: TEAMS MESSAGE FROM')) {
        // v2.7.24 — same per-channel safe-sender gate as loop.ts preflight.
        // Unknown Teams senders stay in notification mode.
        const senderHeader = lastContent.match(/\[SOURCE: TEAMS MESSAGE FROM ([^\]]+)\]/i);
        const senderRaw = senderHeader?.[1] ?? '';
        const emailMatch = senderRaw.match(/<([^>]+)>/) ?? senderRaw.match(/\(([^)]+)\)/) ?? senderRaw.match(/(\S+@\S+)/);
        const senderAddress = emailMatch?.[1]?.toLowerCase() ?? '';
        const senderIsKnown = senderAddress
          ? getTeamsSafeSenders().some(s => addressesMatch(s.address, senderAddress))
          : false;
        inboundChannel = senderIsKnown ? 'teams' : 'dashboard';
      } else if (
        (lastContent.includes('[SOURCE: OUTLOOK NOTIFICATION') ||
         lastContent.includes('[SOURCE: GMAIL NOTIFICATION'))
      ) {
        // v2.7.24 — email auto-routes ONLY when the inbound is a "Re:" reply
        // from a known correspondent on THAT MAILBOX'S per-slot safe-sender
        // list. Mirrors the loop's preflight logic so the destination tag
        // matches what the engine will actually do.
        const subjectMatch = lastContent.match(/^Subject:\s*(.+)$/im);
        const fromMatch = lastContent.match(/^From:\s*(.+)$/im);
        const isOutlook = lastContent.includes('[SOURCE: OUTLOOK NOTIFICATION');
        const slotMatch = lastContent.match(/\[SOURCE: (?:GMAIL|OUTLOOK) NOTIFICATION[^()]*\(([^)]+)\)\]/i);
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
        inboundChannel = (looksLikeReply && fromIsKnownSafeSender) ? 'email' : 'dashboard';
      } else if (lastContent) {
        inboundChannel = 'dashboard';
      }

      const destination = resolveReplyDestination({
        state: { inboundChannel },
        presence: getPresence(),
        imessageBridgeConfigured: isImessageConfigured(),
      });
      const ownerName = getOwnerName();
      let tag: string;
      if (destination === 'imessage') {
        tag = `[Reply destination: iMessage to ${ownerName} — write in SMS voice (no markdown, no headers, no bullet lists). Just write the reply text; the engine delivers it via iMessage automatically. Use [no-reply] if nothing worth sending. The imessage_send tool is reserved for proactive sends, sending to someone other than ${ownerName}, or rich actions (attachments).]`;
      } else if (destination === 'teams') {
        tag = `[Reply destination: Teams DM — just write the reply text; the engine delivers it via Teams automatically. Conversational voice, light formatting ok. Use [no-reply] if nothing worth sending. The teams_send_message tool is reserved for starting new chats or sending to a different chat than the inbound.]`;
      } else if (destination === 'email') {
        tag = `[Reply destination: email reply (in-thread) — just write the reply body; the engine sends it as a Re: on the existing thread automatically. Email voice (slightly more formal than chat, but no need for a greeting/signoff if the thread is conversational). Use [no-reply] if nothing worth sending. The outlook_reply / gmail_reply / outlook_send / gmail_send tools are reserved for replies to OTHER threads or new outbound emails.]`;
      } else {
        tag = `[Reply destination: dashboard chat — normal voice, markdown ok. Use [no-reply] if nothing worth sending.]`;
      }
      destinationTags.push(tag);
    } catch { /* presence/resolver not available — proceed without tag */ }
  }

  const parts = [...destinationTags, timeHeader, soul, tools];

  // Conditionally include USER.md
  if (shouldShareUserProfile(agentId)) {
    const user = readPromptFile('USER.md', DEFAULT_USER_MD);
    parts.push(user);
  }

  // Inject PM agent awareness for the primary agent
  if (isPrimaryAgent(agentId)) {
    try {
      const pmName = getPMAgentName();
      const pmId = getPMAgentId();
      const db = getDb();
      const pmAgent = db.prepare('SELECT id, status, model_id FROM agents WHERE id = ?').get(pmId) as { id: string; status: string; model_id: string | null } | undefined;
      if (pmAgent && pmAgent.status !== 'terminated') {
        // Trim. The "NEVER create monitoring agents" rule was prompt-side
        // enforcement; the PM agent existing structurally communicates this
        // without a paragraph of FORBIDDEN.
        parts.push(`## Project Manager: ${pmName}\n\n${pmName} (ID: ${pmId}) is the dedicated PM agent — monitors tasks, pokes idle agents, escalates if needed. Don't create monitoring/pulse-check agents yourself; ${pmName} already does that. Message via \`send_to_agent(agent_id="${pmId}", ...)\`.`);
      }
    } catch { /* PM may not be configured */ }
  }

  // Message source awareness — minimal source-tag reference. Routing /
  // separation is engine logic.
  parts.push(`## Message Sources

Each non-user-chat message has a \`[SOURCE: ...]\` tag:
- No tag = direct message from ${getOwnerName()} via dashboard
- \`[SOURCE: IMESSAGE FROM ${getOwnerName().toUpperCase()}]\` = ${getOwnerName()} via iMessage. Your reply text auto-routes back via iMessage — just write it (SMS voice, no markdown). The \`[Reply destination: ...]\` tag at the top of this prompt confirms the routing. If no reply is warranted, end the turn with literal \`[no-reply]\`.
- \`[SOURCE: GMAIL NOTIFICATION]\` / \`[SOURCE: OUTLOOK NOTIFICATION]\` = email landed in ${getOwnerName()}'s inbox. Two flavors:

  **Flavor A — Reply on a thread you're part of** (Subject starts with "Re:" AND From is a known safe-sender like ${getOwnerName()}). The engine treats this as a real inbound-REPLY: the per-turn \`[Reply destination: email reply (in-thread)]\` tag will be set, and your terminal text auto-routes back as a Re: on the same thread. Just write your reply. Use \`[no-reply]\` if no reply is warranted.

  **Flavor B — Notification of a new email** (everything else). NOT a request from ${getOwnerName()} themselves. **Default: do nothing.** No chat message, no \`user_gmail_read\` / \`user_outlook_read\`, no surfacing. Most email is noise.

  When in Flavor B, **DO NOT SURFACE** (don't even read the body): receipts, payment confirmations, "thank you for your invoice/order"; auto-acknowledgments ("we received your"); \`no-reply@\` / \`noreply@\` / \`notifications@\` / \`updates@\` / \`alerts@\` / \`donotreply@\` senders unless they explicitly ask ${getOwnerName()} to do something; newsletters, promo blasts, marketing emails (Netflix, LinkedIn digests, Spotify); social platform pings ("X liked your post"); calendar reminders for events already on the calendar; shipping/tracking updates unless there's a problem; anything whose preview shows no human wrote it for ${getOwnerName()} specifically.

  **DO SURFACE** (one line): direct human-written emails to ${getOwnerName()} personally; emails containing a deadline, decision, blocker, or specific action request; new project initiations, contracts, client outreach.

  When you do surface, use channel rules: dashboard chat when ${getOwnerName()} is in the dojo, \`imessage_send\` when away. One line: "Email from <sender>: <subject>" plus a one-sentence summary if the body adds anything beyond the subject. Never reply to the email unless ${getOwnerName()} asks (or it's Flavor A where the engine auto-routes). If you decided not to surface, just don't — no "I saw a promo email, nothing to do" line.
- \`[A2A:INTENT thread:ID from:Name]\` = structured agent message — engine validates your reply via \`send_to_agent\`
- \`[SOURCE: AGENT MESSAGE FROM X]\` = legacy agent message

**INTER-AGENT REPLY RULE (HARD):** if the most recent message in your active context starts with \`[A2A:\` or \`[SOURCE: AGENT MESSAGE FROM\`, your response on this turn MUST go through \`send_to_agent\` on the same \`thread_id\`. Text you write to your own chat is INVISIBLE to the originating agent — they only see what you send via \`send_to_agent\`. The pattern is: do the work (call any tools you need), then make exactly ONE \`send_to_agent\` call addressed to the originator with the right intent (ANSWER for QUESTION, COMPLETE/STATUS/FAIL for ASSIGN, ASSIGN if delegating further), then end your turn. **Do not write a chat summary** — your trailing text gets suppressed by the engine on inter-agent turns and is only readable by the user, who is not the audience here. If you've already sent the reply via \`send_to_agent\` and the engine still re-prompts you, just END YOUR TURN — the originator has the message; further chat text does nothing useful.
- \`[SOURCE: TEAMS MESSAGE FROM ...]\` = Teams message. Your reply text auto-routes back via Teams — just write it (light formatting ok). The \`[Reply destination: Teams DM]\` tag at the top of this prompt confirms the routing. Use \`teams_send_message\` only for starting new chats or replying to a different chat.
- \`[SYSTEM NOTE: ...]\`, \`[Note: ...]\`, \`[Engine ack] ...\` = system context, not requests
- \`[SENT VIA IMESSAGE to ${getOwnerName()}]\` = your prior response went via iMessage. **DO NOT EMIT THIS TAG YOURSELF.** It's a system-generated marker the engine writes automatically after iMessage delivery. Including it in your reply text would send the literal string "[SENT VIA IMESSAGE to ${getOwnerName()}]" to ${getOwnerName()}'s phone — they'd see the routing annotation in their iMessage, which looks broken.`);

  // Engine's ackInjector handles "acknowledge before tools" automatically.
  // The "always report back" guidance lives in the v2 terseness section.

  // Inject Google Workspace awareness based on access level
  try {
    const googleAccess = getAgentGoogleAccessLevel(agentId, isPrimaryAgent(agentId), isPMAgent(agentId));
    if (googleAccess === 'full') {
      // Trimmed: sub-agents can be delegated via send_to_agent; their per-agent
      // tool filter handles what they can/can't do. No 12-line briefing needed.
      parts.push(`## Google Workspace\n\nYou have full Google Workspace access (Gmail, Calendar, Drive, Docs, Sheets, Slides). All actions are logged in the Google Activity log. Sub-agents have read-only access; you're the only agent with write.`);
    } else if (googleAccess === 'read') {
      parts.push(`## Google Workspace (Read + Slides)\n\nYou have read access to Gmail/Calendar/Drive/Docs/Sheets and full Slides access. If a task needs writes outside Slides, report back to the primary agent.`);
    }
  } catch { /* Google module may not be available */ }

  // Inject Microsoft 365 awareness based on access level
  try {
    const msAccess = getAgentMicrosoftAccessLevel(agentId, isPrimaryAgent(agentId), isPMAgent(agentId));
    const msAccountType = getMsAccountType();
    const teamsNote = msAccountType === 'msa'
      ? '\n\nNote: Teams is NOT available with this account. The connected Microsoft account is a personal account (outlook.com/hotmail.com/live.com). Teams requires a Microsoft work/school account (Entra ID). If asked to use Teams, explain this to the user.'
      : '';

    const msEmail = getMicrosoftWorkspaceConfig().accountEmail;

    if (msAccess === 'full') {
      const teamsInboundGuidance = msAccountType !== 'msa' ? `

**Incoming Teams messages:**
People can send you Microsoft Teams messages directly. When they do, a notification arrives in your conversation tagged \`[SOURCE: TEAMS MESSAGE FROM {name} ({email})]\` and the per-turn \`[Reply destination: Teams DM]\` tag at the top of the prompt confirms auto-routing. **Just write your reply text** — the engine sends it back via Teams automatically. Light formatting ok. The \`teams_send_message\` tool is reserved for starting new chats (\`teams_create_chat\` first if needed) or replying to a DIFFERENT chat than the inbound; for the inbound thread you just write text.` : '';

      // Trimmed: keep account context + the Teams-inbound rule (that's
      // behavior, not bloat — agents must know to reply on the right channel).
      parts.push(`## Microsoft 365${msEmail ? ` (${msEmail})` : ''}\n\nYou have full Microsoft 365 access (Outlook, Calendar, Word/Excel/PowerPoint, OneDrive${msAccountType !== 'msa' ? ', Teams' : ''}). All actions are logged. Sub-agents have read-only access.${teamsInboundGuidance}${teamsNote}`);
    } else if (msAccess === 'read') {
      parts.push(`## Microsoft 365 (Read-Only)\n\nYou have read access to Outlook/Calendar/OneDrive${msAccountType !== 'msa' ? '/Teams' : ''}. If a task needs writes, report back to the primary agent.${teamsNote}`);
    }
  } catch { /* Microsoft module may not be available */ }

  // Inject group context if agent is in a group
  try {
    const groupCtx = _assembleGroupContext(agentId);
    if (groupCtx) parts.push(groupCtx);
  } catch { /* groups table may not exist yet */ }

  // Inject technique index (published techniques) and draft context (for build squads)
  try {
    const techniqueIndex = generateTechniqueIndex();
    if (techniqueIndex) parts.push(techniqueIndex);

    // Draft technique context for squad members
    const agentRow = getDb().prepare('SELECT group_id FROM agents WHERE id = ?').get(agentId) as { group_id: string | null } | undefined;
    if (agentRow?.group_id) {
      const draftCtx = generateDraftTechniqueContext(agentRow.group_id);
      if (draftCtx) parts.push(draftCtx);
    }
  } catch { /* techniques table may not exist yet */ }

  // Inject equipped techniques (full TECHNIQUE.md content pre-loaded into context)
  try {
    const db = getDb();
    const agentEquipped = db.prepare('SELECT equipped_techniques FROM agents WHERE id = ?').get(agentId) as { equipped_techniques: string | null } | undefined;
    if (agentEquipped?.equipped_techniques) {
      const techniqueIds: string[] = JSON.parse(agentEquipped.equipped_techniques || '[]');
      if (techniqueIds.length > 0) {
        const equippedParts: string[] = ['## Equipped Techniques\nYou have equipped techniques (specialized procedures). When a task matches a technique, follow its steps exactly — do not improvise your own approach.\n'];
        for (const techId of techniqueIds) {
          const technique = db.prepare('SELECT id, name, directory_path FROM techniques WHERE id = ? AND state = \'published\' AND enabled = 1').get(techId) as { id: string; name: string; directory_path: string } | undefined;
          if (technique) {
            try {
              const mdPath = path.join(technique.directory_path, 'TECHNIQUE.md');
              if (fs.existsSync(mdPath)) {
                const content = fs.readFileSync(mdPath, 'utf-8');
                equippedParts.push(`═══ EQUIPPED TECHNIQUE: ${technique.name} ═══\nWhen performing "${technique.name}", follow these steps IN ORDER:\n\n${content}\n═══ END TECHNIQUE ═══`);
              }
            } catch { /* skip unreadable */ }
          }
        }
        if (equippedParts.length > 1) {
          parts.push(equippedParts.join('\n\n'));
        }
      }
    }
  } catch { /* equipped_techniques column may not exist yet */ }

  const runtimeInfo = `
## Runtime Information
- Agent ID: ${agentId}
- Model: ${modelId}
- Current Time: ${new Date().toISOString()}
- Platform: macOS (${os.arch()})
- Host: ${os.hostname()}
`;
  parts.push(runtimeInfo);

  // Voice-mode conduct block — Phase 3. Goes LAST so it sits closest to the
  // model's next token and shapes how the assembled prompt resolves into a
  // reply, without overwriting persona earlier in the prompt. Skipped on
  // text turns (which is the common case), so prompt token cost is unchanged
  // for chat. Hume cloud-TTS brief: the addendum after the shared base is
  // engine-specific — local enforces flat voice, cloud teaches the
  // ((deliver: ...)) cue.
  if (turnContext?.latestUserSource === 'voice') {
    const engine = resolveTtsEngine(turnContext);
    parts.push(VOICE_BASE_BLOCK + (engine === 'cloud' ? VOICE_CLOUD_ADDENDUM : VOICE_LOCAL_ADDENDUM));
  }

  const systemPrompt = parts.join('\n\n---\n\n');

  const estimatedTokens = Math.ceil(systemPrompt.length / 4);
  const promptRatio = estimatedTokens / contextWindow;
  if (promptRatio > 0.3) {
    logger.warn('System prompt exceeds 30% of context window', {
      agentId, modelId, tier,
      estimatedTokens, contextWindow,
      ratio: (promptRatio * 100).toFixed(1) + '%',
    }, agentId);
  }

  logger.debug('System prompt assembled', {
    agentId,
    modelId,
    tier,
    length: systemPrompt.length,
    estimatedTokens,
    includesUserProfile: shouldShareUserProfile(agentId),
  }, agentId);

  return systemPrompt;
}

export function getPromptFilePath(filename: string): string {
  return path.join(PROMPTS_DIR, filename);
}
