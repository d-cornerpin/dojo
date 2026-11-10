// What the report card may say and send. Consent-gating rules live here so the server suite tests them.

import { GITHUB_EXPECTED_SCOPE } from './github-card';

/** The five fields, named exactly as the server's `ReportBrief` is, so an edit needs no remap. */
export interface BriefFields {
  title: string; whatHappened: string; whatShouldHaveHappened: string;
  whyItWentWrong: string; fixIdeas: string;
}
export type BriefEdits = Partial<BriefFields>;

const BRIEF_KEYS: ReadonlyArray<keyof BriefFields> = [
  'title', 'whatHappened', 'whatShouldHaveHappened', 'whyItWentWrong', 'fixIdeas',
];

// Only fields whose raw string moved are sent: an untouched field is never mentioned, no trim.
export function briefEditsFor(original: BriefFields, edited: BriefFields): BriefEdits {
  const edits: BriefEdits = {};
  for (const key of BRIEF_KEYS) {
    if (edited[key] !== original[key]) edits[key] = edited[key];
  }
  return edits;
}

export function briefIsPostable(b: BriefFields): { ok: true } | { ok: false; reason: string } {
  for (const key of BRIEF_KEYS) {
    if (b[key].trim() === '') return { ok: false, reason: `\`${key}\` is empty, fill it in or cancel.` };
  }
  return { ok: true };
}

/** What the card is told when the tracker already carries this signature. */
export interface DuplicateMatch { number: number; url: string; title: string }

// A question, not a statement: it names the issue so the owner can check it before agreeing.
export function duplicateQuestion(match: DuplicateMatch): string {
  const title = match.title.trim();
  const named = title === '' ? `issue #${match.number}` : `#${match.number} “${title}”`;
  return `Someone has already reported this, ${named}. Add your details to that issue instead, `
    + 'or post a separate one?';
}

export interface PostTarget {
  connected: boolean; login: string | null; loginInProgress: boolean;
  /** `owner/name`, as the server's `reportRepo()` resolved it. `''` = the box has not said yet. */
  repo: string;
}

// Reads connected, not the card state: the route posts from the token even mid sign-in.
export function postTargetSentence(s: PostTarget): string {
  const slug = s.repo.trim();
  // An empty slug is "not said yet"; substituting a default repo would guess a destination.
  const where = slug === '' ? 'the Dojo\'s issue tracker' : `the GitHub repository ${slug}`;
  if (!s.connected) {
    return 'GitHub isn\'t connected, so this will be saved as a file on this Mac with a link '
      + `you can paste into a new issue on ${where} yourself. Nothing is sent.`;
  }
  const who = (s.login ?? '').trim();
  const asWho = who === '' ? 'the GitHub account connected to this Mac' : who;
  return `This will be posted as a public issue on ${where}, as ${asWho}. Anyone can read it.`;
}

// Read from the same constant the server pins, so it changes when the asked scope changes.
export function connectOfferSentence(): string {
  if (GITHUB_EXPECTED_SCOPE === 'public_repo') {
    return 'Connect GitHub and this report is filed for you, with nothing to copy. The Dojo asks for '
      + 'GitHub\'s "public_repo" permission. GitHub has no narrower permission for this kind of sign-in: '
      + 'it lets the Dojo create issues on public repositories, and it also covers changing your own '
      + 'public repositories. The Dojo only uses it to file reports and cannot read your private '
      + 'repositories. You can disconnect any time in Settings.';
  }
  return `Connect GitHub and this report is filed for you, with nothing to copy. The Dojo asks GitHub for "${GITHUB_EXPECTED_SCOPE}". `
    + 'Check what that permission allows before you connect.';
}
