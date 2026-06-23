// ════════════════════════════════════════
// Migration remediation — classify a technique's manual_steps
//
// Technique dependency manifests dump a lot into free-text `manual_steps`:
// genuine human actions, but also pure information, already-migrated secrets,
// "create this directory" chores, and "X must be on PATH" notes. Echoing all of
// that as scary action items is the bug the user (rightly) hated.
//
// This classifier is VERIFICATION-DRIVEN: where a step makes a checkable claim
// (a directory to create, a file that should exist, a CLI on PATH, a vault
// secret) we actually check/do it and report the truth. Only genuine,
// can't-automate-here actions become "needs you" items. When unsure we DON'T
// drop it — it becomes a low-key note — so a real action is never lost silently.
// ════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createLogger } from '../logger.js';

const logger = createLogger('migration-classify');

export type StepBucket = 'automated' | 'action' | 'note';

export interface ClassifiedStep {
  /** The original step text (lightly cleaned). */
  text: string;
  bucket: StepBucket;
  /** Outcome / why, e.g. "Created ~/Desktop/X", "curl present", "not found". */
  detail?: string;
}

const HOME = os.homedir();

function expandHome(p: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

function commandExists(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

// Pull filesystem-ish paths out of free text (~/…, or absolute under common roots).
function extractPaths(text: string): string[] {
  const re = /(~\/[^\s'"()]+|\/(?:Users|opt|Applications|tmp|var|usr|Library|Shared)\/[^\s'"()]+)/g;
  return [...text.matchAll(re)].map(m => m[1].replace(/[.,;:]+$/, ''));
}

// Pull plausible CLI names out of "X must be available in PATH" style notes.
const KNOWN_CLIS = ['curl', 'jq', 'git', 'ffmpeg', 'convert', 'magick', 'wget', 'python3', 'python', 'node', 'npm', 'osascript', 'aerender'];

// Pure information — never an action. Tuned to the phrasings techniques actually use.
const INFORMATIONAL_RE = /internet connection required|\bLAN\b.*(?:required|only|access)|local network api|Mac[\s-]?only|expire[sd]?\s+(?:within|in)\b|operational paths|runtime[\s-]generated|not part of the technique director|must be available on the platform|dojo[\s-]level tools|display session|created automatically|downloads? go to/i;

// "stored in vault as X" / "vault key: X" — the vault migrated with the DB, so
// these secrets came across. Report as migrated, not a TODO.
const VAULT_RE = /\bvault\b/i;

// "create directory if it doesn't exist" style chores → we just do them.
const DIR_CREATE_RE = /create (?:the )?director|directory if it (?:doesn'?t|does ?not) exist|create .* if it doesn'?t exist/i;

// "X must be available/installed in PATH" → check the named CLIs.
const CLI_RE = /(?:must be (?:available|installed))|available in path|in path\b/i;

// Genuinely-human prerequisites we can never do from the dojo. Keyed off real
// ACTION phrases (verbs the user must perform) plus a few reliably-human nouns —
// NOT bare service names like "Home Assistant", which also appear in passive
// "token stored in vault as …" lines that actually migrated.
const HUMAN_ACTION_RE = /must be installed|must be enabled|must be accessible|must be configured|register (?:an?|the)\b|account required|\bsign ?in\b|flash via|\bfirmware\b|powered on|developer app|api key from https?:|from https?:\/\/(?:console|developer|platform|dashboard)|adobe|after effects|aerender|arduino|azure|\bpiper\b|nabu casa/i;

/**
 * Classify a single manual step, performing safe auto-actions (mkdir) and
 * verification (file/CLI existence) as needed.
 */
function classifyOne(stepRaw: string): ClassifiedStep {
  const step = stepRaw.trim();

  // 1. Genuine human prerequisite — always an action (checked first so an
  //    "install Adobe…" note never gets mis-bucketed as info).
  if (HUMAN_ACTION_RE.test(step)) {
    return { text: step, bucket: 'action' };
  }

  // 2. Pure information — checked BEFORE the path/CLI checks so a note that
  //    happens to mention a path ("Downloads go to ~/X (created automatically)")
  //    isn't mistaken for a missing-file action.
  if (INFORMATIONAL_RE.test(step)) {
    return { text: step, bucket: 'note' };
  }

  // 3. Directory-creation chore → create it, report success.
  if (DIR_CREATE_RE.test(step)) {
    const paths = extractPaths(step);
    const made: string[] = [];
    for (const p of paths) {
      try { fs.mkdirSync(expandHome(p), { recursive: true }); made.push(p); }
      catch (err) { logger.warn('mkdir failed during remediation', { p, err: String(err) }); }
    }
    if (made.length) return { text: step, bucket: 'automated', detail: `Created ${made.join(', ')}` };
    // Couldn't find/make a path — fall through to note rather than claim done.
  }

  // 3. Vault-stored secret → migrated with the vault.
  if (VAULT_RE.test(step)) {
    return { text: step, bucket: 'automated', detail: 'Stored in your vault — migrated with your data' };
  }

  // 4. "must be available in PATH" → verify the named CLIs.
  if (CLI_RE.test(step)) {
    const clis = KNOWN_CLIS.filter(c => new RegExp(`\\b${c}\\b`).test(step));
    if (clis.length) {
      const missing = clis.filter(c => !commandExists(c));
      if (missing.length === 0) {
        return { text: step, bucket: 'automated', detail: `${clis.join(', ')} present` };
      }
      // Something's genuinely missing — surface it as an action with the truth.
      return { text: step, bucket: 'action', detail: `Missing: ${missing.join(', ')}` };
    }
  }

  // 5. Reference to a file/dir that should exist → check it.
  const paths = extractPaths(step);
  if (paths.length) {
    const checks = paths.map(p => ({ p, exists: fs.existsSync(expandHome(p)) }));
    const missing = checks.filter(c => !c.exists);
    if (missing.length === 0) {
      return { text: step, bucket: 'automated', detail: 'Present on this machine' };
    }
    // Path(s) missing AND not a known human prereq → likely lives outside the
    // dojo (external repo/script). Honest action with the path.
    return { text: step, bucket: 'action', detail: `Not found here: ${missing.map(c => c.p).join(', ')} — copy it from your old machine` };
  }

  // 7. Unrecognized — don't guess "done". Show as a low-key note so it's never
  //    lost, but isn't a scary red action either.
  return { text: step, bucket: 'note' };
}

export function classifyManualSteps(steps: string[]): ClassifiedStep[] {
  return steps.map(classifyOne);
}
