// t113 G (t109 hand-up 3, ruled by the orchestrator from the owner's standing honest-UI rules)
// — A WINDOW THAT CANNOT HOLD A CONVERSATION SAYS SO, TO THE PERSON AND NOT ONLY TO THE LOG.
//
// ── THE STATE, MEASURED, AND WHY THE EXISTING REFUSAL WAS NOT THE WHOLE ANSWER ──
//
// `budget.ts`'s `assertSystemPromptFits` throws when an agent's system prompt is bigger than
// everything its model's window has left after the tool-and-output reserve. The refusal is
// right, it has always been loud, and t109 §D deliberately kept it rather than adding a second
// log line beside it.
//
// It was loud in the LOG. t109 measured the box this actually happens on: a 16K window carries a
// tool-and-output reserve of about 14,605 tokens, which leaves an assembly budget near 755
// against a system prompt of roughly 6,093 — so no message can be admitted at all. The person
// whose agent that is sees an agent that answers with no memory of anything, and nothing
// anywhere tells them why or what to change. t109 handed the card up because "may the platform
// nag someone about a box they chose" is a policy question, not a worker's.
//
// The reserve scaling t109 built fixes the small-window-with-a-MODEST-surface case. This is the
// residual it names: a small window with the WHOLE tool surface. The scaling is NOT a claim that
// a 16K box with every tool enabled holds a conversation — it does not, and this card is how the
// person finds that out.
//
// ── WHAT THIS FILE PINS, IN BOTH DIRECTIONS ──
//
// §1  the card fires on the starved state, once per OUTAGE and not once per turn
// §2  it clears when the configuration changes, so a LATER outage cards again
// §3  the words: the two repairs the person owns, nothing destructive, no false promise
// §4  the refusal itself is UNCHANGED — the card is additive, and the throw still happens
// §5  the wire: the assembler calls both halves, at the one site that knows (G4)
//
// The direction that matters most is §1's second half and §2: a card per turn is how a person
// learns to ignore cards, and a card that never clears is a card that only ever fires once per
// process — so the two are the same clause asked twice.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The channel, captured rather than mocked away: the point of the item is that the person is
// told, so what reaches `broadcast` IS the subject.
const sent: Array<Record<string, unknown>> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (ev: Record<string, unknown>) => { sent.push(ev); },
}));

import { contextWindowPolicy, assertSystemPromptFits, SystemPromptTooLargeError } from '../budget.js';
import {
  reportStarvedWindow, noteWindowHolds, windowIsStarved, starvedWindowCardText,
  __resetStarvedWindowsForTests,
} from '../window-starvation-card.js';

const AGENT = 'g-starved-agent';
const SRC = path.join(__dirname, '..', '..');

/** Comments blanked, length kept, so prose about a call is never read as the call (G4). */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

// ── THE MEASURED BOX, carried verbatim from t109 §D so the numbers stay comparable ──
// A 16K window with the whole tool surface. The reserve is what eats it.
const STARVED_POLICY = contextWindowPolicy(16_000, { toolPayloadTokens: 13_000, maxOutputTokens: 4_096 });
const SYSTEM_PROMPT_TOKENS = 6_093;

// And a box that is fine, as the control: the same prompt in a window that holds it.
const HEALTHY_POLICY = contextWindowPolicy(200_000, { toolPayloadTokens: 13_000, maxOutputTokens: 4_096 });

beforeEach(() => {
  sent.length = 0;
  __resetStarvedWindowsForTests();
});

describe('a window that cannot hold a conversation says so', () => {
  // ── §0 THE FIXTURE IS THE STATE IT CLAIMS TO BE ──
  // Without this, every clause below could be testing a healthy box and passing for the wrong
  // reason. The numbers are asserted as a RELATIONSHIP, not as magic constants, so a change to
  // the reserve formula reds here with a readable reason instead of silently neutering the file.
  it('the fixture really is starved, and the healthy control really is not', () => {
    expect(STARVED_POLICY.assemblyBudgetTokens, 'a 16K box with the whole surface has almost nothing left')
      .toBeLessThan(SYSTEM_PROMPT_TOKENS);
    expect(STARVED_POLICY.toolAndOutputReserve, 'and the reserve is what took it')
      .toBeGreaterThan(Math.floor(STARVED_POLICY.compactionThreshold * STARVED_POLICY.contextWindow) / 2);
    expect(HEALTHY_POLICY.assemblyBudgetTokens, 'the control holds the same prompt with room over')
      .toBeGreaterThan(SYSTEM_PROMPT_TOKENS);
    // the engine's own verdict on each, so this file and `budget.ts` cannot disagree
    expect(() => assertSystemPromptFits(SYSTEM_PROMPT_TOKENS, STARVED_POLICY)).toThrow(SystemPromptTooLargeError);
    expect(() => assertSystemPromptFits(SYSTEM_PROMPT_TOKENS, HEALTHY_POLICY)).not.toThrow();
  });

  // ── §1 THE CARD FIRES, AND FIRES ONCE ──
  it('cards the person on the starved state', () => {
    expect(reportStarvedWindow(AGENT, SYSTEM_PROMPT_TOKENS, STARVED_POLICY), 'this call is the one that carded').toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'chat:error',
      agentId: AGENT,
      code: 'WINDOW_TOO_SMALL',
      severity: 'error',
      retryable: false,
    });
    expect(windowIsStarved(AGENT)).toBe(true);
  });

  it('ONE OUTAGE, ONE CARD — assembly runs every turn, and a toast per turn is a toast nobody reads', () => {
    for (let turn = 0; turn < 12; turn++) reportStarvedWindow(AGENT, SYSTEM_PROMPT_TOKENS, STARVED_POLICY);
    expect(sent, 'twelve turns, one card').toHaveLength(1);
  });

  it('and the SECOND call says it did not card, so a caller can tell new from continuing', () => {
    expect(reportStarvedWindow(AGENT, SYSTEM_PROMPT_TOKENS, STARVED_POLICY)).toBe(true);
    expect(reportStarvedWindow(AGENT, SYSTEM_PROMPT_TOKENS, STARVED_POLICY)).toBe(false);
  });

  it('two different agents are two different outages', () => {
    reportStarvedWindow(AGENT, SYSTEM_PROMPT_TOKENS, STARVED_POLICY);
    reportStarvedWindow('another-agent', SYSTEM_PROMPT_TOKENS, STARVED_POLICY);
    expect(sent).toHaveLength(2);
    expect(sent.map((e) => e.agentId)).toEqual([AGENT, 'another-agent']);
  });

  // ── §2 IT CLEARS, WHICH IS WHAT MAKES "ONCE PER OUTAGE" MEAN PER OUTAGE ──
  it('a later outage cards AGAIN once the configuration has changed in between', () => {
    reportStarvedWindow(AGENT, SYSTEM_PROMPT_TOKENS, STARVED_POLICY);
    expect(sent).toHaveLength(1);

    // somebody shortened the tool list, or moved the agent to a bigger model
    noteWindowHolds(AGENT);
    expect(windowIsStarved(AGENT), 'the note is gone').toBe(false);
    expect(sent, 'and recovering is not itself a card').toHaveLength(1);

    // and then it was changed back, or a new tool was enabled
    expect(reportStarvedWindow(AGENT, SYSTEM_PROMPT_TOKENS, STARVED_POLICY), 'a NEW outage').toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('a fit on an agent that was never starved does nothing at all', () => {
    noteWindowHolds('never-starved');
    expect(sent).toHaveLength(0);
    expect(windowIsStarved('never-starved')).toBe(false);
  });

  // ── §3 THE WORDS. The person has to be able to act on them. ──
  it('names the two repairs the person actually owns', () => {
    const text = starvedWindowCardText(STARVED_POLICY);
    expect(text, 'a shorter tool list').toMatch(/shorter tool list/);
    expect(text, 'or a bigger window').toMatch(/bigger context window/);
  });

  it('never asks anyone to destroy memory to make room — the instruction the owner abolished', () => {
    const text = starvedWindowCardText(STARVED_POLICY);
    expect(text).toMatch(/nothing here needs deleting/i);
    expect(text, 'no archive, no reset, no wipe, no "your memory is full"')
      .not.toMatch(/archiv|reset|delete your|clear your|wipe|memory is full/i);
  });

  it('makes NO promise that it recovers on its own, because it does not', () => {
    const text = starvedWindowCardText(STARVED_POLICY);
    expect(text).toMatch(/will not start working on its own/i);
    // the compaction card's sentence, which is true THERE and would be a lie here
    expect(text).not.toMatch(/resumes by itself|resumes on its own/i);
    // and the flag the dashboard reads agrees with the sentence
    reportStarvedWindow(AGENT, SYSTEM_PROMPT_TOKENS, STARVED_POLICY);
    expect(sent[0].retryable, 'a true here would promise a recovery that cannot happen').toBe(false);
  });

  it('leads with the cause that is actually the bigger share of the window', () => {
    // reserve-dominated: the tools took the window, so say tools
    expect(starvedWindowCardText(STARVED_POLICY)).toMatch(/tools it has been given take up more/);
    // prompt-dominated: a roomy reserve and a window too small for the instructions themselves.
    // Sending this person to trim tools would aim them at the wrong thing.
    const promptDominated = contextWindowPolicy(8_000, { toolPayloadTokens: 200, maxOutputTokens: 512 });
    expect(promptDominated.toolAndOutputReserve)
      .toBeLessThan(Math.floor(promptDominated.compactionThreshold * promptDominated.contextWindow) / 2);
    expect(starvedWindowCardText(promptDominated)).toMatch(/own instructions do not fit/);
  });

  it('and it never tells them to fix the SYSTEM PROMPT, which is the repair they cannot make', () => {
    // The engine's own error names three repairs; the third is the agent's soul plus the
    // platform's rules, which is not a thing a person edits to get their agent back.
    const text = starvedWindowCardText(STARVED_POLICY);
    expect(text).not.toMatch(/system prompt|soul|instructions' size/i);
    // the engine's message still names it — that audience is whoever repairs the platform
    expect(new SystemPromptTooLargeError(SYSTEM_PROMPT_TOKENS, STARVED_POLICY).message)
      .toMatch(/the system prompt's size/);
  });

  // ── §4 THE REFUSAL IS UNCHANGED. The card is additive. ──
  it('the engine still REFUSES — a card instead of a refusal would be the worse outcome', () => {
    // t109 §D's whole point: assembling a one-message context and calling it a conversation is
    // the lie. If this clause ever goes green while §1 does too, somebody has downgraded the
    // throw to a warning and the agent is back to silently forgetting everything.
    expect(() => assertSystemPromptFits(SYSTEM_PROMPT_TOKENS, STARVED_POLICY)).toThrow(SystemPromptTooLargeError);
    const err = new SystemPromptTooLargeError(SYSTEM_PROMPT_TOKENS, STARVED_POLICY);
    expect(err.message, 'and it still names the window').toMatch(/window 16000/);
    expect(err.message, 'the budget').toMatch(/assembly budget of/);
    expect(err.message, 'and the reserve').toMatch(/reserve \d+/);
  });

  // ── §5 THE WIRE. Both halves, at the one site that knows. ──
  it('the assembler reports the starved state and notes the fit, around the real assert', () => {
    const src = stripComments(fs.readFileSync(path.join(SRC, 'memory/assembler.ts'), 'utf8'));
    expect(src, 'the fit clears the note — this is the half that makes the card per-OUTAGE')
      .toMatch(/assertSystemPromptFits\(systemTokens,\s*policy\);\s*noteWindowHolds\(agentId\);/);
    expect(src, 'and the starved state cards, keyed on the engine\'s own error type')
      .toMatch(/if \(err instanceof SystemPromptTooLargeError\) reportStarvedWindow\(agentId, systemTokens, policy\);/);
    expect(src, 'and the error is RETHROWN, so the refusal is untouched')
      .toMatch(/reportStarvedWindow\(agentId, systemTokens, policy\);\s*throw err;/);
  });

  it('and nothing else in the tree cards this state — one home, as the compaction card has', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(p);
      return e.isFile() && p.endsWith('.ts') ? [p] : [];
    });
    const emitters = walk(SRC)
      .filter((p) => /WINDOW_TOO_SMALL/.test(stripComments(fs.readFileSync(p, 'utf8'))))
      .map((p) => path.relative(SRC, p).split(path.sep).join('/'));
    expect(emitters, 'the code is spoken in exactly one place').toEqual(['memory/window-starvation-card.ts']);
  });
});
