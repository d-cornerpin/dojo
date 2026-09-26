// T80b — "the index names the tools the agent can actually call"
//
// THE INCIDENT: an agent granted user-account-only access (the most
// restrictive default — the common case for a brand new agent) called
// generateToolIndex and got shown an index where the ENTIRE Gmail/Google/
// Microsoft family had vanished — `tools/categories.ts` filtered each
// category's canonical names against the agent's toolMap and dropped the
// category the instant that filter came back empty, even though the agent
// held every one of the family's `user_`-prefixed twins. The trailing
// summary sentence then told the agent "every Gmail / Google / Microsoft
// tool above also has a `user_`-prefixed twin" — when nothing was above.
// The agent invented tool names, failed, and told its owner it was blocked.
// It was never blocked; the real names were sitting in its toolMap the
// whole time, just never printed.
//
// This suite pins the fix: `generateToolIndex`'s per-category rendering now
// SUBSTITUTES the `user_` twin for a withheld canonical name instead of
// dropping the slot, so the index always names what the agent can actually
// call. Structured in four parts:
//   1. THE CACHE GATE (PRESERVE 3(a)) — a full-access agent's index must be
//      byte-identical to pre-T80b output. Non-negotiable; if this moves the
//      substitution leaked into the held-canonical path.
//   2. THE SUBSTITUTION BEHAVIOR — user-slot-only renders the family instead
//      of hiding it, in declared category/name order, and a mixed map shows
//      canonical where held / user_ where not, within the SAME category.
//   3. THE REWORDED SUMMARY SENTENCE — the "every ... tool above" claim is
//      only true when nothing above was substituted; once a category falls
//      back to a user_ name the sentence must stop claiming that.
//   4. THE R6 COMPLETENESS INVARIANT — the reason this is a fix and not a
//      Gmail patch: across representative tool maps, EVERY tool name the
//      agent holds appears literally somewhere in the generated index.
//
// NOTE ON name-help.ts (T80a, sibling task): that module's family/lexical
// helpers (`toolsInSameFamily`, `familyOf`, etc.) score NAME GUESSES against
// an allow list. This task needs neither scoring nor guessing — the
// substitution here is a literal, unconditional `user_${canonical}` string
// check against toolMap, and the "is this uncategorized user_ tool a mirror
// or an orphan" check is a literal membership test against the category
// registry itself (categories.ts's own data). There is no second
// family/normalization helper introduced here; the one general-purpose leaf
// this task needed (isMirroredUserVariant) lives inline in categories.ts
// next to the registry it reads, same pattern as tool-list-conformance's
// isRealTool.
import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '../../agent/tools/types.js';
import { generateToolIndex, TOOL_CATEGORIES } from '../categories.js';

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    input_schema: { type: 'object', properties: {}, required: [] },
    effects: [],
  };
}

function makeTools(names: string[]): ToolDefinition[] {
  return names.map(makeTool);
}

/** R6 helper: every tool name in `tools` must appear literally, backtick-
 * wrapped exactly as the renderer emits it, somewhere in `index`. A
 * set-difference assertion, not a spot check — prints every missing name at
 * once rather than failing on the first. */
function assertEveryNameAppearsLiterally(tools: ToolDefinition[], index: string): void {
  const missing = tools
    .map(t => t.name)
    .filter(name => !index.includes(`\`${name}\``));
  expect(missing, `tool name(s) held by this agent but absent from the generated index: ${missing.join(', ')}`).toEqual([]);
}

// ════════════════════════════════════════════════════════════════════════
// PART 1 — THE CACHE GATE (PRESERVE 3(a), non-negotiable)
//
// ALL_ACCESS_MIRRORED models a full-access agent: every canonical name in
// several categories PLUS the `user_` twin of every Gmail/Calendar tool
// (the shape of the golden agent `kevin`, who holds google/microsoft
// {agent:"full", user:"full"}). Because every canonical is held, the
// substitution loop's ELSE branch never fires for this map — the fixed
// text below was captured by running the PRE-T80b renderer against this
// exact fixture, before categories.ts was touched. If this test ever fails,
// the substitution leaked into the held-canonical path; fix the code, do
// NOT update this string, exactly as the release golden
// (dojo-test-kit/checks/golden/cache-prefix.kevin.txt) must never be
// re-blessed for this task.
// ════════════════════════════════════════════════════════════════════════

const GMAIL_ALL = ['gmail_search', 'gmail_read', 'gmail_inbox', 'gmail_send', 'gmail_reply', 'gmail_forward', 'gmail_draft', 'gmail_label', 'gmail_list_labels', 'gmail_create_label', 'gmail_delete_label', 'gmail_list_attachments', 'gmail_read_attachment'];
const CALENDAR_ALL = ['calendar_agenda', 'calendar_search', 'calendar_list', 'calendar_create', 'calendar_update', 'calendar_delete', 'calendar_respond_invite', 'calendar_subscribe', 'calendar_unsubscribe', 'calendar_freebusy'];

const ALL_ACCESS_MIRRORED_NAMES = [
  'load_tool_docs',
  'file_read', 'file_list', 'exec',
  'web_search', 'web_fetch',
  ...GMAIL_ALL,
  ...GMAIL_ALL.map(n => `user_${n}`),
  ...CALENDAR_ALL,
  ...CALENDAR_ALL.map(n => `user_${n}`),
  'list_agents', 'spawn_agent',
];
const ALWAYS_LOADED_MIRRORED = ['load_tool_docs', 'file_read'];

// Captured verbatim from the UNMODIFIED pre-T80b generateToolIndex against
// ALL_ACCESS_MIRRORED_NAMES / ALWAYS_LOADED_MIRRORED (via a throwaway tsx
// script run against the working tree before categories.ts was edited, then
// JSON.stringify'd so this literal is byte-exact — including the single
// trailing newline — with no risk of a hand-retyped mismatch).
const PRE_T80B_OUTPUT = "## Available Tools\n\nTools listed below by category. Always-loaded tools are callable immediately; for any other tool, call `load_tool_docs` first to get the full schema.\n**Before defaulting to `exec`**, scan the index below for a purpose-built tool that fits the task, file/web/office/forms/tracker/vault/chat-recall all have dedicated tools. **If you feel disoriented or have just been compacted/model-switched**, call `recall_recent_thread` first. **When sharing a URL or file path with the user**: paste the literal string from the most recent tool result, ONCE, surrounded by spaces. Never wrap a URL in backticks (the closing tick gets sucked into the href and breaks the link). Never write the same URL twice in a row. Never paraphrase, truncate, or type a URL from memory, if you don't have the full string, call the source tool again.\n\n**Always-loaded tools**: load_tool_docs, file_read\n\n**Meta:** `load_tool_docs`\n\n**File & System:** `file_read`, `file_list`, `exec`\n\n**Web:** `web_search`, `web_fetch`\n\n**Managing Other Agents:** `list_agents`, `spawn_agent`\n\n**Gmail:** `gmail_search`, `gmail_read`, `gmail_inbox`, `gmail_send`, `gmail_reply`, `gmail_forward`, `gmail_draft`, `gmail_label`, `gmail_list_labels`, `gmail_create_label`, `gmail_delete_label`, `gmail_list_attachments`, `gmail_read_attachment`\n\n**Google Calendar:** `calendar_agenda`, `calendar_search`, `calendar_list`, `calendar_create`, `calendar_update`, `calendar_delete`, `calendar_respond_invite`, `calendar_subscribe`, `calendar_unsubscribe`, `calendar_freebusy`\n\n**User-account variants (23):** every Gmail / Google / Microsoft tool above also has a `user_`-prefixed twin (e.g. `user_gmail_send`, `user_calendar_create`, `user_outlook_inbox`) that acts on the OWNER's personal account instead of your agent account. Call `load_tool_docs` on the `user_` name exactly as you would the base tool.\n";

describe('PART 1 — the cache gate: a full-access agent gets byte-identical output', () => {
  it('THE CACHE GATE: renders ALL_ACCESS_MIRRORED byte-identically to the captured pre-T80b output', () => {
    const output = generateToolIndex(makeTools(ALL_ACCESS_MIRRORED_NAMES), ALWAYS_LOADED_MIRRORED);
    expect(output).toBe(PRE_T80B_OUTPUT);
  });

  it('a full-access agent never triggers the reworded sentence — the old wording is exact and unconditional here', () => {
    const output = generateToolIndex(makeTools(ALL_ACCESS_MIRRORED_NAMES), ALWAYS_LOADED_MIRRORED);
    expect(output).toContain('every Gmail / Google / Microsoft tool above also has a `user_`-prefixed twin');
  });
});

// ════════════════════════════════════════════════════════════════════════
// PART 2 — THE SUBSTITUTION BEHAVIOR
// ════════════════════════════════════════════════════════════════════════

describe('PART 2 — substitution: user-slot-only renders the family, in declared order', () => {
  // Deliberately scrambled input order (label before search, calendar before
  // gmail) to prove the rendered order comes from TOOL_CATEGORIES' declared
  // order, never from toolMap/array iteration order.
  const USER_SLOT_ONLY_SCRAMBLED = makeTools([
    'user_gmail_label',
    'user_calendar_create',
    'user_gmail_send',
    'file_read',
    'user_gmail_inbox',
    'load_tool_docs',
    'user_gmail_search',
    'user_gmail_read',
  ]);
  const output = generateToolIndex(USER_SLOT_ONLY_SCRAMBLED, ['load_tool_docs']);

  it('renders user_gmail_label under a Gmail line and does not hide the family (THE INCIDENT)', () => {
    expect(output).toMatch(/\*\*Gmail:\*\*/);
    expect(output).toContain('`user_gmail_label`');
  });

  it('renders every held Gmail user_ tool in the category\'s DECLARED order (search, read, inbox, send, label) — not input order', () => {
    const gmailLine = output.split('\n').find(l => l.startsWith('**Gmail:**'));
    expect(gmailLine).toBeDefined();
    expect(gmailLine).toBe('**Gmail:** `user_gmail_search`, `user_gmail_read`, `user_gmail_inbox`, `user_gmail_send`, `user_gmail_label`');
  });

  it('renders the lone held Calendar tool under its category line too', () => {
    expect(output).toContain('**Google Calendar:** `user_calendar_create`');
  });

  it('never falls back to canonical names that are not actually held', () => {
    for (const canonical of ['gmail_search', 'gmail_read', 'gmail_send', 'gmail_label', 'calendar_create']) {
      expect(output).not.toContain(`\`${canonical}\``);
    }
  });

  it('leaves nothing unaccounted for — no leftover "User-account variants" sentence, because everything held was substituted into a category line', () => {
    expect(output).not.toContain('User-account variants');
  });
});

describe('PART 2 — substitution: a mixed map shows canonical where held and user_ where not, WITHIN the same category', () => {
  const MIXED = makeTools([
    'load_tool_docs',
    'gmail_search', // canonical held
    'gmail_read', // canonical held
    'user_gmail_send', // only the user_ twin held
    'user_gmail_label', // only the user_ twin held
  ]);
  const output = generateToolIndex(MIXED, ['load_tool_docs']);

  it('interleaves canonical and user_ names on the same Gmail line, in declared order', () => {
    expect(output).toContain('**Gmail:** `gmail_search`, `gmail_read`, `user_gmail_send`, `user_gmail_label`');
  });
});

// ════════════════════════════════════════════════════════════════════════
// PART 3 — THE REWORDED SUMMARY SENTENCE
//
// PRESERVE 3(a) locks the UNSUBSTITUTED wording exactly (Part 1). This part
// pins the other side: the instant a category had to fall back to a user_
// name, the "every ... tool above" claim is no longer true for that family,
// and the sentence must say something that stays true instead — including
// for the leftover MIRRORED tools case (an agent holding BOTH forms of one
// tool while a DIFFERENT category was substituted).
// ════════════════════════════════════════════════════════════════════════

describe('PART 3 — the summary sentence stops claiming "above" once a family was rendered as user_ names', () => {
  const MIRROR_PLUS_SUBSTITUTION = makeTools([
    'load_tool_docs',
    'gmail_inbox', // canonical held
    'user_gmail_inbox', // ALSO held — a genuine mirror, leftover after gmail_inbox wins the slot
    'user_calendar_create', // only the user_ twin held — forces a substitution elsewhere
  ]);
  const output = generateToolIndex(MIRROR_PLUS_SUBSTITUTION, ['load_tool_docs']);

  it('still shows the canonical name for the mirrored tool', () => {
    expect(output).toContain('**Gmail:** `gmail_inbox`');
  });

  it('substitutes the user_ twin for the category that had no canonical held', () => {
    expect(output).toContain('**Google Calendar:** `user_calendar_create`');
  });

  it('reports exactly the one leftover mirrored tool', () => {
    expect(output).toMatch(/\*\*User-account variants \(1\):\*\*/);
  });

  it('does NOT use the old blanket "every ... tool above" wording once a substitution happened', () => {
    expect(output).not.toContain('every Gmail / Google / Microsoft tool above also has a `user_`-prefixed twin');
  });

  it('the reworded sentence is still true: it scopes the claim to categories that show a canonical name above', () => {
    expect(output).toMatch(/where a category above shows a canonical name/);
  });
});

describe('PART 3 — a pure user-slot-only world needs no summary sentence at all (vacuously true, not falsely worded)', () => {
  it('emits nothing about "User-account variants" when nothing was left unaccounted for', () => {
    const output = generateToolIndex(makeTools(['load_tool_docs', 'user_gmail_search', 'user_gmail_label']), ['load_tool_docs']);
    expect(output).not.toContain('User-account variants');
  });
});

// ════════════════════════════════════════════════════════════════════════
// PART 4 — THE R6 COMPLETENESS INVARIANT
//
// This is the reason the plan is a FIX and not a Gmail patch: over at least
// four representative tool maps, EVERY tool name the agent holds must
// appear literally in the generated index. One deliberately-planted
// uncategorized `user_`-prefixed tool (no matching category anywhere) is
// included to prove the invariant actually bites — delete the ORPHANED
// branch in categories.ts (the `isMirroredUserVariant` split) and this
// specific case is the one that goes back to being swallowed by the old
// pattern sentence with no literal trace.
//
// NOTE ON THE ONE INTENTIONAL EXCEPTION: a tool held in BOTH its canonical
// and user_ form (a genuine mirror — PRESERVE 3(a)'s golden case) is
// reported by the pattern sentence, not listed literally by name. That
// exception is locked by Part 1's byte-identity test, so none of the four
// maps below construct a both-forms-held pair; each base tool name appears
// in at most one form, which is exactly the shape of every map that
// actually goes wrong in production (an agent either has the canonical
// or the user_ twin for a given operation, essentially never a redundant
// pair on top of a restrictive grant).
// ════════════════════════════════════════════════════════════════════════

const ALL_ACCESS_PRIMARY = makeTools([
  'load_tool_docs', 'file_read', 'file_write', 'exec',
  'web_search', 'web_fetch',
  'canvas_render', 'image_create', 'pdf_read',
  'contact_remember', 'credential_list', 'vault_remember', 'recall_recent_thread',
  'work_open', 'work_update', 'squad_share',
  'list_agents', 'spawn_agent', 'complete_task',
  'save_technique', 'show_to_user', 'set_user_presence', 'cost_summary', 'healer_log_action', 'tunnel',
  'email_search',
  'gmail_search', 'gmail_send',
  'calendar_create',
  'drive_list', 'tasks_list', 'slides_create_presentation', 'forms_create_form',
  'outlook_read', 'sms_send', 'contacts_search', 'calendar_agenda_ms',
  'onedrive_list', 'onenote_list_notebooks', 'sharepoint_list_sites',
  'online_meeting_create', 'teams_read_messages', 'office_create_word_document',
  'plaud_list_recordings',
]);

const USER_SLOT_ONLY = makeTools([
  'load_tool_docs', 'file_read',
  'user_gmail_search', 'user_gmail_read', 'user_gmail_inbox', 'user_gmail_send', 'user_gmail_label',
  'user_calendar_create', 'user_calendar_agenda',
]);

// A genuinely orphaned uncategorized tool: `zzz_totally_uncategorized_ping`
// is not a member of any TOOL_CATEGORIES list, so its user_ twin below has
// no canonical sibling anywhere — it must fall into the literal `Other`
// bucket, not the pattern-summary sentence.
const MIXED = makeTools([
  'load_tool_docs', 'file_read',
  'gmail_search', 'gmail_read', // canonical held
  'user_gmail_send', 'user_gmail_label', // user_ twin held, no canonical
  'user_zzz_totally_uncategorized_ping', // PLANTED ORPHAN — proves the invariant bites
  'totally_made_up_non_user_tool', // plain uncategorized control, unrelated to user_ handling
]);

const MINIMAL_SUB_AGENT = makeTools(['load_tool_docs', 'file_read', 'work_open', 'work_update', 'complete_task']);

const R6_MAPS: Array<[string, ToolDefinition[]]> = [
  ['all-access primary', ALL_ACCESS_PRIMARY],
  ['user-slot-only (the incident shape)', USER_SLOT_ONLY],
  ['mixed, with a planted uncategorized user_ orphan', MIXED],
  ['minimal sub-agent', MINIMAL_SUB_AGENT],
];

describe('PART 4 — R6 completeness invariant: every held tool name appears literally in the index', () => {
  for (const [label, tools] of R6_MAPS) {
    it(`${label}: no tool name is missing from the generated index (set-difference, not a spot check)`, () => {
      const output = generateToolIndex(tools, ['load_tool_docs']);
      assertEveryNameAppearsLiterally(tools, output);
    });
  }

  it('THE PLANTED ORPHAN specifically: user_zzz_totally_uncategorized_ping is named in an Other line, not swallowed by the pattern sentence', () => {
    const output = generateToolIndex(MIXED, ['load_tool_docs']);
    expect(output).toContain('**Other:** `user_zzz_totally_uncategorized_ping`, `totally_made_up_non_user_tool`');
  });

  it('CONTROL — deleting the orphan/mirror split would make the invariant bite: an orphan swallowed by the old pattern-only bucket would NOT be named literally', () => {
    // Reproduces the OLD (pre-T80b) bucketing rule inline: every uncategorized
    // user_-prefixed tool, mirror or orphan alike, folds into one pattern
    // sentence with no literal name. Asserts that under THAT rule the planted
    // orphan is genuinely absent — proving assertEveryNameAppearsLiterally
    // actually discriminates the fixed behavior from the broken one, rather
    // than passing either way.
    const oldStyleUserVariants = MIXED.filter(t => t.name.startsWith('user_') && !['user_gmail_send', 'user_gmail_label'].includes(t.name));
    const oldStyleOutput = oldStyleUserVariants.length > 0
      ? `**User-account variants (${oldStyleUserVariants.length}):** every Gmail / Google / Microsoft tool above also has a \`user_\`-prefixed twin (e.g. \`user_gmail_send\`, \`user_calendar_create\`, \`user_outlook_inbox\`) that acts on the OWNER's personal account instead of your agent account.`
      : '';
    expect(oldStyleOutput).not.toContain('`user_zzz_totally_uncategorized_ping`');
  });

  it('sanity: the registry categories actually used above are non-empty (guards against an empty TOOL_CATEGORIES import)', () => {
    expect(TOOL_CATEGORIES.length).toBeGreaterThan(10);
  });
});

// ════════════════════════════════════════════════════════════════════════
// PART 5 — THE ONE ANNOTATED ENTRY (DOJO-REPORT T8, owner-approved).
//
// THE MEASURED DEFECT. The T8 live run handed a floor-model agent the owner's
// own designed phrase — "That wasn't right. Why did that happen? Let's get this
// fixed in the Dojo." — and it did not reach for `dojo_report`. It investigated
// its own grants, delegated to a peer to ask for a permission, was refused, and
// burned the turn; pointed at the tool by a human it then ran gather → draft →
// submit perfectly. The cause is a seam, not a bug: ALL of the trigger language
// lives in the DESCRIPTION, which sits behind `load_tool_docs`, so at the moment
// of deciding the agent's only cue was the bare name on this index line.
//
// THE FIX IS ONE PHRASE, AND THIS PART HOLDS BOTH HALVES OF IT:
//   * the annotation is PRESENT and says what the tool is FOR, in the words a
//     user would use — the same standard the description's own trigger pins are
//     held to in `agent/tools/__tests__/the-report-tool-cannot-post.test.ts`;
//   * the annotation is the ONLY one. The index is names-only by design and the
//     tokens are the reason; a second entry must be a deliberate argued edit
//     with its own golden re-record, never a habit this suite waved through.
//
// ⚠ AND A THIRD HALF, WHICH IS WHY THIS IS NOT MERELY A `toContain`: an agent
// that does NOT hold `dojo_report` must get a byte-identical line to before.
// PART 1's cache gate already proves that for the full-access fixture (which
// holds `load_tool_docs` alone in Meta) — this part states it as the rule.
// ════════════════════════════════════════════════════════════════════════

/** What the annotation has to convey, each with the reason it is load-bearing. */
const INDEX_NOTE_ANCHORS: readonly [string, string][] = [
  ['it is a REPORT, not a diagnosis or a fix', 'report'],
  ['the subject is the DOJO ITSELF — the discriminator the live run got wrong', 'the Dojo itself'],
  ['a PROBLEM, the word a user reaches for before "bug" or "issue"', 'problem'],
  ['...and WHO receives it, which is what makes filing it the answer', 'the people who build it'],
];

describe('PART 5 — the index says what `dojo_report` is for, not just that it exists', () => {
  const META_HOLDER = makeTools(['load_tool_docs', 'dojo_report', 'file_read']);

  it('annotates the entry — a bare name is what the live run failed on', () => {
    const output = generateToolIndex(META_HOLDER, ['load_tool_docs']);
    const meta = output.split('\n').find(l => l.startsWith('**Meta:**'));
    expect(meta, 'no Meta line in the index — this part is blind').toBeTruthy();
    expect(meta, 'the Meta line lists `dojo_report` as a bare name again, which is the exact '
      + 'state the T8 live run failed in: at decision time the agent has no cue what it is for')
      .not.toBe('**Meta:** `load_tool_docs`, `dojo_report`');
    for (const [why, phrase] of INDEX_NOTE_ANCHORS) {
      expect(meta, `the index annotation no longer says: ${phrase} (${why})`).toContain(phrase);
    }
    // The name itself is still literally present, backtick-wrapped — R6's instrument
    // reads exactly that, so the annotation may not replace the name with prose.
    expect(meta).toContain('`dojo_report`');
    assertEveryNameAppearsLiterally(META_HOLDER, output);
  });

  it('annotates NOTHING else — the index is names-only and the tokens are the reason', () => {
    const output = generateToolIndex(ALL_ACCESS_PRIMARY, ['load_tool_docs']);
    // Every category line's entries, flattened. A parenthesis immediately after a
    // backticked name is an annotation; there must be no such thing here, because
    // ALL_ACCESS_PRIMARY does not hold `dojo_report`.
    const categoryLines = output.split('\n').filter(l => /^\*\*[^*]+:\*\* `/.test(l));
    expect(categoryLines.length, 'no category lines were rendered — this clause is blind')
      .toBeGreaterThan(5);
    for (const line of categoryLines) {
      expect(line, `an unannounced annotation appeared on: ${line.slice(0, 60)}`)
        .not.toMatch(/` \(/);
    }
  });

  it('an agent WITHOUT the tool gets the line it got before — the annotation rides the NAME', () => {
    // The cache-prefix consequence, stated as a rule rather than left to PART 1's
    // fixture: the annotation is attached to a tool, so withholding the tool
    // withholds the phrase. A note keyed on the CATEGORY would have widened every
    // agent's cached prefix, including the ones that cannot call the tool.
    const without = generateToolIndex(makeTools(['load_tool_docs', 'file_read']), ['load_tool_docs']);
    expect(without).toContain('**Meta:** `load_tool_docs`\n');
    expect(without).not.toContain('the Dojo itself');
  });
});
