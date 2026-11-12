// Classify a technique's free-text manual_steps. Verification-driven: a checkable claim (a directory, a
// file, a CLI on PATH, a vault secret) is checked or done, and only genuine human actions become "needs
// you" items. An unsure step becomes a low-key note, so a real action is never lost silently.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createLogger } from '../logger.js';
import { homeDir } from '../home.js';

const logger = createLogger('migration-classify');

export type StepBucket = 'automated' | 'action' | 'note';

export interface ClassifiedStep {
  text: string;
  bucket: StepBucket;
  detail?: string;
}

const HOME = homeDir();

function expandHome(p: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

function commandExists(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

function extractPaths(text: string): string[] {
  const re = /(~\/[^\s'"()]+|\/(?:Users|opt|Applications|tmp|var|usr|Library|Shared)\/[^\s'"()]+)/g;
  return [...text.matchAll(re)].map(m => m[1].replace(/[.,;:]+$/, ''));
}

const KNOWN_CLIS = ['curl', 'jq', 'git', 'ffmpeg', 'convert', 'magick', 'wget', 'python3', 'python', 'node', 'npm', 'osascript', 'aerender'];

// Pure information, never an action. Tuned to the phrasings techniques actually use.
const INFORMATIONAL_RE = /internet connection required|\bLAN\b.*(?:required|only|access)|local network api|Mac[\s-]?only|expire[sd]?\s+(?:within|in)\b|operational paths|runtime[\s-]generated|not part of the technique director|must be available on the platform|dojo[\s-]level tools|display session|created automatically|downloads? go to/i;

// "stored in vault as X": the vault migrated with the DB, so report it as migrated.
const VAULT_RE = /\bvault\b/i;

const DIR_CREATE_RE = /create (?:the )?director|directory if it (?:doesn'?t|does ?not) exist|create .* if it doesn'?t exist/i;

const CLI_RE = /(?:must be (?:available|installed))|available in path|in path\b/i;

// Genuine human prerequisites, keyed off ACTION verbs plus a few reliably-human nouns, not bare service
// names ("Home Assistant" also appears in passive vault lines that actually migrated).
const HUMAN_ACTION_RE = /must be installed|must be enabled|must be accessible|must be configured|register (?:an?|the)\b|account required|\bsign ?in\b|flash via|\bfirmware\b|powered on|developer app|api key from https?:|from https?:\/\/(?:console|developer|platform|dashboard)|adobe|after effects|aerender|arduino|azure|\bpiper\b|nabu casa/i;

function classifyOne(stepRaw: string): ClassifiedStep {
  const step = stepRaw.trim();

  // Human prerequisites first, so an "install Adobe" note is never bucketed as info.
  if (HUMAN_ACTION_RE.test(step)) {
    return { text: step, bucket: 'action' };
  }

  // Pure information before the path/CLI checks, so a note that mentions a path stays a note.
  if (INFORMATIONAL_RE.test(step)) {
    return { text: step, bucket: 'note' };
  }

  if (DIR_CREATE_RE.test(step)) {
    const paths = extractPaths(step);
    const made: string[] = [];
    for (const p of paths) {
      try { fs.mkdirSync(expandHome(p), { recursive: true }); made.push(p); }
      catch (err) { logger.warn('mkdir failed during remediation', { p, err: String(err) }); }
    }
    if (made.length) return { text: step, bucket: 'automated', detail: `Created ${made.join(', ')}` };
    // No path found or made: fall through to a note rather than claim done.
  }

  if (VAULT_RE.test(step)) {
    return { text: step, bucket: 'automated', detail: 'Stored in your vault — migrated with your data' };
  }

  if (CLI_RE.test(step)) {
    const clis = KNOWN_CLIS.filter(c => new RegExp(`\\b${c}\\b`).test(step));
    if (clis.length) {
      const missing = clis.filter(c => !commandExists(c));
      if (missing.length === 0) {
        return { text: step, bucket: 'automated', detail: `${clis.join(', ')} present` };
      }
      // Genuinely missing: surface it as an action with the truth.
      return { text: step, bucket: 'action', detail: `Missing: ${missing.join(', ')}` };
    }
  }

  const paths = extractPaths(step);
  if (paths.length) {
    const checks = paths.map(p => ({ p, exists: fs.existsSync(expandHome(p)) }));
    const missing = checks.filter(c => !c.exists);
    if (missing.length === 0) {
      return { text: step, bucket: 'automated', detail: 'Present on this machine' };
    }
    // Missing paths that are not a known human prerequisite likely live outside the dojo: an action.
    return { text: step, bucket: 'action', detail: `Not found here: ${missing.map(c => c.p).join(', ')} — copy it from your old machine` };
  }

  // Unrecognized: never guess "done"; a low-key note so it is never lost.
  return { text: step, bucket: 'note' };
}

export function classifyManualSteps(steps: string[]): ClassifiedStep[] {
  return steps.map(classifyOne);
}
