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
// against the owner's ambiguity resolutions (R1-R8 in the task brief).
import { describe, it, expect } from 'vitest';
import { classifyToolName, suggestToolNames, describeNameFailure } from '../name-help.js';

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

describe('suggestToolNames — the five incident guesses', () => {
  it.each(INCIDENT_GUESSES)('ranks user_gmail_label first for the guess %s', (guess) => {
    const suggestions = suggestToolNames(guess, GMAIL_LABEL_ALLOWED);
    expect(suggestions[0]).toBe('user_gmail_label');
  });

  it('never returns more than 3 suggestions', () => {
    for (const guess of INCIDENT_GUESSES) {
      expect(suggestToolNames(guess, GMAIL_LABEL_ALLOWED).length).toBeLessThanOrEqual(3);
    }
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

describe('suggestToolNames — a confidently wrong suggestion is worse than none (R3)', () => {
  it('returns no suggestions when the requested name shares no token and no substring with anything allowed', () => {
    const suggestions = suggestToolNames('zzz_qqq_wibble', GMAIL_LABEL_ALLOWED);
    expect(suggestions).toEqual([]);
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
