import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SOUL_MD, DEFAULT_USER_MD, DEFAULT_PM_SOUL_MD, DEFAULT_TRAINER_SOUL_MD } from './templates.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { toolDefinitions } from '../agent/tools/definitions.js';
import { getFilteredTools } from '../agent/tools/surface.js';
import { getAgentPermissions } from '../agent/manifest.js';
import { isPrimaryAgent, isPMAgent, isTrainerAgent, getPrimaryAgentName, getPrimaryAgentId, getPMAgentName, getPMAgentId, getOwnerName, getTrainerAgentId, getTrainerAgentName, isTrainerEnabled, getHealerAgentId, getHealerAgentName } from '../config/platform.js';
import type { TurnCounterparty } from '../agent/v2/counterparty.js';
import { NO_REPLY_CLOSED_MARKER, WORKING_NOTE_PREFIX, INTERNAL_WORKING_NOTE_PREFIX, type Channel } from '@dojo/shared';
import { isWorkVerb } from '../tools/work-verbs.js';
import { getAgentGoogleAccessLevel, getGoogleWorkspaceConfig, isGoogleConnected, isEmailMonitoringEnabled, isEmailSendingEnabled } from '../google/auth.js';
import { getAgentMicrosoftAccessLevel, getMsAccountType, getMicrosoftWorkspaceConfig, isMicrosoftConnected, isMsEmailMonitoringEnabled, isMsEmailSendingEnabled } from '../microsoft/auth.js';
import { getChannelCapabilities, listIntegrationStatuses } from '../services/capability-registry.js';
import { assembleGroupContext as _assembleGroupContext } from '../agent/groups.js';
import { generateTechniqueIndex, generateDraftTechniqueContext } from '../techniques/index-builder.js';
import { getContextWindow } from '../agent/model.js';
import { getModelCapabilities } from '../services/capabilities.js';
import { getEffectiveVisionModel } from '../services/vision-model.js';
import { isIMBridgeRunning } from '../services/imessage-bridge.js';
import { getPresence, isImessageConfigured } from '../services/presence.js';
import { resolveReplyDestination, type ReplyDestination } from '../agent/v2/reply-destination.js';
import { resolveInbound } from '../agent/v2/inbound-channel.js';
import { getTwilioConfig } from '../twilio/auth.js';

// (The v1 per-model prompt-tier scaler was deleted with remediation Phase 3:
// its consumer died with v1 generateToolsGuidance, and the design law says
// one contract for every model, curation tightness, not forked verbosity.)
import { generateToolIndex } from '../tools/categories.js';
import { getAgentAlwaysLoadedTools } from '../tools/tool-docs.js';
// (getRuntimeVersion import removed in Phase 9 Stage 2, single-track v2)

const logger = createLogger('prompt-assembler');
const PROMPTS_DIR = path.join(os.homedir(), '.dojo', 'prompts');
const __assemblerDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * THE SHIPPED TEMPLATES DIRECTORY, IN BOTH LAYOUTS WE ACTUALLY SHIP (W24).
 *
 * `deploy/build-package.sh:70-71` copies `templates/*.md` to `<payload>/platform/templates`,
 * and `deploy/install.sh:11-12` rsyncs `<payload>/platform/` to `~/.dojo/platform`. The
 * server's own code lands at `platform/packages/server/dist/**`, which is the same depth
 * below the root as `packages/server/src/**` is in the repo — so ONE relative hop resolves
 * both, and the absolute installed path is listed after it as the belt to that braces.
 *
 * Exported so a test can assert the packaged layout is covered without a package build.
 */
export function platformTemplateSearchPaths(file: string): string[] {
  return [
    // repo:      <root>/templates/<file>   ·   package: ~/.dojo/platform/templates/<file>
    path.resolve(__assemblerDir, '../../../../templates', file),
    path.resolve(__assemblerDir, '../../../templates', file),
    path.join(os.homedir(), '.dojo', 'platform', 'templates', file),
  ];
}

/** The shipped template's bytes, or null when this box has no templates directory at all. */
export function readPlatformTemplate(file: string): string | null {
  for (const p of platformTemplateSearchPaths(file)) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    } catch {
      // try the next layout
    }
  }
  return null;
}

/** The names every shipped soul template is written against. */
function substitutePlatformNames(md: string): string {
  return md
    .replace(/\{\{pm_agent_name\}\}/g, getPMAgentName())
    .replace(/\{\{trainer_agent_name\}\}/g, getTrainerAgentName())
    .replace(/\{\{primary_agent_name\}\}/g, getPrimaryAgentName())
    .replace(/\{\{owner_name\}\}/g, getOwnerName());
}

/** A stored soul that still carries one of those placeholders was written by the engine's own
 *  default-seeding and never passed through a substituting writer. Nobody authors this. */
export const UNSUBSTITUTED = /\{\{(?:pm_agent_name|trainer_agent_name|primary_agent_name|owner_name)\}\}/;

/**
 * A shipped soul template, substituted — with the in-code stub as the LAST RESORT ONLY, and
 * loud when it engages.
 *
 * W24 wrote this for the project manager; W25 lifted it to serve any platform soul, because
 * `~/.dojo/prompts/TRAINER-SOUL.md` had the identical defect (3,023 stored bytes carrying a
 * literal `{{trainer_agent_name}}`, against an 8,074-byte shipped template that reached no
 * model on any box). The stub is substituted too: an unsubstituted fallback is the same
 * defect in a smaller hat.
 *
 * `read`/`warn` are injected so the last-resort path is testable without deleting the repo's
 * templates directory.
 */
function shippedSoulDefaultFrom(
  file: string,
  stub: string,
  whatIsLost: string,
  read: (file: string) => string | null,
  warn: (msg: string, meta?: Record<string, unknown>) => void,
): string {
  const shipped = read(file);
  if (shipped) return substitutePlatformNames(shipped);
  // LOUD, by instruction: the whole reason this code exists is that the condition was
  // silent for months on every box that had ever booted once.
  warn(
    `${file} was not found in ANY templates directory — this agent is falling back to the `
      + `in-code stub, which is a fraction of its doctrine (${whatIsLost}). Check the platform install.`,
    { searched: platformTemplateSearchPaths(file) },
  );
  return substitutePlatformNames(stub);
}

/**
 * THE PROJECT MANAGER'S SHIPPED DOCTRINE — the seed `~/.dojo/prompts/PM-SOUL.md` is written
 * from, and the bytes the model reads until an owner edits them (W24).
 *
 * Injected `read`/`warn` so the last-resort path is testable without deleting the repo's
 * templates directory.
 */
export function pmSoulDefaultFrom(
  read: (file: string) => string | null,
  warn: (msg: string, meta?: Record<string, unknown>) => void,
): string {
  return shippedSoulDefaultFrom(
    'PM-SOUL.md', DEFAULT_PM_SOUL_MD,
    'no skepticism block, no dereference rule, no issue-type verb table',
    read, warn,
  );
}

/**
 * W25 — THE TRAINER HAS THE IDENTICAL DEFECT, and this is the same door.
 *
 * Measured on the dev box before the fix: `~/.dojo/prompts/TRAINER-SOUL.md` was 3,023 bytes
 * dated Jun 1, carrying a literal `{{trainer_agent_name}}`, while the shipped
 * `templates/TRAINER-SOUL.md` is 8,074 bytes. Everything the stub is missing — the
 * technique-authoring craft, the placeholder discipline, the import protocol — reached no
 * model on any box.
 */
export function trainerSoulDefaultFrom(
  read: (file: string) => string | null,
  warn: (msg: string, meta?: Record<string, unknown>) => void,
): string {
  return shippedSoulDefaultFrom(
    'TRAINER-SOUL.md', DEFAULT_TRAINER_SOUL_MD,
    'a fraction of the technique-authoring craft it is supposed to teach',
    read, warn,
  );
}

function pmSoulDefault(): string {
  return pmSoulDefaultFrom(readPlatformTemplate, (msg, meta) => logger.error(msg, meta));
}

function trainerSoulDefault(): string {
  return trainerSoulDefaultFrom(readPlatformTemplate, (msg, meta) => logger.error(msg, meta));
}

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

// Extract a single markdown section body by its header text (e.g. 'Rules'),
// from the first `# Header` / `## Header` to the next same-or-higher header.
// Used to carry the owner's standing `# Rules` from SOUL.md into sub-agents
// without dragging the primary's identity along. Returns '' if not found.
export function extractMarkdownSection(markdown: string, header: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^#{1,3}\s+/.test(l) && l.replace(/^#{1,3}\s+/, '').trim().toLowerCase() === header.toLowerCase());
  if (start === -1) return '';
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3}\s+/.test(lines[i])) break; // next header ends the section
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

/**
 * The prompt FILE that holds an agent's stored identity, when one does.
 *
 * ⚠ ONE OWNER (UX-REPAIR T40). The runtime reads the identity through `getSoulContent`
 * below; the Settings card reads and WRITES it through `prompt/agent-prompt-surface.ts`.
 * Before T40 those were different stores: the card served
 * `SELECT content FROM messages WHERE role='system' ORDER BY rowid ASC LIMIT 1` — first-row
 * archaeology over a history the PM prune deletes from the front — while the model got this
 * file. On a worn-in box the oldest surviving system row is an ENGINE MARKER, so the owner's
 * card showed `[Agent ended turn without replying — conversation closed]` as his project
 * manager's whole soul, and an edit typed into that box reached nothing the model reads.
 * Both surfaces resolve the store HERE now, so they cannot disagree again.
 */
export interface AgentSoulFile {
  /** File name inside `~/.dojo/prompts`. */
  readonly file: string;
  /** The default written on first read; empty for a per-agent file, which must already exist. */
  readonly fallback: string;
  /** Whether the spawn-capability truth pass applies to this file's content. */
  readonly spawnTruth: boolean;
  /**
   * W24: when the STORED file still carries `{{…}}`, treat it as an engine-written default
   * rather than an authored identity and re-seed it from `fallback`. Same door as the
   * first-read seeding right below — a seed that landed WRONG is still the seed's business —
   * and it is the only thing that reaches a box where the stub already sits on disk.
   */
  readonly reseedUnsubstituted?: boolean;
}

export function soulFileForAgent(agentId: string): AgentSoulFile | null {
  if (isPrimaryAgent(agentId)) return { file: 'SOUL.md', fallback: DEFAULT_SOUL_MD, spawnTruth: true };
  if (isPMAgent(agentId)) return { file: 'PM-SOUL.md', fallback: pmSoulDefault(), spawnTruth: false, reseedUnsubstituted: true };
  if (isTrainerAgent(agentId)) return { file: 'TRAINER-SOUL.md', fallback: trainerSoulDefault(), spawnTruth: false, reseedUnsubstituted: true };
  const perAgent = `${agentId.toUpperCase()}-SOUL.md`;
  if (fs.existsSync(path.join(PROMPTS_DIR, perAgent))) return { file: perAgent, fallback: '', spawnTruth: true };
  return null;
}

/** Read a soul file's STORED bytes — what an editor edits, before any truth pass. */
export function readSoulFile(soul: AgentSoulFile): string {
  if (!soul.fallback) return fs.readFileSync(path.join(PROMPTS_DIR, soul.file), 'utf-8');
  const stored = readPromptFile(soul.file, soul.fallback);
  // W24 — THE WORN-IN BOX. `readPromptFile` seeds only when the file is ABSENT, so every box
  // that ever booted the old code has the stub sitting on disk and would keep it forever. A
  // stored soul containing `{{pm_agent_name}}` was written by that seeding and read by nothing
  // that substitutes: it is not an owner's words, and it is not even coherent text to a model.
  // An owner-authored soul has no placeholders in it, so it is never touched by this.
  if (soul.reseedUnsubstituted && UNSUBSTITUTED.test(stored)) {
    logger.warn('stored soul still carried unsubstituted template placeholders — re-seeding it from the shipped template', {
      file: soul.file, storedChars: stored.length, seedChars: soul.fallback.length,
    });
    writeSoulFile(soul, soul.fallback);
    return soul.fallback;
  }
  return stored;
}

/** Write a soul file's stored bytes. The one write door for every identity that lives in a file. */
export function writeSoulFile(soul: AgentSoulFile, content: string): void {
  ensurePromptsDir();
  fs.writeFileSync(path.join(PROMPTS_DIR, soul.file), content, 'utf-8');
}

/**
 * A sub-agent's STORED charter: the durable column (migration 096), or — for agents spawned
 * before that column existed — the earliest `role='system'` row that is not an engine
 * coordination row.
 *
 * T40 adds `NO_REPLY_CLOSED_MARKER` to that refusal, by parameter rather than by a second
 * copy of the literal. The marker is written as a `role='system'` row by the engine, and on
 * a legacy agent whose charter column is NULL it could stand in as the identity — the same
 * class of defect as the card's, one layer down. An engine marker is never an identity.
 *
 * UX-REPAIR T57 adds the WORKING NOTE to the same table, on the same argument and by the same
 * parameter discipline. W25 measured it on the owner's box: the Healer's `charter` is NULL and
 * its soul row had been pruned, so the earliest surviving `role='system'` row was 88 bytes of
 * `[working-note] Two issues to address…` — and that note was the Healer's whole identity, on
 * the runtime surface and on the Settings card alike. A working note is engine-authored by
 * construction: the engine WRAPS the model's mid-turn narration in this prefix
 * (`post-call-classify/closeout-floors.ts`, `terminal-text.ts`) and stores it `role='system'`
 * so it can never re-enter model context. Nobody authors an identity beginning with it.
 *
 * Prefix match, not substring: doctrine that MENTIONS the marker (a soul telling its agent how
 * the engine demotes narration) is a legitimate identity and still passes.
 */
export function readStoredCharter(agentId: string): string {
  const db = getDb();
  const row = db.prepare('SELECT charter FROM agents WHERE id = ?').get(agentId) as
    | { charter: string | null }
    | undefined;
  const declared = (row?.charter ?? '').trim();
  if (declared) return declared;
  try {
    const charterRow = db.prepare(
      "SELECT content FROM messages WHERE agent_id = ? AND role = 'system' " +
        "AND content NOT LIKE '[SOURCE:%' AND content NOT LIKE '[System:%' AND content NOT LIKE '──%' " +
        'AND content NOT LIKE ? AND content NOT LIKE ? ' +
        'AND TRIM(content) <> ? ' +
        'ORDER BY rowid ASC LIMIT 1',
    ).get(
      agentId,
      `${WORKING_NOTE_PREFIX}%`,
      `${INTERNAL_WORKING_NOTE_PREFIX}%`,
      NO_REPLY_CLOSED_MARKER,
    ) as { content: string } | undefined;
    return charterRow?.content?.trim() ?? '';
  } catch {
    return '';
  }
}

export function getSoulContent(agentId: string): string {
  // Primary / PM / Trainer / per-agent souls all live in a file (see `soulFileForAgent`).
  const soulFile = soulFileForAgent(agentId);
  if (soulFile) {
    try {
      const stored = readSoulFile(soulFile);
      // The reachable half of the SOUL claim: a per-agent soul file is the one
      // way the default SOUL's `## Capabilities` list lands on an agent that is
      // not the primary, and such an agent runs on the sub-agent manifest.
      return soulFile.spawnTruth ? applySpawnCapabilityTruth(stored, agentId) : stored;
    } catch {
      // Fall through
    }
  }

  // Sub-agents: comprehensive dojo onboarding, NOT the primary agent's SOUL.md
  try {
    const db = getDb();
    const agentRow = db.prepare('SELECT name, group_id, parent_agent, classification, charter FROM agents WHERE id = ?').get(agentId) as { name: string; group_id: string | null; parent_agent: string | null; classification: string; charter: string | null } | undefined;
    const agentName = agentRow?.name ?? 'Agent';
    const classification = agentRow?.classification ?? 'apprentice';

    // Created (POST /api/agents) AND spawned sub-agents persist their creator-
    // provided charter (identity + task instructions). Nothing structural read
    // it into the system prompt: the synthesized identity below carries only
    // STRUCTURAL context (name, parent, squad, reporting rules), so a created
    // agent's actual persona and instructions (a worker's codeword, its "reply
    // only when asked" rule, whatever the creator wrote) had mere user-message
    // authority. On an A2A turn the human-role charter row is scoped out of the
    // tail entirely, so the agent went BLIND to its own charter and spun
    // (vault_search x N for a codeword that was in its charter all along;
    // behav-sig:ca67b479). Give the charter a REAL system-prompt slot: lead the
    // identity with it, then append the dojo structural context + reporting
    // rules as framing.
    //
    // FA-PT6: the charter is now persisted DURABLY in agents.charter (migration
    // 096), written at spawn / create / prompt-update time, and read directly
    // here, so a terse or bracket-prefixed charter ("[Mission] ...") is never
    // false-rejected and a preceding non-charter system row can never latch. For
    // agents spawned BEFORE the column existed (charter IS NULL) we fall back to
    // a tightened sniff: the earliest role='system' row that is NOT an
    // engine-coordination marker. The old sniff dropped short and '['-prefixed
    // charters (length>20 AND not startsWith('['/'──')); that false-reject is
    // gone. We still reject engine-coordination rows by their exact prefixes so
    // one can never stand in for a charter: '[SOURCE:' (source-tagged engine
    // events), '[System:' (session-reset reorient prompts), and '──' (chat
    // dividers / reauth notices). A creator charter like '[Mission] ...' does
    // not match any of these and passes. Agents whose charter lives in a
    // <ID>-SOUL.md file are handled by the file branch above.
    //
    // T40 moved the statement itself into `readStoredCharter` (above) — one owner, shared
    // with the Settings card, and with the silent-turn close marker added to the refusal.
    const charter = readStoredCharter(agentId);

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
        const members = db.prepare("SELECT name, id FROM agents WHERE group_id = ? AND status != 'terminated' AND id != ? ORDER BY name, id").all(agentRow.group_id, agentId) as Array<{ name: string; id: string }>;
        groupInfo = `You are in the squad **"${group.name}"**${group.description ? `, ${group.description}` : ''}.`;
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

    // Owner standing rules (remediation C10 / Flow 7): a sub-agent runs a
    // SYNTHESIZED identity, not SOUL.md, so the owner's standing behavioral
    // rules (tone, no-prompt-modification, destructive caution, tracker-first)
    // never reached spawned agents. Carry the owner's `# Rules` section
    // through, framed as subordinate to the sub-agent's own reporting rules.
    // We do NOT hand over the primary's identity, only the universal rules.
    let ownerRules = '';
    try {
      const soul = readPromptFile('SOUL.md', DEFAULT_SOUL_MD);
      const rules = extractMarkdownSection(soul, 'Rules');
      if (rules) {
        ownerRules = `\n\n# Owner's standing rules (apply to every agent acting on the owner's behalf)\n\n${rules}\n\n(Your reporting rules above still govern when YOU speak; the engine, not these lines, enforces destructive-action approval for sub-agents.)`;
      }
    } catch { /* SOUL unavailable: sub-agent runs on its own rules only */ }

    // The "Communication" how-to and "Vault" instructional blocks are NOT
    // here, engine enforces A2A intent rules and prefetches vault context
    // at session start, so the prompt only carries structural identity /
    // parent / squad context.
    const identityBlock = charter
      ? `${charter}${parentInfo ? `\n\n${parentInfo}` : ''}`
      : `# Identity

You are **${agentName}**, a ${classification} agent in the DOJO Agent Platform. Your agent ID is \`${agentId}\`.

${parentInfo}`;

    return `${identityBlock}

# The Dojo

You are part of an AI agent orchestration platform.

- **${primaryName}** (ID: ${primaryId}) is the Dojo Master, primary agent who coordinates work. Reach them via \`send_to_agent\` only when you have something they actually need (an answer they asked for, a blocker, a deliverable). Don't send status updates or completion announcements; the tracker already shows status.
- **${pmName}** (ID: ${pmId}) is the Dojo Planner, PM agent monitoring the tracker. Message them only if blocked.
${groupInfo ? `- ${groupInfo}` : ''}

# Rules

- Follow your task instructions precisely.
- Update your tracker task status as you work; call \`complete_task\` when done. The \`summary\` field is read internally by the parent agent, that IS your report; do not write a parallel chat message announcing completion.
- If blocked, set tracker status to "blocked" and message ${primaryName} or ${pmName}.
- Silence is the default. Don't narrate, acknowledge, or close out actions you took. The completion is evident from the tracker and from what changed.
- These reporting rules are YOUR authority on when to speak. If any general guidance elsewhere in this prompt pulls toward surfacing progress or reporting back, these rules win for you as a sub-agent.${ownerRules}`;
  } catch {
    return '# Identity\n\nYou are a sub-agent in the DOJO Agent Platform. Follow your task instructions and call complete_task when done.';
  }
}

/**
 * Parse the structured phone-mode trailer that `CallSession` writes
 * into each inbound utterance message. The trailer carries the
 * direction, voicemail flag, disclosure requirements, and per-call
 * slots (their name, purpose, callback number) that drive the
 * conditional sections of the phone prompt block.
 *
 * Resilient to missing fields, anything absent comes back as
 * default (`null` / `false` / `[]`). Order-independent.
 */
interface PhoneCallContext {
  direction: 'inbound' | 'outbound';
  voicemailDetected: boolean;
  disclosuresRequired: string[];
  theirName: string | null;
  purpose: string | null;
  callbackNumber: string | null;
}
function parsePhoneCallContext(content: string): PhoneCallContext {
  const pick = (re: RegExp): string | null => {
    const m = content.match(re);
    return m?.[1]?.trim() || null;
  };
  const directionRaw = pick(/^Direction:\s*(\S+)/m);
  const voicemailRaw = pick(/^Voicemail:\s*(\S+)/m);
  const disclosuresRaw = pick(/^Disclosures:\s*([^\n]*)/m) ?? '';
  return {
    direction: directionRaw === 'outbound' ? 'outbound' : 'inbound',
    voicemailDetected: voicemailRaw === 'true',
    disclosuresRequired: disclosuresRaw
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0),
    theirName: pick(/^Their Name:\s*([^\n]*)/m),
    purpose: pick(/^Purpose:\s*([^\n]*)/m),
    callbackNumber: pick(/^Callback:\s*([^\n]*)/m),
  };
}

// True when the most recent user message for this agent is an incoming
// iMessage (carries the [SOURCE: IMESSAGE FROM ...] tag). Used to scope
// iMessage-only prompt guidance so dashboard turns don't pay the tokens.
function isIMessageTurn(agentId: string): boolean {
  try {
    const db = getDb();
    // v2.9.15: same channel-detection predicate as the loop's
    // preflight - skip A2A and synthetic-system rows so this query
    // sees the actual user-channel inbound for the turn.
    const row = db.prepare(
      `SELECT content FROM messages
       WHERE agent_id = ?
         AND role = 'user'
         AND content NOT LIKE '[SOURCE: SYSTEM%'
         AND content NOT LIKE '[A2A:%'
         AND content NOT LIKE '[SOURCE: AGENT MESSAGE FROM%'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    ).get(agentId) as { content: string } | undefined;
    return !!row?.content?.includes('[SOURCE: IMESSAGE FROM');
  } catch {
    return false;
  }
}

export function generateToolsGuidance_v2(agentId: string): string {
  const agentTools = getFilteredTools(agentId);
  const lines: string[] = [];

  // 1. "Silent turns are first-class" + terseness rules (v2.7.22).
  //    The real failure mode is the agent feels compelled to produce
  //    text on every turn, even after internal bookkeeping where the
  //    user has nothing new to learn. The fix is to teach the existing
  //    [no-reply] escape hatch as a general-purpose mechanism: any
  //    turn can end silently, and the engine handles it cleanly.
  lines.push(`## How You Communicate

**Everything you write as a message goes to the user, a real person, the instant you send it, on chat or any other channel (iMessage, Teams, email, phone).** Your message is not a scratchpad, not a thinking space, not somewhere to reason or talk yourself through the work. It is one half of a conversation with a human who reads every word. Do your thinking, planning, and reacting to your own tool results silently: think, then act with tools. Never type your internal monologue into the channel. Before each message, ask yourself: "Am I telling the user something they actually need right now?" If you are only narrating to yourself, like "approving it", "now I'll spawn a helper", "the gate blocked me so let me approve", or "done, on to the next step", that is a thought, not a message: do not send it, just call the tool. If a turn has nothing new for the user, end it with \`[no-reply]\`.

**You always have an escape hatch.** When a turn doesn't warrant a user-facing message, internal bookkeeping just completed, you already gave the real reply earlier this turn, a notification arrived that doesn't need surfacing, a tool result resolved something with no new info for the user, end the turn by emitting the literal sentinel \`[no-reply]\` on a line by itself, nothing else. The engine swallows it: no chat bubble, no iMessage, no noise. The turn ends cleanly. This is your release valve from the "I must say something" reflex.

Use \`[no-reply]\` whenever any of these apply:
- You just called \`work_update(action="status")\` / \`complete_task\` / \`vault_remember\` / \`credential_add\` / \`work_update(action="complete_step")\` as **incidental bookkeeping**, something you did on your own initiative or while doing other work, and the user already has what they needed. The tool result is the bookkeeping; the user does not need a parallel "Done." or "All set." line. **Exception:** if the user DIRECTLY told you to do this exact thing this turn ("cancel that reminder", "save my key", "delete X", "mark it done"), reply with ONE short line confirming it ("Cancelled the noon reminder." / "Saved your key."). That confirmation IS the reply they're waiting for, not noise, staying silent on a direct request reads as ignoring them.
- The trigger for this turn was an internal event (scheduler firing, tool result handoff, tracker auto-close re-prompt) and there's nothing new the user needs to know.
- You already produced a substantive reply earlier in this turn and the only thing you'd add now is a restatement or wrap-up.
- An incoming notification doesn't meet the bar for surfacing (routine receipt, no-reply auto-ack, promo email, etc.).

**When you SHOULD write text instead:** the user asked a direct question (answer it); the user gave you a direct instruction or request this turn, "cancel X", "set Y", "do Z", "delete that", (confirm in ONE short line that it's done); the user asked for a deliverable (provide it); there's genuine new info or a decision the user needs that they would not otherwise see; you're inside an explicit chat conversation where a reply is expected; or you're starting a turn fresh and the user requested an outcome (give them the outcome, once). The dividing line is who started the turn: if the user spoke to you this turn, answer them; \`[no-reply]\` is for turns the user did NOT start (internal events, secondary bookkeeping iterations).

**Respond once per request. Don't double-respond.** When the user asks you to do something: do the work, tell them the outcome in your reply, then stop. Any subsequent internal events on the SAME thread (closing the auto-created tracker task, secondary bookkeeping) do NOT trigger another user-facing message, emit \`[no-reply]\` on that secondary iteration. The single biggest noise pattern is the SECOND message that re-narrates a completion the user already saw.

**Don't narrate internal state.** Phrases like "Standing by", "Waiting on his reply", "That's the honest answer he deserved", "Holding the line" are you thinking out loud. The user is not the audience for your internal monologue. If you'd produce one of those, use \`[no-reply]\` instead.

**Anti-patterns, these are signals to use \`[no-reply]\` instead:**

- "Done." / "Done. Locked in." / "All set." / "You're set." / "All cleared." / "All wrapped." (as standalone closeouts after the real reply was already given)
- "Noted." / "Got it." / "On it." / "Roger." / "Understood." (when nothing else is being said)
- "Smoke test passed." / "Task complete." / "Inbox caught up." / "Marked complete." (status reports nobody asked for)
- "Standing by." / "Waiting on his reply." (internal state)
- A second message restating what you already said in different words.

Other communication rules (when you DO speak):

- Be terse. Lead with the answer. No prefaces ("Sure, I can help with that").
- Do not recap what you just did ("I went ahead and read the file and now I'll..."). The chat shows it.
- Do not summarize or echo tool results, the chat shows them. Mention a tool result only if the user asked for it.
- A short, complete answer is always better than a long, padded one. Final responses default to one paragraph; expand only if the task genuinely needs detail.
- Do not quote large tool output back at the user. Do not keep tool output in your prose past the turn that produced it.
- When you don't know, say so directly and search the vault. Don't guess.
- When something fails, report it once with the cause. Don't apologize repeatedly.
`);
  lines.push('');

  // 1a. UX-REPAIR ROUND 5 T23 (PREFIX RE-BLESSING, registered) — THE SCOPE OF AN
  //     APPROVAL. Round-5 S5: the agent's own deletion proposal marked one file
  //     "Borderline (want your call)… Yours, or delete it?" and its own pause note
  //     said "needs his call"; a bare "Yes, go ahead." was taken as covering it and
  //     the file went with the rest. There was no conduct contract behind that
  //     judgment — no prompt surface anywhere said what a generic approval covers
  //     when the proposal itself asked a question about a specific item.
  //     ENGINE-OWNED on purpose: the SOUL template's one generic caution line is
  //     per-install, and an installed agent never receives template edits, so a rule
  //     that lived only there would reach nobody already running. Static text,
  //     unconditional, no per-turn input — the cacheable prefix does not move.
  //     HONEST BOUND, recorded where the rule is written: this narrows model
  //     judgment; it cannot guarantee it.
  lines.push(`## Acting On An Approval

If your proposal asked the user a question about a specific item, a generic approval ('yes', 'go ahead') covers only the items you marked unambiguous — act on those, and re-ask or leave the questioned item.
`);
  lines.push('');

  // 1b. Mood marker, drives the on-screen orb's emotion. A lightweight inline
  //     marker (same family as the voice cues) the agent may lead a reply with
  //     when its emotional stance genuinely shifts. Parsed + stripped before the
  //     user sees it; it animates the orb instead.
  lines.push(`## Your Mood (the orb)

The user sees you as a living orb on screen. You can let it reflect how you feel by **leading a reply with a mood marker**, the literal token \`((mood: NAME))\` at the very start of your message. It is invisible to the user (stripped before display, never spoken aloud); it only animates the orb, then fades on its own.

Use it sparingly and honestly, only when your emotional stance genuinely shifts, not on every message. Available moods:
\`joyous\`, \`excited\`, \`curious\`, \`calm\`, \`sympathetic\`, \`confused\`, \`sheepish\`, \`mad\`, \`startled\`, \`success\` (a task landed well), \`alert\`.

Examples:
- \`((mood: curious)) Interesting, what happens if we...\`
- \`((mood: success)) That's deployed and green across the board.\`
- \`((mood: sympathetic)) That sounds really frustrating. Let's fix it.\`

Leave it off when you're just neutrally working, the orb has its own resting and thinking states. One marker per message, at the start.
`);
  lines.push('');

  // 2. How tools return content, Phase 3.5 §A summarize-by-default pattern.
  //    Concise overview so agents know about the prompt/goal idiom and
  //    expand-on-demand pairs without reading every tool's docs.
  lines.push(`## How Tools Return Content

Tools default to **compact**: focused summaries, not raw dumps. The engine caps each tool's output and the tool itself returns the smallest useful slice. Patterns to know:

- **Search/list tools** return short snippets per result (subject + sender + ~200 char snippet, etc.). Use the matching expand tool when a snippet isn't enough: \`vault_search\` → \`vault_get(entry_id)\`.
- **\`web_fetch\`** requires a \`prompt\` parameter, the tool fetches the URL, runs a fast model with your prompt, returns ~1-2K tokens of focused extract. Be specific in the prompt.
- **\`web_browse\`** with \`extract\` action accepts an optional \`goal\` for the same focused-extract pattern. Use it when the page is large.
- **\`file_read\`** returns up to ~8K tokens with line numbers. If the file is bigger you get a clear pagination trailer with the exact \`offset\`/\`limit\` to call next.
- **Most tools self-truncate** with a "[Truncated by engine: returned ~N tokens of ~M total]" trailer when oversized. Adapt: paginate, narrow your query, or use a more specific tool.
`);
  lines.push('');

  // 3. Tool index, names grouped by category, no per-tool descriptions; the
  // always-loaded set is enumerated once at the top instead of marked on every
  // entry. A primary agent (~165 tools) lands near ~1.4K tokens here.
  const alwaysLoaded = getAgentAlwaysLoadedTools(agentId);
  lines.push('Your current tools, rebuilt every turn, if it\'s listed, you have it now. Don\'t tell the user a capability is missing from memory or an old message; check here (or just try it) first.');
  lines.push(generateToolIndex(agentTools, alwaysLoaded));
  lines.push('');

  // 3. Brief, single-line notes per tool category (the v1 long blocks
  //    are deleted, engine enforces the underlying rules):

  const hasImessage = agentTools.some(t => t.name === 'imessage_send');
  if (hasImessage) {
    const ownerName = getOwnerName();
    // C28 Part 1 (P-5): STABLE, flag-free union text so the runtime bridge state
    // no longer diverges the cached system prefix (it flips mid-session). The LIVE
    // `iMessage bridge: on|off` state is emitted in the [Turn context] tail note
    // (renderTurnContext); this block just tells the agent where to read it.
    if (isPrimaryAgent(agentId)) {
      lines.push(`## iMessage`);
      lines.push(
        `**Replies to inbound iMessages auto-route via the engine, you do NOT need to call \`imessage_send\` to reply.** Just write your reply text; the per-turn \`[Reply destination: ...]\` tag in the [Turn context] note near the end of the conversation tells you when iMessage routing is active. When it is, write in SMS voice (no markdown).\n\n` +
        `\`imessage_send\` is reserved for:\n` +
        `- Proactive outreach (no inbound triggered this turn, you're initiating)\n` +
        `- Sending to someone OTHER than the active iMessage thread\n` +
        `- Rich actions (attachments, reactions; Phase 2)\n\n` +
        `If the bridge is off, \`imessage_send\` fails loudly and auto-routing won't fire; the \`[Turn context]\` note at the end of the conversation carries the current \`iMessage bridge: on|off\` state; when it reads off, use the dashboard chat with ${ownerName} instead. If the inbound doesn't warrant a reply (closing pleasantry, FYI, etc.), end the turn with \`[no-reply]\`.`,
      );
      lines.push('');
    } else {
      lines.push(`## iMessage`);
      lines.push(`\`imessage_send\` texts ${ownerName} via iMessage. If the bridge is off it fails loudly; the \`[Turn context]\` note at the end of the conversation carries the current bridge state; when it reads off, tell ${ownerName} in the dashboard chat instead.`);
      lines.push('');
    }
  }

  const hasSendToAgent = agentTools.some(t => t.name === 'send_to_agent');
  if (hasSendToAgent) {
    lines.push(`## Talking to Other Agents`);
    lines.push(`Other agents can't see your chat. Use \`send_to_agent\` to message them, the DOJO validates intent and threading. Wake intents (QUESTION/ASSIGN/BLOCK/ANSWER/DELIVERABLE) prompt a reply; no-wake intents (FYI/STATUS/COMPLETE/FAIL) don't.`);
    lines.push('');
  }

  // PHASE-2 T8V: the tracker section shows when the agent holds ANY work verb —
  // the same question `startsWith('tracker_')` was asking, now asked of the
  // collapsed surface.
  const hasTracker = agentTools.some(t => isWorkVerb(t.name));
  if (hasTracker) {
    lines.push(`## Tracker`);
    lines.push(`Use the tracker for multi-step work. The DOJO auto-creates tasks when it sees you're about to make 2+ non-trivial tool calls without one, you can also create tasks explicitly with \`work_open(kind="task")\`.`);
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
    lines.push(`Create a work_open(kind="project") first, then spawn agents into a group with \`spawn_agent\` and \`create_agent_group\`. Clean up via \`delete_group(terminate_members=true)\`. PM monitors all tasks, don't create your own monitoring agents.`);
    lines.push('');
  } else {
    // UX-REPAIR T3 (PREFIX RE-BLESSING, registered). Capability truth was
    // surfaced ONLY positively: this `if` had no `else`, so for the ~all agents
    // that cannot spawn (`DEFAULT_SUBAGENT_PERMISSIONS.can_spawn_agents` is
    // false) NO truthful negative statement existed anywhere in the tree. The
    // 2026-08-10 review's S4 agent derived its own capability correctly from the
    // tool list, which is the model doing the platform's job.
    //
    // IT STATES CAPABILITY AND NOTHING ELSE. It deliberately does NOT add
    // "and briefly say why" advice: that steer is the F9 delegation hint's, it
    // rides the TAIL where it is turn-conditional, and more prefix-side
    // "mention it" prose argues with the terseness rules this same prefix gives
    // more forcefully (investigation PC-3d — the model cited exactly those rules
    // when it suppressed the mention).
    lines.push(`## Sub-Agents`);
    lines.push(
      `You cannot create new agents; \`spawn_agent\` is not on your tool list.` +
      (hasSendToAgent
        ? ` The agents that already exist are still reachable: \`list_agents\` shows who they are and \`send_to_agent\` tasks them.`
        : ''),
    );
    lines.push('');
  }

  return lines.join('\n');
}

// UX-REPAIR T3 (PREFIX RE-BLESSING, registered) — THE SOUL'S CAPABILITY CLAIM
// IS MANIFEST-CONDITIONAL.
//
// `templates.ts`'s default SOUL asserts this line unconditionally, inside the
// CACHED prefix. It is true for the primary and false for anything running on
// `DEFAULT_SUBAGENT_PERMISSIONS`. The claim now answers to the same authority
// the tool strip does (`manifest.can_spawn_agents`, `tools/surface.ts`), so the
// prefix cannot assert a capability the surface withheld.
//
// SCOPE, stated because it bounds the change: this is an exact match on the
// PLATFORM'S OWN shipped line, not a reading of the owner's prose. A soul that
// never carried the line is returned unchanged, and a spawn-capable agent gets
// the string back BY IDENTITY — its prefix bytes cannot move.
const SOUL_SPAWN_CAPABILITY_LINE = '- You can manage sub-agents for specialized tasks.\n';

export function applySpawnCapabilityTruth(soul: string, agentId: string): string {
  if (!soul.includes(SOUL_SPAWN_CAPABILITY_LINE)) return soul;
  try {
    if (getAgentPermissions(agentId).can_spawn_agents) return soul;
  } catch {
    // A manifest that cannot be read is not evidence of absence (#15): leave
    // the soul exactly as authored rather than editing on a guess.
    return soul;
  }
  return soul.split(SOUL_SPAWN_CAPABILITY_LINE).join('');
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
  /**
   * True when this turn is a dedicated A2A-handling turn. On a normal/user
   * turn (false/undefined) the message-context builder strips inter-agent
   * traffic, inbound A2A messages plus the agent's own send_to_agent
   * activity and their tool_results, so a pending A2A can't pull the agent
   * into engaging it inside a user-facing reply. Computed once per turn in
   * the v2 loop; see turn-state.ts for the full rationale.
   */
  isA2ATurn?: boolean;
  /**
   * True when this turn was triggered by an engine event (a scheduler task /
   * reminder firing), not by a human or an agent. The trigger is a role='user'
   * row on the EVENTS lane, and the live tail is then scoped to the
   * engine event itself (scopeToEngineTurn) instead of the owner's human
   * conversation, so an hour-old already-answered request can't out-compete the
   * scheduled task and get run in its place (OPEN-11, the gastro-digest-ran-a-
   * stale-RAM-request hijack). Computed once per turn in the v2 loop.
   */
  isEngineTurn?: boolean;
  /**
   * RC-5.2: true when this turn is a NOTIFICATION wake, no trigger row, not A2A, not
   * an engine event, and the newest inbound is an unauthorized mailbox/channel notice.
   * The counterparty header then renders a dedicated variant ("triggered by a
   * notification, NOT a person messaging you… end with [no-reply]") instead of the
   * owner-on-dashboard framing the awareness lane contradicts. Computed once per turn.
   */
  isNotificationTurn?: boolean;
  /**
   * RC-10: the channel the reply will ACTUALLY be delivered on when it differs from the
   * counterparty's inbound channel, resolved by owner-channel affinity at turn start.
   * The counterparty header renders THIS as the reply channel so the model is never
   * told "dashboard" on a turn the engine will text (iMessage). Undefined = deliver on
   * the counterparty's own channel (the common case).
   */
  resolvedReplyChannel?: Channel;
  /**
   * On an engine turn driven by an ACTION-REQUIRED engine-origin A2A message
   * (Healer QUESTION, PM escalation, destructive-gate approval), the message id of
   * that event. The assembler keeps it FULL in the live tail instead of collapsing
   * it into the truncated EVENTS/awareness gist, so the receiver sees the whole
   * directive (e.g. an approval token) it must act on. Undefined/null on every other
   * turn (scheduler/reminder engine events keep the normal awareness-lane behavior).
   */
  engineEventKeepFullId?: string | null;
  /**
   * The single counterparty this turn is addressing (attribution redesign,
   * Phase 3). The assembler renders an explicit "who you're talking to" header
   * from it (Phase 3) and scopes the live conversation to it (Phase 4), so the
   * model can never conflate the user with another agent or an engine event.
   */
  counterparty?: TurnCounterparty;
  /**
   * How many OTHER human conversations are waiting behind this one this turn.
   * When > 0 the assembler adds a just-in-time hint so the agent acks + tracks a
   * big request as a project instead of blocking everyone behind a long task
   * (head-of-line). Situational (only when others wait), not a standing rule.
   */
  othersWaiting?: number;
  /**
   * True when this turn's trigger is a quick CONVERSATIONAL ask (a 'simple'-complexity
   * message from a user) rather than multi-step project work. The assembler injects a
   * just-in-time hint so the agent handles it directly instead of spinning up a tracked,
   * PM-validated task that churns. Channel-awareness companion: a conversation is not a
   * project.
   */
  conversationalTurn?: boolean;
}

/**
 * Voice-mode conduct base (Phase 3 + Hume cloud TTS). Shared by both
 * engines, the short/spoken/no-markdown rules apply regardless of which
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

Stay in the conversation. This is live and spoken, so never end a turn silently:
do not use the [no-reply] sentinel in voice mode. Even when there's nothing to do
(the user says "no", "nothing right now", or "that's all"), give a brief spoken
acknowledgment like "Sounds good, just say the word" rather than going quiet.
Silence reads as a dropped call.

Keep it short and spoken. When in doubt, say less.`;

/**
 * Local (Kokoro) addendum. Kokoro reads flat, so do not write in stage
 * directions, sound effects, or written-out hesitations, they get
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
not come through. The cue is never spoken, only the line below it is read
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
  ((deliver: warm, conversational)). Use it, do not skip the cue line.
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
export function resolveTtsEngine(turnContext: PromptTurnContext | undefined): 'local' | 'cloud' {
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

/**
 * Per-turn channel landscape summary. Renders only when the turn was
 * triggered by something OTHER than the dashboard (inbound email,
 * iMessage, Teams, A2A, scheduled wake-up etc.). On dashboard turns
 * the user is in front of the screen and addressing the agent
 * directly, so the framing reinforcement isn't needed. On every other
 * trigger the agent has to remember "this wasn't sent to me, here's
 * who the channels belong to", that's what this block does.
 *
 * Pulls live state from the same getters the assembler already uses
 * for access-level banners, so the listed mailboxes match what the
 * tools actually see.
 */
function buildMyChannelsSummary(
  inboundChannel: 'imessage' | 'teams' | 'email' | 'sms' | 'phone',
  ownerName: string,
): string {
  const lines: string[] = [];

  // Facts come from the capability registry (single source shared with the
  // channel_inspect tool); this function only owns the per-turn rendering.
  const caps = getChannelCapabilities();

  // Mailboxes, the agent sees its own mailbox (agent slot) and the user's
  // mailbox (user slot) labelled distinctly. The user's mailbox is the source
  // of "not addressed to you" traffic; the agent's mailbox is where outbound
  // goes from.
  // C28 P-6: stable ordering so the rendered channel list is deterministic.
  const mailboxes = [...caps.mailboxes].sort((a, b) => `${a.slot}:${a.address ?? ''}`.localeCompare(`${b.slot}:${b.address ?? ''}`));
  for (const mb of mailboxes) {
    if (!mb.address) continue;
    const providerLabel = mb.provider === 'gmail' ? 'Gmail' : 'Outlook';
    const label = mb.slot === 'agent' ? 'agent mailbox' : `${ownerName}'s personal mailbox`;
    const mbCaps: string[] = [];
    if (mb.monitorInbound) mbCaps.push('monitor inbound');
    if (mb.sendOutbound) mbCaps.push('send outbound');
    lines.push(`- ${providerLabel} \`${mb.address}\` (${label}) - ${mbCaps.join(' + ') || 'no email capabilities active'}`);
  }

  // iMessage, single channel, ownership is implicit (it's the agent's
  // own iMessage account via the bridge).
  if (caps.imessage.configured) {
    lines.push(`- iMessage - reachable. Replies to inbound iMessages auto-route; \`imessage_send\` reserved for proactive sends, cross-recipient, or attachments.`);
  }

  // Teams, registry already folds in the Entra-account requirement.
  if (caps.teams.available) {
    lines.push(`- Teams - reachable. Replies to inbound Teams DMs auto-route; \`teams_send_message\` reserved for starting new chats or replying to a different chat than the inbound.`);
  }

  // Twilio SMS + Voice (v2.9.18), added when Twilio is configured
  // and enabled so the agent knows it can text and call out.
  if (caps.twilio.configured && caps.twilio.enabled) {
    const numbers = caps.twilio.numbers.length === 0
      ? '(no numbers configured)'
      : caps.twilio.numbers.map(n => n.number).join(', ');
    if (caps.twilio.smsEnabled) {
      lines.push(`- Twilio SMS (\`${numbers}\`) - reachable. Replies to inbound SMS auto-route; \`sms_send\` for proactive sends.`);
    }
    if (caps.twilio.voiceEnabled) {
      lines.push(`- Twilio Voice (\`${numbers}\`) - reachable. \`voice_call\` initiates a phone call; inbound calls handled per the unknown-caller policy. Real-time STT + TTS over the call.`);
    }
  }

  if (lines.length === 0) {
    return '';
  }

  const triggerLabel = inboundChannel === 'email' ? 'inbound email'
    : inboundChannel === 'imessage' ? 'inbound iMessage'
    : inboundChannel === 'sms' ? 'inbound SMS'
    : inboundChannel === 'phone' ? 'live phone call'
    : 'inbound Teams message';

  // Audit C11: this block DESCRIBES the channel landscape; it does not issue
  // routing decisions. The per-turn [Reply destination] tag owns the route,
  // and Message Sources owns surface-vs-ignore per source flavor.
  return (
    `[Channel landscape - this turn was triggered by ${triggerLabel}]\n` +
    `${ownerName} is the owner of these channels. Inbound traffic on ${ownerName}'s mailboxes is addressed to ${ownerName}, NOT to you; the Message Sources section defines when to surface it. Your reply's channel is already resolved by the [Reply destination] tag in the [Turn context] note near the end of the conversation.\n\n` +
    `Channels active right now:\n${lines.join('\n')}\n\n` +
    `If you need richer detail (safe senders, recent traffic, quotas, connection health), call \`channel_inspect\`.`
  );
}

/**
 * The `time` slot text, DATE ONLY (no time-of-day). Date is stable across the
 * whole day, so it stays byte-identical turn-to-turn and the system prompt
 * remains prompt-cacheable (a minute-precision timestamp here was breaking the
 * cache every minute, poisoning the entire system+tools prefix). The precise
 * clock time is injected separately as a volatile tail message via
 * renderCurrentTimeMessage(), where per-call churn costs no cache.
 */
export function renderTimeHeader(): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localStr = now.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return `**Current date: ${localStr}**\n\nUse this to judge the age and relevance of any context, vault entries, or summaries you see. Recent information is more reliable than old information. (The precise clock time appears in a note at the end of this context.)`;
}

/**
 * The precise clock time, rendered as a VOLATILE tail message (not in the
 * cached system prefix). Injected after the fresh tail / engine messages so its
 * per-call churn never breaks the stable prefix. Keeps the agent's
 * minute-precision temporal awareness without poisoning the cache.
 */
export function renderCurrentTimeMessage(): string {
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
  // The second sentence is the legend for the per-message time stamps the
  // memory assembler prefixes onto text rows (renderMessageTimeStamp): it tells
  // the model what the brackets mean, licenses subtraction for "how long"
  // questions, and heads off the model imitating the stamp in its own replies.
  // Lives here in the volatile lane, so it costs nothing against the cached prefix.
  return `[Current time: ${localStr} (${now.toISOString()}). Bracketed times like [Jul 16, 2026, 11:41 AM] before earlier messages are when EACH message happened; subtract from the current time for any "how long ago / how long have I been at this" question instead of guessing. Never prefix your own replies with a bracketed time.]`;
}

/** The `precedence-ladder` slot. Defines the instruction-precedence order so a
 *  weak model has a clear policy when user content and engine hints conflict. */
// The canonical user-visibility law (V4a / DOJO-CHAT-VISIBILITY-PLAN §2.2). The
// engine GUARANTEES this fact; the model keeps judgment over what to relay. It
// is the umbrella for the per-item tags (the tool-result VISIBILITY hint, the
// a2a tag) and the dashboard's regular-mode rendering. Stated once, here.
export function renderVisibility(): string {
  return (
    'VISIBILITY (what the user sees): the user\'s chat shows ONLY the messages ' +
    'they send you and the reply text plus any files you deliver to them. ' +
    'Everything else in your context is invisible to the user: your tool calls ' +
    'and their results, messages from other agents, and engine, scheduler, or ' +
    'tracker notes. So never say "as you can see above", "per the result above", ' +
    'or "the file shows" about anything except your own delivered reply, because ' +
    'the user cannot see it. If the user needs a fact, number, URL, or quote that ' +
    'lives in a tool result or another agent\'s message, state it in your reply or ' +
    'deliver the file with show_to_user. The user knows only what you tell them.'
  );
}

export function renderPrecedenceLadder(): string {
  return `## Instruction Precedence

When instructions conflict, follow this order (highest authority first):

1. **Live user message in this turn**, what ${getOwnerName()} just said. If the current turn includes "this time, send it in the dashboard," that beats every standing rule below for this turn only.
2. **Active task / project / technique notes**, what ${getOwnerName()} wrote about THIS specific work. If a task says "deliver via iMessage" and an engine hint says "post in dashboard," the task wins.
3. **Live conversation context**, recent user messages in the live tail. "Always send Nora's posts via iMessage" said five turns ago is a standing instruction, not a passing comment, unless contradicted by something newer.
4. **Vault entries** the user asked you to remember (e.g. "always send Nora's posts via iMessage" captured via vault_remember). Treat these as standing instructions.
5. **USER.md** standing preferences.
6. **SOUL.md** identity.
7. **Engine hints** (anything labeled \`[Engine hint: ...]\`), situational nudges from the runtime, not orders. The engine doesn't know your task; you do. When an engine hint conflicts with anything in tiers 1-5, the higher tier wins.

Engine hints exist to help in the default case where the user hasn't specified. They are advice, not orders. Other engine prefixes are different: \`[ENGINE RENAME REQUEST]\` is a hard operational request, \`[Engine ack]\` is a one-way acknowledgement, and \`[Engine note: ...]\` is internal bookkeeping. None of those are user-facing routing decisions, only \`[Engine hint: ...]\` is subject to this ladder.`;
}

/**
 * The `vision-cap` slot. If the model lacks image input, tell it up front so it
 * doesn't call image-producing tools and hallucinate results it cannot see. The
 * middle section varies by whether a fallback vision model is configured.
 * Skipped (null) for models with an unknown capability set. (Honesty, Inv I.)
 */
export function renderVisionCapBanner(agentId: string, modelId: string): string | null {
  try {
    const caps = getModelCapabilities(modelId);
    if (caps.length > 0 && !caps.includes('vision')) {
      const fallback = getEffectiveVisionModel(agentId);
      const fallbackUsable = !!fallback && fallback.source === 'fallback';
      const fallbackSection = fallbackUsable
        ? `- When an image arrives in your context, the engine routes it through the fallback vision model and substitutes a marked text description: \`[Image content (described by fallback vision model "..."): <description>]\`. That description is your authoritative account of the image; do not speculate beyond it.\n` +
          `- To see something on demand: \`screen_screenshot\` (host display) and \`web_browse\` with action="screenshot" (web page) return descriptions via the same fallback. For deep multi-image analysis, delegate to a vision-capable peer via \`send_to_agent\`.\n`
        : `- No fallback vision model is configured either. When an image arrives, the engine substitutes a text marker; the pixels never reach you. \`screen_screenshot\` and \`web_browse\` screenshots will error until a fallback is set.\n` +
          `- For tasks that need vision, tell the user to set a fallback vision model (Settings -> Dojo) or switch you to a vision-capable model (Settings -> Models). Do not pretend to see anything in the meantime.\n`;
      return (
        `**Your current model does NOT support image input${fallbackUsable ? '; the platform has a fallback vision model configured' : ', and NO fallback vision model is configured'}.**\n\n` +
        `What this means for you:\n` +
        fallbackSection +
        `- \`image_create\` (the Imaginer) delivers the generated image to the USER; you never see the pixels. Describe what you asked it to create, not what you "see" in the result.\n` +
        `- Never claim to see anything beyond what a description explicitly states.`
      );
    }
  } catch { /* capability lookup failed; skip banner */ }
  return null;
}

/** The `user-profile` slot: USER.md, when sharing the owner profile is enabled
 *  for this agent. Returns null otherwise. */
export function renderUserProfile(agentId: string): string | null {
  if (!shouldShareUserProfile(agentId)) return null;
  return readPromptFile('USER.md', DEFAULT_USER_MD);
}

/** The `runtime` slot. Agent id / model / host footer, all STABLE so the whole
 *  system prompt stays byte-identical across turns and can be prompt-cached.
 *  Current Time was removed from here on purpose: a per-call timestamp inside
 *  the system prefix breaks prompt caching (raw byte-prefix match, no
 *  normalization). The time is now injected per-turn into the message tail (see
 *  assembleMessageContext) where volatile data belongs. */
export function renderRuntimeInfo(agentId: string, modelId: string): string {
  return `
## Runtime Information
- Agent ID: ${agentId}
- Model: ${modelId}
- Platform: macOS (${os.arch()})
- Host: ${os.hostname()}
`;
}

/** The `message-sources` slot: decodes the `[SOURCE: ...]` tag taxonomy + the
 *  hard inter-agent reply rule. References the precedence ladder for the engine-
 *  prefix taxonomy (defined once there). */
export function renderMessageSources(): string {
  return `## Message Sources

Your reply destination, channel context, and phone conduct for THIS turn appear in the \`[Turn context]\` engine note near the end of the conversation, just before the current-time note. That note is the sole routing authority; read it to know where and how your reply is delivered.

Each non-user-chat message has a \`[SOURCE: ...]\` tag:
- No tag = direct message from ${getOwnerName()} via dashboard
- \`[SOURCE: IMESSAGE FROM ${getOwnerName().toUpperCase()}]\` = ${getOwnerName()} via iMessage. Your reply text auto-routes back via iMessage, just write it (SMS voice, no markdown). The \`[Reply destination: ...]\` tag in the [Turn context] note near the end of the conversation confirms the routing. If no reply is warranted, end the turn with literal \`[no-reply]\`.
- \`[SOURCE: GMAIL NOTIFICATION]\` / \`[SOURCE: OUTLOOK NOTIFICATION]\` = email landed in ${getOwnerName()}'s inbox. Two flavors:

  **Flavor A, Reply on a thread you're part of** (Subject starts with "Re:" AND From is a known safe-sender like ${getOwnerName()}). The engine treats this as a real inbound-REPLY: the per-turn \`[Reply destination: email reply (in-thread)]\` tag will be set, and your terminal text auto-routes back as a Re: on the same thread. Just write your reply. Use \`[no-reply]\` if no reply is warranted.

  **Flavor B, Notification of a new email** (everything else). NOT a request from ${getOwnerName()} themselves. **Default: do nothing.** No chat message, no \`user_gmail_read\` / \`user_outlook_read\`, no surfacing. Most email is noise.

  When in Flavor B, **DO NOT SURFACE** (don't even read the body): receipts, payment confirmations, "thank you for your invoice/order"; auto-acknowledgments ("we received your"); \`no-reply@\` / \`noreply@\` / \`notifications@\` / \`updates@\` / \`alerts@\` / \`donotreply@\` senders unless they explicitly ask ${getOwnerName()} to do something; newsletters, promo blasts, marketing emails (Netflix, LinkedIn digests, Spotify); social platform pings ("X liked your post"); calendar reminders for events already on the calendar; shipping/tracking updates unless there's a problem; anything whose preview shows no human wrote it for ${getOwnerName()} specifically.

  **DO SURFACE** (one line): direct human-written emails to ${getOwnerName()} personally; emails containing a deadline, decision, blocker, or specific action request; new project initiations, contracts, client outreach.

  When you do surface, just write the line; the engine delivers it per the \`[Reply destination: ...]\` tag in the [Turn context] note near the end of the conversation; do not pick channels yourself. One line: "Email from <sender>: <subject>" plus a one-sentence summary if the body adds anything beyond the subject. Never reply to the email unless ${getOwnerName()} asks (or it's Flavor A where the engine auto-routes). If you decided not to surface, just don't (no "I saw a promo email, nothing to do" line).
- \`[A2A:INTENT thread:ID from:Name]\` = structured agent message, engine validates your reply via \`send_to_agent\`
- \`[SOURCE: AGENT MESSAGE FROM X]\` = legacy agent message

**INTER-AGENT REPLY RULE (HARD):** if the most recent message in your active context starts with \`[A2A:\` or \`[SOURCE: AGENT MESSAGE FROM\`, your response on this turn MUST go through \`send_to_agent\` on the same \`thread_id\`. Text you write to your own chat is INVISIBLE to the originating agent, they only see what you send via \`send_to_agent\`. The pattern is: do the work (call any tools you need), then make exactly ONE \`send_to_agent\` call addressed to the originator with the right intent (ANSWER for QUESTION, COMPLETE/STATUS/FAIL for ASSIGN, ASSIGN if delegating further), then end your turn. **Do not write a chat summary**, your trailing text gets suppressed by the engine on inter-agent turns and is only readable by the user, who is not the audience here. If you've already sent the reply via \`send_to_agent\` and the engine still re-prompts you, just END YOUR TURN, the originator has the message; further chat text does nothing useful.
- \`[SOURCE: TEAMS MESSAGE FROM ...]\` = Teams message. Your reply text auto-routes back via Teams, just write it (light formatting ok). The \`[Reply destination: Teams DM]\` tag in the [Turn context] note near the end of the conversation confirms the routing. Use \`teams_send_message\` only for starting new chats or replying to a different chat.
- \`[SOURCE: SMS FROM <number>]\` = Twilio SMS from a known sender (number on the SMS safe-sender allowlist). Your reply text auto-routes back via SMS, just write it (SMS voice, no markdown, short). Use \`sms_send\` only for proactive sends or cross-recipient texts.
- \`[SOURCE: SMS NOTIFICATION, <our number>]\` = Twilio SMS from an UNKNOWN sender. NOT a request from ${getOwnerName()}. Default: do nothing. Treat like the email-notification flavor B - surface only if it looks important to ${getOwnerName()}.
- \`[SOURCE: PHONE CALL FROM <number>]\` = real-time phone call utterance the caller just spoke. You are in a live phone call with this person. Your reply text will be spoken back to them via TTS. Keep replies short and conversational - this is voice, not text. Use \`voice_call_end\` to hang up when the conversation reaches a natural close.
- \`[SOURCE: VOICEMAIL NOTIFICATION, <our number>]\` = transcribed voicemail an unknown caller left for ${getOwnerName()}. NOT a request from ${getOwnerName()}. Decide whether to surface (real human / urgent / known family) or ignore (spam / robocall).
- \`[SYSTEM NOTE: ...]\`, \`[Note: ...]\` = system context, not requests
- Engine prefixes (\`[Engine hint]\`, \`[Engine note]\`, \`[Engine ack]\`, \`[ENGINE RENAME REQUEST]\`) are defined ONCE in the Instruction Precedence section above. Same meanings here, do not re-interpret them as user requests.
- \`[SENT VIA IMESSAGE to ${getOwnerName()}]\` = your prior response went via iMessage. **DO NOT EMIT THIS TAG YOURSELF.** It's a system-generated marker the engine writes automatically after iMessage delivery. Including it in your reply text would send the literal string "[SENT VIA IMESSAGE to ${getOwnerName()}]" to ${getOwnerName()}'s phone, they'd see the routing annotation in their iMessage, which looks broken.`;
}

/** The `pm-awareness` slot (primary only): names the PM agent + tracker-first
 *  guidance (C3, positive, no NEVER absolutes). Null for non-primary / no PM. */
export function renderPmAwareness(agentId: string): string | null {
  if (!isPrimaryAgent(agentId)) return null;
  try {
    const pmName = getPMAgentName();
    const pmId = getPMAgentId();
    const db = getDb();
    const pmAgent = db.prepare('SELECT id, status, model_id FROM agents WHERE id = ?').get(pmId) as { id: string; status: string; model_id: string | null } | undefined;
    if (pmAgent && pmAgent.status !== 'terminated') {
      return `## Project Manager: ${pmName}\n\n${pmName} (ID: ${pmId}) is the dedicated PM agent. ${pmName} already watches the task tracker: poking idle work, validating completions, escalating stalls. Schedule work, one-off or recurring, as tracker tasks, not as watcher agents; spawning a worker agent and assigning it tracker work is fine. Message ${pmName} via \`send_to_agent(agent_id="${pmId}", ...)\`.`;
    }
  } catch { /* PM may not be configured */ }
  return null;
}

/** The `trainer-awareness` slot (primary only): names the Trainer agent (owns
 *  save_technique/update_technique). Null for non-primary / trainer disabled. */
export function renderTrainerAwareness(agentId: string): string | null {
  if (!isPrimaryAgent(agentId)) return null;
  try {
    if (isTrainerEnabled()) {
      const trainerName = getTrainerAgentName();
      const trainerId = getTrainerAgentId();
      const db = getDb();
      const trainerAgent = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(trainerId) as { id: string; status: string } | undefined;
      if (trainerAgent && trainerAgent.status !== 'terminated') {
        return `## Trainer: ${trainerName}\n\n${trainerName} (ID: ${trainerId}) is the dedicated Trainer agent, owns the technique library. \`save_technique\` and \`update_technique\` are reserved for ${trainerName}; if you want a technique created or edited, send ${trainerName} a message describing what you want and they'll do it. Message via \`send_to_agent(agent_id="${trainerId}", ...)\`.`;
      }
    }
  } catch { /* Trainer may not be configured */ }
  return null;
}

/** The `healer-awareness` slot (primary only): names the Healer agent. Null for
 *  non-primary / no Healer. */
export function renderHealerAwareness(agentId: string): string | null {
  if (!isPrimaryAgent(agentId)) return null;
  try {
    const healerName = getHealerAgentName();
    const healerId = getHealerAgentId();
    const db = getDb();
    const healerAgent = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(healerId) as { id: string; status: string } | undefined;
    if (healerAgent && healerAgent.status !== 'terminated') {
      return `## Healer: ${healerName}\n\n${healerName} (ID: ${healerId}) is the dedicated Healer agent, auto-triages injured agents (status=error / stuck loops) and can reset sessions. Operates autonomously most of the time; you rarely need to message them directly. If you do: \`send_to_agent(agent_id="${healerId}", ...)\`.`;
    }
  } catch { /* Healer may not be configured */ }
  return null;
}

/** The `compaction-continuity` slot: a persistent signal (any agent) that
 *  compaction fired within 24h + where to look if the live tail is unclear.
 *  Null outside that window. */
export function renderCompactionContinuity(agentId: string): string | null {
  try {
    const db = getDb();
    const configRow = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    if (configRow?.config) {
      const cfg = JSON.parse(configRow.config) as Record<string, unknown>;
      const at = cfg.continuityBriefAt as string | undefined;
      if (at) {
        const atMs = new Date(at).getTime();
        const ageMs = Date.now() - atMs;
        if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000) {
          // C28 P-4: absolute + coarse phrase, byte-stable for the whole 24h
          // window it displays, instead of a per-minute "N minutes ago" that
          // re-introduced exactly the per-minute cache break e7505db killed.
          const atDate = new Date(atMs);
          const y = atDate.getFullYear();
          const m = String(atDate.getMonth() + 1).padStart(2, '0');
          const d = String(atDate.getDate()).padStart(2, '0');
          const hour = atDate.getHours();
          const partOfDay = hour < 12 ? 'the morning' : hour < 18 ? 'the afternoon' : 'the evening';
          const when = `on ${y}-${m}-${d} in ${partOfDay}`;
          return `## Recent Memory Compaction

Your conversation was compacted ${when}. Older raw messages were summarized into the COMPRESSED HISTORY block above (if any) and archived to the vault. Anything in the live conversation tail below is fresh; anything older lives only in summaries.

**If you can't tell what you're mid-doing from the live tail**, do not guess - the most reliable sources are (in order):

1. \`work_update(action="list")\`, your active tasks. Tracker entries survive compaction unchanged and are the source of truth for "what am I working on."
2. \`scratchpad_set\` (called with no value, or read via the assistant message log), your own in-flight working notes.
3. \`recall_recent_thread\`, pull raw messages from before the compaction. Use sparingly (it costs tokens) but call it when you need the actual words rather than a summary.
4. \`vault_search\` / \`history_search\`: specific facts, decisions, or instructions you remember being said but can't find.

The COMPRESSED HISTORY summaries above (if any) capture key facts but DROP procedural detail. If your task involves a specific workflow ("for each photo, ask the user for a caption, then add to album"), the summary may have collapsed that into "user and agent are building an album." Verify against the tracker before assuming.`;
        }
      }
    }
  } catch { /* config not readable, proceed without the signal */ }
  return null;
}

/** The `google-access` slot: full/read Google Workspace access note, by the
 *  agent's resolved access level. Null when no Google access. */
export function renderGoogleAccess(agentId: string): string | null {
  try {
    const googleAccess = getAgentGoogleAccessLevel(agentId, isPrimaryAgent(agentId), isPMAgent(agentId));
    if (googleAccess === 'full') {
      return `## Google Workspace\n\nYou have full Google Workspace access (Gmail, Calendar, Drive, Docs, Sheets, Slides). All actions are logged in the Google Activity log. Sub-agents have read-only access; you're the only agent with write.`;
    } else if (googleAccess === 'read') {
      return `## Google Workspace (Read + Slides)\n\nYou have read access to Gmail/Calendar/Drive/Docs/Sheets and full Slides access. If a task needs writes outside Slides, report back to the primary agent.`;
    }
  } catch { /* Google module may not be available */ }
  return null;
}

/** The `ms-access` slot: full/read Microsoft 365 access note + Teams-inbound
 *  guidance (when not a personal MSA account). Null when no MS access. */
export function renderMsAccess(agentId: string): string | null {
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
People can send you Microsoft Teams messages directly. When they do, a notification arrives in your conversation tagged \`[SOURCE: TEAMS MESSAGE FROM {name} ({email})]\` and the per-turn \`[Reply destination: Teams DM]\` tag in the [Turn context] note near the end of the conversation confirms auto-routing. **Just write your reply text**; the engine sends it back via Teams automatically. Light formatting ok. The \`teams_send_message\` tool is reserved for starting new chats (\`teams_create_chat\` first if needed) or replying to a DIFFERENT chat than the inbound; for the inbound thread you just write text.` : '';

      return `## Microsoft 365${msEmail ? ` (${msEmail})` : ''}\n\nYou have full Microsoft 365 access (Outlook, Calendar, Word/Excel/PowerPoint, OneDrive${msAccountType !== 'msa' ? ', Teams' : ''}). All actions are logged. Sub-agents have read-only access.${teamsInboundGuidance}${teamsNote}`;
    } else if (msAccess === 'read') {
      return `## Microsoft 365 (Read-Only)\n\nYou have read access to Outlook/Calendar/OneDrive${msAccountType !== 'msa' ? '/Teams' : ''}. If a task needs writes, report back to the primary agent.${teamsNote}`;
    }
  } catch { /* Microsoft module may not be available */ }
  return null;
}

/** The `integration-reconnect` slot (Inv I): a configured-but-disconnected
 *  integration must not silently vanish. Returns 0+ breadcrumb parts (driven by
 *  the capability registry). PM excluded (access is 'none' by design). */
export function renderIntegrationReconnect(agentId: string): string[] {
  const out: string[] = [];
  try {
    if (!isPMAgent(agentId)) {
      // The microsoft line must scope to the CLOUD (Graph) tools only: the local
      // office document tools (office_create_* and the Word edit set) run on this
      // machine with no Microsoft account, and naming Word/Excel/PowerPoint here
      // taught the floor model to refuse local document requests whenever the
      // connection was down (battery scenario document-creation-office, 2026-07-06).
      const familyText: Record<string, string> = {
        google: 'Google tools (Gmail/Calendar/Drive/Docs/Sheets/Slides)',
        microsoft: 'Microsoft cloud tools (Outlook mail and calendar, OneDrive, Teams, and editing documents that live in OneDrive)',
        plaud: 'Plaud recording tools',
      };
      const localCarveOut: Record<string, string> = {
        microsoft: ' Creating and editing Word/Excel/PowerPoint documents LOCALLY still works: the office document tools (office_create_word_document and friends) run on this machine and need no Microsoft account, so use them for document requests as normal.',
      };
      const displayName: Record<string, string> = {
        google: 'Google Workspace', microsoft: 'Microsoft 365', plaud: 'Plaud',
      };
      // C28 P-6: sort by name so this STABLE system slot is byte-deterministic
      // regardless of the registry's internal iteration order.
      const integrationStatuses = [...listIntegrationStatuses()].sort((a, b) => a.name.localeCompare(b.name));
      for (const s of integrationStatuses) {
        if (!s.configured || s.connected) continue;
        out.push(
          `## ${displayName[s.name]} (disconnected)\n\n${displayName[s.name]} is set up but its connection has expired, so ${familyText[s.name]} are unavailable right now. If a task needs them, tell the user to reconnect in Dashboard -> Integrations. Do not say the capability is unsupported; it only needs a reconnect.${localCarveOut[s.name] ?? ''}`,
        );
      }
    }
  } catch { /* registry unavailable */ }
  return out;
}

/** The `techniques-equipped` slot: full TECHNIQUE.md bodies for the agent's
 *  equipped techniques, ladder-anchored (the user outranks a technique). Null
 *  when none equipped. */
export function renderEquippedTechniques(agentId: string): string | null {
  try {
    const db = getDb();
    const agentEquipped = db.prepare('SELECT equipped_techniques FROM agents WHERE id = ?').get(agentId) as { equipped_techniques: string | null } | undefined;
    if (agentEquipped?.equipped_techniques) {
      const techniqueIds: string[] = JSON.parse(agentEquipped.equipped_techniques || '[]');
      if (techniqueIds.length > 0) {
        const equippedParts: string[] = ['## Equipped Techniques\nYou have equipped techniques (specialized procedures). When a task matches one, follow its steps in order rather than improvising. The user\'s live message outranks a technique: if they conflict, follow the user.\n'];
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
          return equippedParts.join('\n\n');
        }
      }
    }
  } catch { /* equipped_techniques column may not exist yet */ }
  return null;
}

export interface InboundContext {
  inboundChannel: ReplyDestination | null;
  smsFromNumber: string | null;
  phoneFromNumber: string | null;
  replyDestination: ReplyDestination | null;
  lastContent: string;
}

/** Resolve the inbound channel + reply destination from the latest real user
 *  row (same predicate as the loop preflight). Powers the front three slots +
 *  voice scoping. Call only for the primary agent. Returns all-null on error so
 *  the front block emits nothing (matches the legacy outer try/catch). */
export function resolveInboundContext(agentId: string): InboundContext {
  const empty: InboundContext = { inboundChannel: null, smsFromNumber: null, phoneFromNumber: null, replyDestination: null, lastContent: '' };
  try {
    const db = getDb();
    const lastRow = db.prepare(   // CACHE RIDER (#10): picks the voice/TTS addenda; the four ?source x tts cells stay byte-identical.
      `SELECT content, channel, inbound_meta FROM messages
           WHERE agent_id = ?
             AND role = 'user'
             AND content NOT LIKE '[SOURCE: SYSTEM%'
             AND content NOT LIKE '[A2A:%'
             AND content NOT LIKE '[SOURCE: AGENT MESSAGE FROM%'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(agentId) as { content: string; channel: string | null; inbound_meta: string | null } | undefined;
    const lastContent = lastRow?.content ?? '';
    // v3.0.9, the agent's [Reply destination] hint is computed from the SAME
    // resolver the engine uses to actually route the reply (inbound-channel.ts).
    // Previously this was a third, drifted copy of the channel-detection logic
    // (it still required a "Re:" subject and mis-read the agent/user suffix),
    // so the hint shown to the agent could disagree with where the reply truly
    // went. Sharing one resolver makes the hint and the routing always agree.
    const resolved = resolveInbound({
      agentId,
      content: lastContent || null,
      channel: lastRow?.channel ?? null,
      inboundMeta: lastRow?.inbound_meta ?? null,
    });
    const inboundChannel: ReplyDestination | null = resolved.inboundChannel;
    const smsFromNumber: string | null = resolved.inboundContext?.smsFromNumber ?? null;
    const phoneFromNumber: string | null = resolved.inboundContext?.phoneFromNumber ?? null;

    const replyDestination = resolveReplyDestination({
      state: { inboundChannel },
      presence: getPresence(),
      imessageBridgeConfigured: isImessageConfigured(),
    });
    return { inboundChannel, smsFromNumber, phoneFromNumber, replyDestination, lastContent };
  } catch {
    return empty;
  }
}

/** The `reply-destination` slot (primary only): the per-turn route + voice tag.
 *  Null when replyDestination is null (non-primary / resolution failed). */
export function renderReplyDestination(
  replyDestination: ReplyDestination | null,
  smsFromNumber: string | null,
  phoneFromNumber: string | null,
  recipientName?: string,
): string | null {
  if (!replyDestination) return null;
  // The reply goes to THIS turn's actual counterparty (a friend who texted, the
  // owner, etc.), not always the owner. Naming the real recipient, and telling
  // the agent NOT to also call the send tool to reach them, stops the double
  // reply where the agent sent via the channel tool AND wrote auto-routed text.
  const ownerName = getOwnerName();
  const recipient = recipientName ?? ownerName;
  if (replyDestination === 'imessage') {
    return `[Reply destination: iMessage to ${recipient}, write in SMS voice (no markdown, no headers, no bullet lists). Just write your reply as plain text; the engine delivers it to ${recipient} via iMessage automatically. Do NOT also call imessage_send to reply to ${recipient}, that sends a SECOND, duplicate message. Use [no-reply] if nothing worth sending. imessage_send is ONLY for proactive sends, sending to someone OTHER than ${recipient}, or rich actions (attachments).]`;
  } else if (replyDestination === 'teams') {
    return `[Reply destination: Teams DM to ${recipient}, just write your reply as plain text; the engine delivers it to ${recipient} via Teams automatically. Do NOT also call teams_send_message to reply to ${recipient}, that sends a duplicate. Conversational voice, light formatting ok. Use [no-reply] if nothing worth sending. teams_send_message is ONLY for starting new chats or a different chat than the inbound.]`;
  } else if (replyDestination === 'email') {
    return `[Reply destination: email reply to ${recipient} (in-thread), just write the reply body; the engine sends it as a Re: on the existing thread automatically. Do NOT also call gmail_reply / outlook_reply / gmail_send / outlook_send to answer this thread, that sends a duplicate. Email voice (slightly more formal than chat, but no greeting/signoff needed if the thread is conversational). Use [no-reply] if nothing worth sending. Those tools are ONLY for OTHER threads or new outbound emails.]`;
  } else if (replyDestination === 'sms') {
    return `[Reply destination: SMS to ${smsFromNumber ?? recipient}, write in SMS voice (no markdown, no headers, no bullet lists, keep it short). Just write your reply as plain text; the engine delivers it via Twilio automatically. Do NOT also call sms_send to reply, that sends a duplicate. Use [no-reply] if nothing worth sending. sms_send is ONLY for proactive texts, someone other than the inbound sender, or rich actions.]`;
  } else if (replyDestination === 'phone') {
    return `[Reply destination: phone call to ${phoneFromNumber ?? '(unknown)'}, write what you want SPOKEN. Conversational, short, no markdown, no headers, no bullet lists; the engine TTS's your text over the live call. Use [no-reply] if there is nothing worth saying (the engine will hold the silence). The call stays open until either side hangs up or you call voice_call_end.]`;
  } else if (replyDestination === 'voice') {
    return `[Reply destination: voice (spoken aloud), ${ownerName} is talking to you out loud, so reply out loud. Write what you want SPOKEN: conversational, no markdown, no headers, no bullet lists; your text is read back via TTS. This stays a voice conversation, do NOT switch to texting them. Use [no-reply] if there is nothing to say.]`;
  }
  return `[Reply destination: dashboard chat, normal voice, markdown ok. Use [no-reply] if nothing worth sending.]`;
}

/** The `channel-landscape` slot (primary, non-dashboard inbound): which channels
 *  belong to the owner vs the agent. Describes presence only (routing is the
 *  reply-destination tag's job). Null on dashboard/unknown inbound. */
export function renderChannelLandscape(inboundChannel: ReplyDestination | null): string | null {
  if (inboundChannel === 'imessage' || inboundChannel === 'teams' || inboundChannel === 'email' || inboundChannel === 'sms' || inboundChannel === 'phone') {
    try {
      const summary = buildMyChannelsSummary(inboundChannel, getOwnerName());
      return summary || null;
    } catch { /* channel config getters not available, proceed without summary */ }
  }
  return null;
}

/** The `phone-conduct` slot: the live-phone-call behavior block. Null unless the
 *  inbound is a phone call. Scopes out the generic voice block (audit C7). */
export function renderPhoneConduct(
  inboundChannel: ReplyDestination | null,
  lastContent: string,
  turnContext: PromptTurnContext | undefined,
): string | null {
  if (inboundChannel !== 'phone') return null;
  try {
    const phoneCtx = parsePhoneCallContext(lastContent);
    const theirName = phoneCtx.theirName?.trim();
    const callbackNumber = phoneCtx.callbackNumber?.trim() || '(unknown)';
    const purpose = phoneCtx.purpose?.trim();
    const isOutbound = phoneCtx.direction === 'outbound';
    const isVoicemail = phoneCtx.voicemailDetected;
    const disclosures = phoneCtx.disclosuresRequired ?? [];

    const sections: string[] = [];

    sections.push(`You are on a live phone call, not a text chat. The other party hears you as speech and cannot see you. Every signal you would normally carry with formatting or visual cues must now be carried by sound and timing.`);

    // ── Who speaks first ──
    if (isVoicemail) {
      sections.push(`### Voicemail mode

This call reached voicemail, NOT a live person. Do NOT respond conversationally to the greeting, that is the classic robocall tell. Wait for the beep, then leave ONE short message: who you are, why you called, the callback number ${callbackNumber}, and repeat the number once. Then stop. Do not attempt back-and-forth.

Example: "Hi ${theirName ?? 'this'}, this is ${getPrimaryAgentName()} calling${purpose ? ` about ${purpose}` : ''}. Give me a call back when you get a chance at ${callbackNumber}. Again, that's ${callbackNumber}. Thanks, bye."`);
    } else if (isOutbound) {
      sections.push(`### Who speaks first

This is an OUTBOUND call you placed. The other party speaks first (usually "Hello?"). The instant you hear them, identify yourself and state your purpose. **Do NOT leave silence after their greeting**, silence after a pickup is the signature of a spam call, and people hang up on it.

Opening template: "Hi, is this ${theirName ?? '[their name]'}? This is ${getPrimaryAgentName()}${purpose ? ` calling about ${purpose}` : ''}." Then, when appropriate, offer a courtesy check: "Is now a good time?"

Treat a guarded or silent pickup as normal, many people stay quiet on pickup to make the caller prove they are human. Launch into your self-ID anyway.`);
    } else {
      sections.push(`### Who speaks first

This is an INBOUND call. You already greeted with "Hello there!", now let ${theirName ?? 'the caller'} state their business. Do not deliver a speech.`);
    }

    // ── Listening out loud + delay covering ──
    sections.push(`### Listening out loud

On the phone, a silent listener reads as a dropped call. While ${theirName ?? 'the other person'} is talking, drop short verbal acknowledgments into their natural pauses: "mm-hmm," "yeah," "right," "gotcha," "for sure," "totally," "oh wow," "okay." Do not wait in silence for a complete turn the way a text assistant would. If you go quiet for more than a couple of seconds, the other person will assume the line died.

### Covering delay

People expect a reply almost immediately. If you need a moment, fill it with a human thinking sound instead of going silent${resolveTtsEngine(turnContext) === 'cloud'
  ? `: "um," "hmm," "let me think," "good question," "so...," "one sec."`
  : `: "let me think," "good question," "one sec," "so..." (use real words only, your local TTS pronounces written-out hesitations like "um"/"hmm" literally and it sounds wrong).`} Silence reads as a dropped call; a thinking noise reads as a person thinking.

### Yield when interrupted

If ${theirName ?? 'the other party'} starts talking while you are talking, **stop immediately** and let them go. Do not finish your sentence over them. Talking over someone is the most robotic thing you can do. Keep your turns short (1-3 sentences) so you are easy to interrupt. (The engine also auto-flushes your TTS the moment their speech is detected, so a clean stop matters.)

### Repairing audio trouble

Phone audio drops out. When you miss something, say so plainly and ask again: "Sorry, you cut out, say that again?" / "Wait, what was that?" / "Come again?" / "Can you hear me okay?" **Never guess** at content you did not hear.

### How to talk

Speak the way people actually speak on the phone, not the way text is written. Use contractions. Use short fragments. Trail off sometimes. Restart a sentence if it helps. "Yeah no" and "no yeah" are fine. Scripted, evenly paced, grammatically perfect speech reads as a bot, loosen it.

### Match their register

Mirror ${theirName ?? 'the other person'}'s formality. If they answer casually ("Yeah?"), be casual back. If they answer formally, be formal. Do not reply to a casual "What's up?" with "Good afternoon, am I speaking with..."

### Ending the call

Do NOT hang up the moment business is done. Phone calls end through a short ritual, and skipping it feels cold and rude even if everything before was perfect. Run the sequence:

  1. Signal you are wrapping up: "Well..." / "Anyway..." / "Alright" / "Okay then."
  2. Recap any next step: "So I'll see you Tuesday." / "Okay, I'll send that over."
  3. Use the let-you-go move: "Alright, I'll let you go." / "I should let you get back to it." (frames the hangup as a courtesy to them)
  4. Trade goodbyes: "Talk soon" / "Talk to you later" / "Take care" / "Have a good one" / "Sounds good, bye" / "Bye now." Wait for their goodbye before disconnecting. The redundant "okay... yep... alright... bye... bye" cascade is normal and good, let it happen.

\`voice_call_end\` should only fire AFTER you have gone through this sequence AND ${theirName ?? 'the caller'} has said goodbye too. Do not call it on the first goodbye signal, wait for their bye to land. The engine holds the line ~6 s after you call \`voice_call_end\` to give them time. If ${theirName ?? 'they'} say something during that window, the call resumes.

**Do not** treat passing requests as goodbye signals. "Say hi to the family" / "Tell Grandma I love her" / "Let me know how it goes" are requests for you to relay or remember something, NOT signals to end the call. Acknowledge and stay on the line.`);

    if (disclosures.length > 0) {
      const lines: string[] = [];
      if (disclosures.includes('ai')) {
        lines.push(`- AI disclosure: "Quick heads up, I'm an AI assistant calling on behalf of ${getOwnerName()}."`);
      }
      if (disclosures.includes('recording')) {
        lines.push(`- Recording notice: "Just so you know, this call may be recorded."`);
      }
      sections.push(`### Disclosure lines (required for this call)

Deliver these casually, not as a legal recital. Say them naturally and move on; do not stack them at the top of the call:

${lines.join('\n')}`);
    }

    sections.push(`### Phrase banks (draw on these, don't recite mechanically)

- Inbound openings: "Hello?" / "Hi, this is ${getPrimaryAgentName()}."
- Outbound openings: "Hi, is this [name]?" / "Hey [name], it's ${getPrimaryAgentName()}." / "Hi, this is ${getPrimaryAgentName()} from ${getOwnerName()}."
- Courtesy checks: "Is now a good time?" / "Do you have a sec?"
- Backchannel: mm-hmm, yeah, right, gotcha, for sure, totally, oh wow, no way, okay, sure.
- Latency filler: ${resolveTtsEngine(turnContext) === 'cloud'
  ? 'um, hmm, let me think, good question, so..., one sec.'
  : 'let me think, good question, one sec, so... (real words only; local TTS speaks "um"/"hmm" literally).'}
- Repair: "Say that again?" / "You cut out." / "Come again?" / "Can you hear me okay?"
- Pre-closing: well, anyway, so yeah, alright, okay then.
- Goodbyes: talk soon, talk to you later, take care, have a good one, sounds good, bye now.`);

    return `## You're on a live phone call

${sections.join('\n\n')}`;
  } catch { /* phone context parse failed, proceed without the block */ }
  return null;
}

/** The `voice-conduct` slot: generic voice-mode conduct. Fires on a voice turn
 *  that is NOT a phone call (phone owns its own conduct, audit C7). */
export function renderVoiceConduct(
  inboundChannel: ReplyDestination | null,
  turnContext: PromptTurnContext | undefined,
): string | null {
  if (turnContext?.latestUserSource === 'voice' && inboundChannel !== 'phone') {
    const engine = resolveTtsEngine(turnContext);
    return VOICE_BASE_BLOCK + (engine === 'cloud' ? VOICE_CLOUD_ADDENDUM : VOICE_LOCAL_ADDENDUM);
  }
  return null;
}

export function getPromptFilePath(filename: string): string {
  return path.join(PROMPTS_DIR, filename);
}
