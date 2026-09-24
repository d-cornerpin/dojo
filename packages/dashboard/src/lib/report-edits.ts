// ════════════════════════════════════════════════════════════════════════════════════════
// WHAT THE REPORT PREVIEW CARD IS ALLOWED TO SAY, AND WHAT IT IS ALLOWED TO SEND.
//
// ── WHY THIS IS NOT IN `ReportPreviewCard.tsx` ──
// `packages/dashboard` has NO test runner, so a rule inside a `.tsx` is a rule nothing checks.
// The precedent is `lib/provider-edits.ts` (T66b) and `lib/github-card.ts` (T5), both imported
// directly by `packages/server`'s suite. The rules here are the ones where being wrong is a
// BROKEN CONSENT GATE rather than a cosmetic slip, which is this module's whole test for what
// belongs in it.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The five fields, named exactly as the server's `ReportBrief` is, so an edit needs no remap. */
export interface BriefFields {
  title: string; whatHappened: string; whatShouldHaveHappened: string;
  whyItWentWrong: string; fixIdeas: string;
}
export type BriefEdits = Partial<BriefFields>;

const BRIEF_KEYS: ReadonlyArray<keyof BriefFields> = [
  'title', 'whatHappened', 'whatShouldHaveHappened', 'whyItWentWrong', 'fixIdeas',
];

/**
 * T66b's anti-trap: *"a field the user did not touch is NEVER MENTIONED in any request."*
 *
 * A key is PRESENT only when that field actually moved; absent means "this door is not asked
 * about it at all". Compared with `!==` on the raw strings — no trim, no normalisation — because
 * D4 says the posted text is the text the owner read, and a whitespace change IS a change they
 * made deliberately.
 */
export function briefEditsFor(original: BriefFields, edited: BriefFields): BriefEdits {
  const edits: BriefEdits = {};
  for (const key of BRIEF_KEYS) {
    if (edited[key] !== original[key]) edits[key] = edited[key];
  }
  return edits;
}

/**
 * Nobody may be asked to approve nothing. The server refuses an empty field too (`.min(1)`), so
 * this exists to give the owner a sentence instead of a 400 — and it names the field, because
 * "invalid" in front of five textareas is a puzzle rather than an instruction.
 */
export function briefIsPostable(b: BriefFields): { ok: true } | { ok: false; reason: string } {
  for (const key of BRIEF_KEYS) {
    if (b[key].trim() === '') return { ok: false, reason: `\`${key}\` is empty — fill it in or cancel.` };
  }
  return { ok: true };
}

/** What the door tells the card when the tracker already carries this signature (T7). */
export interface DuplicateMatch { number: number; url: string; title: string }

/**
 * THE SECOND CONSENT SENTENCE, and it is a QUESTION rather than a statement.
 *
 * The platform found an open issue carrying this report's signature and posted NOTHING. The
 * owner now chooses, and the sentence has to make both options honest: adding to the existing
 * thread publishes their words on someone else's issue, and posting separately files a second
 * one. It names the issue by NUMBER AND TITLE so the choice can be checked before it is made —
 * a bare "we found a duplicate" asks somebody to agree to a page they have not seen.
 */
export function duplicateQuestion(match: DuplicateMatch): string {
  const title = match.title.trim();
  const named = title === '' ? `issue #${match.number}` : `#${match.number} “${title}”`;
  return `Someone has already reported this — ${named}. Add your details to that issue instead, `
    + 'or post a separate one?';
}

/** The fields of the served `GithubStatus` this decision reads. Declared structurally, never
 *  imported: pulling in `lib/api.ts` would drag `fetch` and the auth token into a module the
 *  server's vitest imports directly. A real `githubStatus()` result satisfies it. */
export interface PostTarget { connected: boolean; login: string | null; loginInProgress: boolean }

/**
 * THE MOST LOAD-BEARING SENTENCE IN THE FEATURE. D4: the user sees the exact text, and knows
 * exactly where it goes, BEFORE anything posts.
 *
 * ⚠ IT READS `connected`, AND DELIBERATELY NOT `githubCardState`. T5's four-state precedence
 * answers a different question — "which of four cards to draw" — and there `connecting` OUTRANKS
 * `connected`, which is right for a Settings card. Here the question is "will pressing Post
 * publish, or write a file?", and the route answers that from the TOKEN. A card that re-derived
 * this from `githubCardState` would promise *"nothing is sent"* at the exact moment the route
 * publishes a public issue, because a sign-in can be open on top of a live connection. That is
 * the consent gate stating the opposite of what happens. `loginInProgress` is in the shape above
 * so that its IRRELEVANCE here is visible rather than forgotten.
 */
export function postTargetSentence(s: PostTarget): string {
  if (!s.connected) {
    return 'GitHub isn\'t connected, so this will be saved as a file on this Mac with a link '
      + 'you can paste into an issue yourself. Nothing is sent.';
  }
  const who = (s.login ?? '').trim();
  // A missing NAME is never a missing connection (T4: `GET /user` is called once and not
  // retried). Printing `as null` would be the shape of bug this exists to make impossible.
  const asWho = who === '' ? 'the GitHub account connected to this Mac' : who;
  return `This will be posted as a public issue on the Dojo's issue tracker, as ${asWho}. `
    + 'Anyone can read it.';
}
