// ════════════════════════════════════════════════════════════════════════
// UX-REPAIR T3 — A ROUTING INSTRUCTION CANNOT BE SILENTLY OVERRIDDEN.
//
// The F9 explicit-delegation hint was built from THIS failure on THIS model
// (`delegation-and-attachments.ts:25-30`, owner stance: "a silent override must
// be impossible in practice"). It did not fire on the UX-review's S4 message —
// the shipped four-regex allowlist has the OBJECT ("your helpers") but not the
// imperative routing GRAMMAR ("Split ... between ...").
//
// This suite is the widening's contract, in both directions:
//   POSITIVES — the imperative routing grammar the S4 miss exposed, plus every
//               phrasing the detector already recognized (nothing narrows).
//   NEGATIVES — every example the detector's own comment says it must refuse
//               ("It must NOT fire on mere MENTIONS of agents"), plus the three
//               near-miss rows the widening makes newly reachable. A negative
//               firing after the widening is the task's STOP condition, so it is
//               written here as a test rather than remembered as a caution.
//
// The assemble-level arm asserts the MECHANISM (hint injected into the live
// message array + persisted as the `origin_intent='delegation_hint'` events-lane
// row), never the model's prose — the hint is advice voice and the agent keeps
// its judgment.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── The outside world. Each mock stands in for a door the span already went
// through inside the loop; none of them changes a decision. ──
const injectRegistryMessageSpy = vi.fn();
vi.mock('../../../../../prompt/registry/assembler.js', () => ({
  injectRegistryMessage: (...a: unknown[]) => injectRegistryMessageSpy(...(a as [])),
}));
const insertEngineEventSpy = vi.fn();
const insertMessageSpy = vi.fn();
vi.mock('../../../../../memory/message-store.js', () => ({
  insertEngineEventIfAbsent: (...a: unknown[]) => insertEngineEventSpy(...(a as [])),
  insertMessageIfAbsent: (...a: unknown[]) => insertMessageSpy(...(a as [])),
}));
vi.mock('../../../../../config/platform.js', () => ({
  isPMAgent: () => false,
  isHealerAgent: () => false,
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../../runtime.js', () => ({ injectAttachmentBlocks: () => [] }));

import {
  detectExplicitDelegation,
  injectDelegationHintAndAttachments,
} from '../delegation-and-attachments.js';
import type { AgentTurnState } from '../../../state.js';

// S4's message, verbatim from the 2026-08-10 UX review
// (`.superpowers/sdd/UX-REVIEW/S4-catalog.md:119`). The measured miss: all four
// shipped patterns returned false on this text.
const S4_MESSAGE =
  'I want a comparison of HubSpot and Pipedrive for a 3-person shop. Split the ' +
  'research between your helpers if that\'s faster, and give me one combined ' +
  'write-up with a bottom-line recommendation.';

// The canonical battery phrase the detector was written against
// (`delegation-and-attachments.ts:36-37`).
const CANONICAL = 'Have one of your agents research it and report back to me.';

describe('F9 explicit-delegation detector — positives', () => {
  it('fires on S4\'s verbatim message (the imperative routing grammar)', () => {
    expect(detectExplicitDelegation(S4_MESSAGE)).toBe(true);
  });

  it('fires on the bare S4 clause', () => {
    expect(detectExplicitDelegation('Split the research between your helpers if that\'s faster.')).toBe(true);
  });

  // MEASURED, not assumed: each row below returns true from the FOUR SHIPPED
  // patterns at HEAD 18119c2 (probed directly before the widening was written).
  // "Assign this to your sub-agents." is deliberately NOT here — it refuses
  // today and the registered widening does not cover it; it is recorded as an
  // accepted residual of the allowlist rather than smuggled in.
  it('still fires on every phrasing it already recognized', () => {
    for (const text of [
      CANONICAL,
      'Ask your agents to look into it.',
      'Tell your team to handle the research.',
      'Task one of your helpers with the write-up.',
      'Delegate this to whoever is free.',
      'Delegate the research and report back.',
      'Hand this off to one of your agents.',
      'Hand it to an agent and let me know.',
      'Spawn an agent to watch the feed.',
      'Spin up a new sub-agent for this.',
    ]) {
      expect(detectExplicitDelegation(text), text).toBe(true);
    }
  });

  it('fires on the widened imperative routing verbs with a possessive object', () => {
    for (const text of [
      'Split this between your agents.',
      'Divide the work among your helpers.',
      'Distribute these across your team.',
      'Farm out the reading to... actually, spread it between your assistants.',
      'Share the research with your team so it goes faster.',
      'Split the reading among your sub-agents please.',
    ]) {
      expect(detectExplicitDelegation(text), text).toBe(true);
    }
  });

  it('fires on "use your <helpers> for/to/on"', () => {
    for (const text of [
      'Use your agents for the research part.',
      'Use your helpers to pull the pricing pages.',
      'Use your team on the comparison.',
    ]) {
      expect(detectExplicitDelegation(text), text).toBe(true);
    }
  });
});

describe('F9 explicit-delegation detector — negatives (the STOP condition)', () => {
  it('refuses every mere MENTION of agents the detector was written to refuse', () => {
    for (const text of [
      'do you have any agents?',
      'how many agents do you have?',
      'your agents are great',
      'have you seen my agent',
      'hand this to the team lead',
      'salmon spawn in the river',
      'the spawn point is over there',
      'the delegate for the district called',
      'I delegated that last week',
      'what is a sub-agent anyway',
    ]) {
      expect(detectExplicitDelegation(text), text).toBe(false);
    }
  });

  it('refuses the three near-miss rows the widening makes reachable', () => {
    for (const text of [
      'can your helpers do research?',
      'your helpers are great',
      'how do I split the research?',
    ]) {
      expect(detectExplicitDelegation(text), text).toBe(false);
    }
  });

  it('refuses the widened verbs when the object is not the agent\'s own', () => {
    for (const text of [
      'Split the bill between the four of us.',
      'Divide the chapters among the reading group.',
      'Share the doc with my team.',
      'Distribute the invoices across the regions.',
      'Split the research between Tuesday and Wednesday.',
      'Can you use your judgement on this?',
    ]) {
      expect(detectExplicitDelegation(text), text).toBe(false);
    }
  });

  it('refuses empty and non-routing text', () => {
    expect(detectExplicitDelegation('')).toBe(false);
    expect(detectExplicitDelegation('thanks!')).toBe(false);
  });
});

// ── The mechanism, at the seam that injects it ──

function makeState(loopCount = 1): AgentTurnState {
  return { loopCount } as unknown as AgentTurnState;
}

function runInject(text: string) {
  const mctx = {} as Record<string, unknown>;
  const messages: unknown[] = [];
  return injectDelegationHintAndAttachments(makeState(), {
    agentId: 'behaviorbot',
    turnNumber: 7,
    counterparty: { kind: 'user' } as never,
    lastUserMessageContent: text,
    mctx: mctx as never,
    messages: messages as never,
  }).then(() => ({ mctx, messages }));
}

describe('F9 hint injection on S4\'s shape', () => {
  beforeEach(() => {
    injectRegistryMessageSpy.mockClear();
    insertEngineEventSpy.mockClear();
  });

  it('injects the hint into the live message array and persists the events-lane row', async () => {
    const { mctx } = await runInject(S4_MESSAGE);
    expect(String(mctx.delegationHint)).toContain('explicitly asked for this to be delegated');
    expect(String(mctx.delegationHint)).toContain('Do not silently override their routing instruction');
    expect(injectRegistryMessageSpy).toHaveBeenCalledTimes(1);
    expect(injectRegistryMessageSpy.mock.calls[0][0]).toBe('msg.delegation-hint');

    expect(insertEngineEventSpy).toHaveBeenCalledTimes(1);
    const row = insertEngineEventSpy.mock.calls[0][0] as { originIntent: string; agentId: string; turnNumber: number; content: string };
    expect(row.originIntent).toBe('delegation_hint');
    expect(row.agentId).toBe('behaviorbot');
    expect(row.turnNumber).toBe(7);
    expect(row.content.startsWith('[Engine hint] ')).toBe(true);
  });

  it('stays silent on a message that only mentions agents', async () => {
    const { mctx } = await runInject('can your helpers do research?');
    expect(mctx.delegationHint).toBeUndefined();
    expect(injectRegistryMessageSpy).not.toHaveBeenCalled();
    expect(insertEngineEventSpy).not.toHaveBeenCalled();
  });
});
