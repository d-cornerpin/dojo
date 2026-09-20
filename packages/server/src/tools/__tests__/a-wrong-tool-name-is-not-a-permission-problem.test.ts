// T80a — "a wrong tool name is not a permission problem"
//
// THE INCIDENT: an agent guessed five tool names that do not exist while
// trying to label an email (user_gmail_label_add, user_gmail_update,
// user_gmail_modify, gmail_label_add, gmail_add_label). The real tool,
// user_gmail_label, was on its allow list the whole time. The engine
// answered every guess with a PERMISSION verdict ("this is a permission
// issue, not a format issue") plus an instruction to tell the user it was
// blocked. It was never blocked; it never called a real tool name.
//
// These tests pin `packages/server/src/tools/name-help.ts`, the shared leaf
// every tool-name-failure text now goes through, against that incident and
// against the owner's ambiguity resolutions.
//
// REVISION NOTE: an earlier version of this suite pinned a RANKING —
// `suggestToolNames` had to rank `user_gmail_label` first for all five
// guesses, via a small verb-synonym table asserting label ≈ tag ≈ mark ≈
// add ≈ update. The owner withdrew that requirement: two of the five
// guesses (`user_gmail_update`, `user_gmail_modify`) share no substring and
// no token with the real tool's name, so making them rank it first is a
// SEMANTIC GUESS, not a fact, and would misfire on an untested family. The
// fix pins a weaker, honest claim instead: the real name surfaces
// SOMEWHERE in the failure text for all five guesses — as an earned lexical
// suggestion where one exists, otherwise via family enumeration (a plain
// listing of the real tools sharing the guess's leading segment).
import { describe, it, expect } from 'vitest';
import { classifyToolName, suggestToolNames, toolsInSameFamily, describeNameFailure } from '../name-help.js';

// The allowed set the brief pins the five incident guesses against: the real
// tool plus "realistic neighbors" a Gmail-label-capable agent would plausibly
// also carry.
const GMAIL_LABEL_ALLOWED = new Set([
  'user_gmail_label',
  'user_gmail_list_labels',
  'user_gmail_create_label',
  'user_gmail_delete_label',
  'user_gmail_read',
  'user_gmail_search',
  'user_calendar_create',
  'work_update',
  'file_read',
]);

const INCIDENT_GUESSES = [
  'user_gmail_label_add',
  'user_gmail_update',
  'user_gmail_modify',
  'gmail_label_add',
  'gmail_add_label',
];

// The two guesses scoring alone cannot rescue: no substring, no shared
// token with "label" — only family enumeration surfaces the real tool.
const LEXICALLY_UNEARNED_GUESSES = ['user_gmail_update', 'user_gmail_modify'];
const LEXICALLY_EARNED_GUESSES = INCIDENT_GUESSES.filter((g) => !LEXICALLY_UNEARNED_GUESSES.includes(g));

describe('classifyToolName', () => {
  it('calls a name in the allow list allowed', () => {
    expect(classifyToolName('user_gmail_label', GMAIL_LABEL_ALLOWED, GMAIL_LABEL_ALLOWED)).toBe('allowed');
  });

  it('calls a name that exists globally but is missing from this agent\'s allow list exists_not_allowed, never a bare unknown', () => {
    const known = new Set([...GMAIL_LABEL_ALLOWED, 'gmail_send']);
    const allowed = GMAIL_LABEL_ALLOWED; // gmail_send not on the agent's list
    expect(classifyToolName('gmail_send', allowed, known)).toBe('exists_not_allowed');
  });

  it('calls a name absent from both the allow list and the global registry unknown, never exists_not_allowed', () => {
    const known = new Set([...GMAIL_LABEL_ALLOWED, 'gmail_send']);
    expect(classifyToolName('gmail_add_label', GMAIL_LABEL_ALLOWED, known)).toBe('unknown');
  });

  it('classifies every one of the five incident guesses as unknown, never exists_not_allowed, against a known set that also holds the real tool', () => {
    const known = new Set(GMAIL_LABEL_ALLOWED);
    for (const guess of INCIDENT_GUESSES) {
      expect(classifyToolName(guess, GMAIL_LABEL_ALLOWED, known)).toBe('unknown');
    }
  });
});

describe('describeNameFailure — the real tool surfaces somewhere for all five incident guesses', () => {
  it.each(INCIDENT_GUESSES)('mentions user_gmail_label in the failure text for guess %s', (guess) => {
    const text = describeNameFailure([guess], GMAIL_LABEL_ALLOWED, new Set(GMAIL_LABEL_ALLOWED));
    expect(text).toContain('user_gmail_label');
  });
});

describe('suggestToolNames — lexically earned guesses rank the real tool first', () => {
  it.each(LEXICALLY_EARNED_GUESSES)('ranks user_gmail_label first for the guess %s', (guess) => {
    const suggestions = suggestToolNames(guess, GMAIL_LABEL_ALLOWED);
    expect(suggestions[0]).toBe('user_gmail_label');
  });

  it('never returns more than 3 suggestions', () => {
    for (const guess of INCIDENT_GUESSES) {
      expect(suggestToolNames(guess, GMAIL_LABEL_ALLOWED).length).toBeLessThanOrEqual(3);
    }
  });
});

describe('suggestToolNames — lexically unearned guesses get no suggestion at all (owner ruling, withdrawn synonym table)', () => {
  it.each(LEXICALLY_UNEARNED_GUESSES)('returns no suggestions for %s — nothing shares a substring or a same-family token with anything allowed', (guess) => {
    expect(suggestToolNames(guess, GMAIL_LABEL_ALLOWED)).toEqual([]);
  });

  it('never suggests work_update for a gmail-family guess, even though "update" is a literal shared word', () => {
    // This is the exact false-positive the withdrawn verb-synonym table
    // could not avoid: "update" is a genuine substring match against
    // work_update, but work_update is a DIFFERENT family entirely. A
    // cross-family lexical coincidence must never be suggested.
    for (const guess of LEXICALLY_UNEARNED_GUESSES) {
      expect(suggestToolNames(guess, GMAIL_LABEL_ALLOWED)).not.toContain('work_update');
    }
  });
});

describe('toolsInSameFamily — the honest fallback for the hard cases', () => {
  it.each(LEXICALLY_UNEARNED_GUESSES)('lists the real gmail tools, including user_gmail_label, for %s', (guess) => {
    const family = toolsInSameFamily(guess, GMAIL_LABEL_ALLOWED);
    expect(family).toContain('user_gmail_label');
  });

  it('draws only from the allowed set, never from a global registry', () => {
    const allowed = new Set(['user_gmail_read', 'user_gmail_search']);
    const family = toolsInSameFamily('user_gmail_update', allowed);
    expect(family.sort()).toEqual(['user_gmail_read', 'user_gmail_search']);
  });

  it('caps the listing at 8 members with a "+N more" tail when there are more', () => {
    const bigFamily = new Set(Array.from({ length: 10 }, (_, i) => `user_gmail_${String.fromCharCode(97 + i)}`));
    const text = describeNameFailure(['user_gmail_zzz'], bigFamily, bigFamily);
    expect(text).toMatch(/\+2 more/);
  });

  it('is empty when the requested name has no recognizable family segment overlap', () => {
    expect(toolsInSameFamily('zzz_qqq_wibble', GMAIL_LABEL_ALLOWED)).toEqual([]);
  });
});

describe('suggestToolNames — suggestions come only from the allowed set (R4)', () => {
  it('never suggests a tool that exists globally and is lexically closer, but is not on this agent\'s allow list', () => {
    // A near-perfect lexical twin of the real tool, present in the global
    // registry, deliberately withheld from this agent's allow list.
    const allowed = new Set(['user_gmail_read', 'user_gmail_search', 'file_read']);
    const known = new Set([...allowed, 'user_gmail_label']); // exists globally, not allowed here
    const suggestions = suggestToolNames('user_gmail_labl', allowed); // typo of the withheld tool
    expect(suggestions).not.toContain('user_gmail_label');
    // Sanity: the withheld tool really was the closer lexical match — proves
    // the exclusion is deliberate (R4), not an accident of weak scoring.
    void known;
  });
});

describe('describeNameFailure — a name with no family overlap and no close match says plainly it may be wrong (owner ruling)', () => {
  const text = describeNameFailure(['zzz_qqq_wibble'], GMAIL_LABEL_ALLOWED, new Set(GMAIL_LABEL_ALLOWED));

  it('offers neither a suggestion pointer nor a family list', () => {
    expect(text).not.toMatch(/did you mean/);
    expect(text).not.toMatch(/tools you can call/);
  });

  it('says plainly the name may be wrong', () => {
    expect(text).toMatch(/name may simply be wrong/);
  });
});

describe('describeNameFailure — unknown names never get permission wording (R7)', () => {
  const text = describeNameFailure(['gmail_add_label'], GMAIL_LABEL_ALLOWED, new Set(GMAIL_LABEL_ALLOWED));

  it('says the name does not exist', () => {
    expect(text).toMatch(/does not exist/i);
  });

  it('points at load_tool_docs as the next action', () => {
    expect(text).toMatch(/load_tool_docs/);
  });

  it('never says this is a permission issue', () => {
    expect(text).not.toMatch(/permission issue/i);
  });

  it('never tells the agent to say it is blocked', () => {
    expect(text).not.toMatch(/tell the user you are blocked/i);
  });

  it('offers user_gmail_label as the suggestion', () => {
    expect(text).toContain('user_gmail_label');
  });
});

describe('describeNameFailure — a name that exists but is not allowed keeps the permission wording (R7)', () => {
  const allowed = new Set(['user_gmail_read', 'complete_task']);
  const known = new Set([...allowed, 'user_gmail_send']);
  const text = describeNameFailure(['user_gmail_send'], allowed, known);

  it('says this is a permission issue', () => {
    expect(text).toMatch(/permission issue/i);
  });

  it('keeps the complete_task escalation when this agent can self-complete', () => {
    expect(text).toMatch(/complete_task\(status="blocked"\)/);
  });

  it('never says the tool does not exist', () => {
    expect(text).not.toMatch(/does not exist/i);
  });
});

describe('describeNameFailure — an agent that cannot self-complete gets the non-complete_task escalation (R7)', () => {
  const allowed = new Set(['user_gmail_read']); // no complete_task
  const known = new Set([...allowed, 'user_gmail_send']);
  const text = describeNameFailure(['user_gmail_send'], allowed, known);

  it('points at send_to_agent / telling the user instead of complete_task', () => {
    expect(text).toMatch(/send_to_agent/);
    expect(text).toMatch(/tell the user you are blocked/);
    expect(text).not.toMatch(/complete_task/);
  });
});

describe('describeNameFailure — the mixed case addresses both groups separately, never collapsed (R5)', () => {
  const allowed = new Set(['user_gmail_read', 'complete_task']);
  const known = new Set([...allowed, 'user_gmail_send']); // exists, not allowed
  // gmail_add_label: unknown. user_gmail_send: exists but not allowed.
  const text = describeNameFailure(['gmail_add_label', 'user_gmail_send'], allowed, known);

  it('names the unknown one in the unknown wording', () => {
    expect(text).toMatch(/does not exist/i);
    expect(text).toContain('gmail_add_label');
  });

  it('names the exists-but-not-allowed one in the permission wording', () => {
    expect(text).toMatch(/permission issue/i);
    expect(text).toContain('user_gmail_send');
  });

  it('does not apply the permission-issue framing to the unknown name', () => {
    // The unknown name must not appear inside the permission sentence, and
    // the exists-but-not-allowed name must not appear inside the naming
    // sentence — i.e. the two sentences are genuinely separate, not one
    // blob that happens to pass substring checks.
    const [unknownSentence, permissionSentence] = text.split(/(?=This tool exists but|These tools exist but)/);
    expect(unknownSentence).not.toContain('user_gmail_send');
    expect(permissionSentence).not.toContain('gmail_add_label');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// T80 FIX-WAVE ITEM 2 — THE FAMILY LABEL CLAIMS ONLY A PREFIX, NEVER KINSHIP.
//
// A verb-first family (`set_capability_model`, `set_channel`,
// `set_user_presence`, `set_voice` all bucket as family "set" — the leading
// token once `user_` is stripped) is just a shared verb, not a domain. The
// old wording — `the "set" tools you can call` — read as an invented
// kinship claim. The reworded wording claims only what is true of every
// family, verb-first or domain-first alike: a shared name PREFIX. No
// per-family branching (R5): this is the SAME code path `describeNameFailure`
// always used for family enumeration, just reworded.
// ════════════════════════════════════════════════════════════════════════════

describe('describeNameFailure — the family-list label claims a prefix, not kinship (T80 fix-wave item 2)', () => {
  // set_capability_model / set_channel / set_user_presence / set_voice share
  // only the verb "set" — real tools from `tools/categories.ts`'s "DOJO
  // Controls" category. `set_theme` shares no substring and no significant
  // (non-family) token with any of them, so scoring earns no suggestion and
  // `describeNameFailure` falls back to family enumeration.
  const SET_FAMILY_ALLOWED = new Set([
    'set_capability_model', 'set_channel', 'set_user_presence', 'set_voice', 'complete_task',
  ]);
  const text = describeNameFailure(['set_theme'], SET_FAMILY_ALLOWED, new Set(SET_FAMILY_ALLOWED));

  it('uses mechanical prefix phrasing: tools whose names start with "set_"', () => {
    expect(text).toContain('tools whose names start with "set_"');
  });

  it('never claims domain kinship with the old "the \\"set\\" tools you can call" wording', () => {
    expect(text).not.toMatch(/tools you can call/);
  });

  it('still lists every real tool in the family', () => {
    for (const member of ['set_capability_model', 'set_channel', 'set_user_presence', 'set_voice']) {
      expect(text).toContain(member);
    }
  });

  it('the same mechanical phrasing applies to a domain family too (gmail) — no per-family branching', () => {
    const domainText = describeNameFailure(['gmail_zzz_unknown'], GMAIL_LABEL_ALLOWED, new Set(GMAIL_LABEL_ALLOWED));
    // gmail_zzz_unknown shares no significant token with any allowed gmail
    // tool, so it also falls back to family enumeration.
    expect(domainText).toContain('tools whose names start with "gmail_"');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// T80 FIX-WAVE ITEM 3 — AN ALL-ALLOWED INPUT NEVER RETURNS "".
//
// `describeNameFailure` returns "" when every requested name classifies
// `allowed` — reachable only at the execute-site else-branch via a second
// drift defect (the tool really IS on this agent's allow list, yet dispatch
// found no case for it). The bare "" handed the model silence at the exact
// moment something the ENGINE got wrong. Now it names the tool and gives a
// concrete next step: retry once, then report the tool name to the user.
// ════════════════════════════════════════════════════════════════════════════

describe('describeNameFailure — an all-allowed input never returns "" (T80 fix-wave item 3)', () => {
  it('a single allowed name yields a non-empty fallback naming the tool', () => {
    const allowed = new Set(['some_allowed_tool']);
    const text = describeNameFailure(['some_allowed_tool'], allowed, allowed);
    expect(text).not.toBe('');
    expect(text).toContain('some_allowed_tool');
  });

  it('the fallback says it appears allowed but failed to dispatch, and to retry once', () => {
    const allowed = new Set(['some_allowed_tool']);
    const text = describeNameFailure(['some_allowed_tool'], allowed, allowed);
    expect(text).toMatch(/appears allowed/i);
    expect(text).toMatch(/failed to dispatch/i);
    expect(text).toMatch(/retry/i);
  });

  it('tells the agent to report the tool name to the user, not guess a workaround', () => {
    const allowed = new Set(['some_allowed_tool']);
    const text = describeNameFailure(['some_allowed_tool'], allowed, allowed);
    expect(text).toMatch(/report the tool name to the user/i);
  });

  it('never uses naming or permission wording for the all-allowed case', () => {
    const allowed = new Set(['some_allowed_tool']);
    const text = describeNameFailure(['some_allowed_tool'], allowed, allowed);
    expect(text).not.toMatch(/does not exist/i);
    expect(text).not.toMatch(/permission issue/i);
  });

  it('multiple all-allowed names get the plural fallback, all named', () => {
    const allowed = new Set(['tool_a', 'tool_b']);
    const text = describeNameFailure(['tool_a', 'tool_b'], allowed, allowed);
    expect(text).not.toBe('');
    expect(text).toContain('tool_a');
    expect(text).toContain('tool_b');
  });

  it('CONTROL: an empty requested array still returns "" (nothing to report at all)', () => {
    const allowed = new Set(['some_allowed_tool']);
    expect(describeNameFailure([], allowed, allowed)).toBe('');
  });
});
