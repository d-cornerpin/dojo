// ════════════════════════════════════════════════════════════════════════════
// DESIGN RULING 13 (2026-09-22) — THE OWNER ASKS, AND HE IS ANSWERED.
//
// ── THE INCIDENT, TRANSCRIBED ───────────────────────────────────────────────
// Release-ritual round 8 asked one agent "what's my building gate code?" twice,
// in dashboard chat, and got two different answers. Once the agent fetched the
// code with `credential_get` and the owner was shown `<redacted-credential:c1>`
// where his own code should have been; once it answered from the session and he
// was shown the code. Same ask, opposite outcomes by retrieval path.
//
// ── THE TWO THINGS THAT WERE WRONG, AND THEY ARE DIFFERENT KINDS ────────────
// 1. A BUG. `agent/model.ts` replays an assistant row's stored
//    `reasoning_content` to the provider on tool-call turns (the DeepSeek family
//    requires it back), and the provider-boundary hydrator walked `content`
//    alone. So the model was handed its own prior thought with the placeholder
//    in it and copied the placeholder into the owner's reply — property 3 of
//    `credential-hydration.test.ts`'s failure mode, one field over. Clause set C.
// 2. A DECISION, which is the owner's: when the OWNER asks in DASHBOARD chat for
//    a credential he stored, the agent SHOWS it. The guard keeps redacting
//    outbound channels, non-owner contexts and the store direction, and the
//    carve-out is keyed on the CHANNEL, never on what the text says (OR2).
//    Clause sets A and B.
//
// No real credential appears here or in any report; the strings below are test
// material with no meaning outside this file.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REDACTED_CREDENTIAL,
  CREDENTIAL_STALE_PLACEHOLDER,
  noteHandedCredentialValues,
  redactHandedCredentials,
  redactHandedInCredentials,
  hydrateHandedCredentials,
  hydrateCredentialsInMessages,
  forgetHandedCredentialValues,
} from '../secret-values.js';
import { redactAssistantBlocksForPersist, redactDeclaredSecretArgs } from '../secret-fields.js';
import { engineFileContaining } from '../../agent/v2/__tests__/engine-sources.js';
import { isOwnerDashboardDelivery } from '../../agent/v2/counterparty.js';
import type { TurnCounterparty } from '../../agent/v2/counterparty.js';

const AGENT = 'agent-ruling13-a';
const OTHER = 'agent-ruling13-b';

/** What `credential_get` handed the agent back — the OWNER'S OWN gate code. */
const FETCHED = 'ruling13-gate-0000-AA';
/** What the owner TYPED into a declared secret field this turn. */
const TYPED = 'ruling13-typed-1111-BB';

/** The turn the ruling is about: the owner, in dashboard chat. */
const OWNER_ON_DASHBOARD: TurnCounterparty = {
  kind: 'user', name: 'David', relation: 'owner', channel: 'dashboard',
  senderId: null, threadId: null, senderIsAgent: false,
};

function textAndToolUse(text: string) {
  return [
    { type: 'text', text },
    { type: 'tool_use', id: 't1', name: 'vault_remember', input: { text: 'gate code checked' } },
  ];
}

function storedTextOf(blocks: Array<{ type: string }>): string {
  const t = blocks.find((b) => b.type === 'text') as unknown as { text: string } | undefined;
  return t?.text ?? '';
}

beforeEach(() => {
  forgetHandedCredentialValues();
});

// ════════════════════════════════════════════════════════════════════════════
// A — THE OWNER'S OWN SCREEN
// ════════════════════════════════════════════════════════════════════════════
describe('the owner asking his own agent for his own credential is answered', () => {
  it('shows a value the agent FETCHED, in a dashboard reply that rides with a tool call', () => {
    noteHandedCredentialValues(AGENT, [FETCHED], 'out');
    const reply = `Your building gate code is ${FETCHED}.`;
    const stored = redactAssistantBlocksForPersist(AGENT, textAndToolUse(reply), {
      toOwnerDashboard: true,
    });
    expect(storedTextOf(stored)).toBe(reply);
    expect(storedTextOf(stored)).not.toContain('<redacted-credential');
  });

  it('is the CARVE-OUT doing that and not an absent guard — the same row without the channel flag is redacted', () => {
    // The mutation this clause exists to catch: restore the old unconditional
    // redaction (drop the flag) and the owner reads a placeholder again. This is
    // the round-8 screen, reproduced.
    noteHandedCredentialValues(AGENT, [FETCHED], 'out');
    const reply = `Your building gate code is ${FETCHED}.`;
    const stored = redactAssistantBlocksForPersist(AGENT, textAndToolUse(reply));
    expect(storedTextOf(stored)).not.toContain(FETCHED);
    expect(storedTextOf(stored)).toContain('<redacted-credential:');
  });

  it('gives the SAME answer by either retrieval path — which is the whole of the incident', () => {
    noteHandedCredentialValues(AGENT, [FETCHED], 'out');
    const answer = `Your building gate code is ${FETCHED}.`;
    // Path 1: the agent fetched it this turn, so the reply rides with the tool call.
    const viaFetch = storedTextOf(
      redactAssistantBlocksForPersist(AGENT, textAndToolUse(answer), { toOwnerDashboard: true }),
    );
    // Path 2: the agent answered from what it already had — a tool-less reply,
    // which the engine persists as the model wrote it (T5b: the reply stands).
    const viaRecall = answer;
    expect(viaFetch).toBe(viaRecall);
    expect(viaFetch).toContain(FETCHED);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B — AND NOWHERE ELSE
// ════════════════════════════════════════════════════════════════════════════
describe('the leak guard keeps redacting everywhere the owner is not', () => {
  it('scrubs the OUTBOUND copy of the very same reply (email / SMS / iMessage / Teams / phone)', () => {
    noteHandedCredentialValues(AGENT, [FETCHED], 'out');
    const reply = `Your building gate code is ${FETCHED}.`;
    // `finalize/channel-push.ts` derives its outbound string through exactly this
    // call, once, for all five arms.
    const outbound = redactHandedCredentials(AGENT, reply);
    expect(outbound).not.toContain(FETCHED);
    expect(outbound).toContain('<redacted-credential:');
  });

  it('routes EVERY outbound arm through that scrub, so a new channel cannot be forgotten', () => {
    // The structural half of the clause above: the mutation it catches is deleting
    // the derivation, or an arm reaching past it for the raw reply text.
    //
    // The push block is located through the SHARED engine corpus rather than by
    // path (PHASE-6 GUARD-AUDIT): a cut that relocates the channel push makes this
    // throw with the new home named, instead of going quiet against a stale path.
    const push = engineFileContaining('export async function pushReplyToChannel(');
    expect(push, 'the channel push is in no engine file — it was renamed or moved').not.toBeNull();
    expect(push!.text).toContain('redactHandedCredentials(agentId, state.lastAssistantTextForIM)');
    // Outside the derivation, its own comment and the type restatement, no arm may
    // read the raw reply.
    const rawReads = push!.text.split('\n')
      .filter((l) => l.includes('lastAssistantTextForIM'))
      .filter((l) => !l.trimStart().startsWith('//'))
      .filter((l) => !l.includes('stateIn as AgentTurnState'))
      .filter((l) => !l.includes('redactHandedCredentials('));
    expect(rawReads).toEqual([]);
  });

  it('redacts an A2A / inter-agent row, which never carries the owner flag', () => {
    noteHandedCredentialValues(AGENT, [FETCHED], 'out');
    const stored = redactAssistantBlocksForPersist(
      AGENT, textAndToolUse(`the key is ${FETCHED}`), { toOwnerDashboard: false },
    );
    expect(storedTextOf(stored)).not.toContain(FETCHED);
  });

  it('answers the channel question from the stamps alone — no text can turn a contact into the owner', () => {
    expect(isOwnerDashboardDelivery(OWNER_ON_DASHBOARD)).toBe(true);
    const notTheOwnersScreen: Array<[string, TurnCounterparty]> = [
      ['the owner over iMessage', { ...OWNER_ON_DASHBOARD, channel: 'imessage' }],
      ['the owner over SMS', { ...OWNER_ON_DASHBOARD, channel: 'sms' }],
      ['the owner over email', { ...OWNER_ON_DASHBOARD, channel: 'email' }],
      ['the owner on a phone call', { ...OWNER_ON_DASHBOARD, channel: 'phone' }],
      ['the owner speaking out loud', { ...OWNER_ON_DASHBOARD, channel: 'voice' }],
      ['a known contact', { ...OWNER_ON_DASHBOARD, relation: 'known_contact' }],
      ['an unknown sender', { ...OWNER_ON_DASHBOARD, relation: 'third_party' }],
      ['another agent on the A2A lane', {
        kind: 'agent', name: 'peer', relation: 'agent', channel: 'a2a',
        senderId: null, threadId: 'th', senderIsAgent: false,
      }],
      ['another Dojo agent texting in over a human channel', { ...OWNER_ON_DASHBOARD, senderIsAgent: true }],
    ];
    for (const [who, cp] of notTheOwnersScreen) {
      expect(`${who}: ${isOwnerDashboardDelivery(cp)}`).toBe(`${who}: false`);
    }
  });

  it('keeps the STORE direction redacted on every surface, the owner\'s screen included', () => {
    // The owner typed this one into a declared secret field. It was never handed
    // back out, so it is not his to read off a stored row — and the structural
    // redaction of the argument itself is untouched by the carve-out.
    noteHandedCredentialValues(AGENT, [TYPED], 'in');
    const args = redactDeclaredSecretArgs('credential_add', {
      service_name: 'gate', credentials: { gate_code: TYPED },
    });
    expect(JSON.stringify(args)).not.toContain(TYPED);
    expect(JSON.stringify(args)).toContain(REDACTED_CREDENTIAL);
    // …and the untagged form the store direction writes is never hydrated back
    // into the replayed window.
    expect(hydrateHandedCredentials(AGENT, JSON.stringify(args))).not.toContain(TYPED);
    // …and it stays redacted in the owner's own dashboard reply.
    const stored = redactAssistantBlocksForPersist(
      AGENT, textAndToolUse(`saved ${TYPED} for you`), { toOwnerDashboard: true },
    );
    expect(storedTextOf(stored)).not.toContain(TYPED);
  });

  it('learns the OUT direction from the one tool that hands a value out, and from nowhere else', () => {
    // The carve-out is only as good as the direction stamp. `credential_get` is
    // the sole caller that may pass `'out'`; every other feeder of the value set
    // is the owner handing a secret IN and takes the conservative default.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcRoot = path.resolve(here, '../..');
    const outCallers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '__tests__') continue;
          walk(p);
        } else if (e.name.endsWith('.ts')) {
          const text = fs.readFileSync(p, 'utf8');
          // Each call, up to the `;` that ends its statement — the arguments can
          // themselves contain parentheses, so the span is bounded by the
          // statement and not by a bracket count.
          const calls = text.split('noteHandedCredentialValues(').slice(1);
          if (calls.some((c) => c.slice(0, c.indexOf(';') + 1).includes("'out'"))) {
            outCallers.push(path.relative(srcRoot, p));
          }
        }
      }
    };
    walk(srcRoot);
    expect(outCallers.sort()).toEqual(['credentials/tools.ts']);
  });

  it('shows a value only to the agent the store handed it to', () => {
    noteHandedCredentialValues(AGENT, [FETCHED], 'out');
    const stored = redactHandedCredentials(AGENT, `key=${FETCHED}`);
    expect(hydrateHandedCredentials(OTHER, stored)).toBe(`key=${CREDENTIAL_STALE_PLACEHOLDER}`);
    // The other agent's own dashboard reply cannot carry it either: it holds no
    // such value, so there is nothing for the carve-out to let through.
    expect(redactHandedInCredentials(OTHER, `key=${FETCHED}`)).toBe(`key=${FETCHED}`);
    expect(redactHandedCredentials(OTHER, `key=${FETCHED}`)).toBe(`key=${FETCHED}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C — THE PLACEHOLDER THE MODEL COPIED (the round-8 bug itself)
// ════════════════════════════════════════════════════════════════════════════
describe('the model is never handed its own placeholder back', () => {
  it('hydrates the REPLAYED reasoning field, not only the content (the round-8 root cause)', () => {
    noteHandedCredentialValues(AGENT, [FETCHED], 'out');
    // Exactly the shape `memory/assembler.ts` rebuilds and `agent/model.ts` sends:
    // a tool-call turn whose stored `reasoning_content` came back redacted.
    const assembled = [{
      role: 'assistant' as const,
      content: [{ type: 'tool_use', id: 't1', name: 'exec', input: { argv: ['echo', 'ok'] } }] as never,
      reasoningContent: redactHandedCredentials(AGENT, `the code is ${FETCHED}, so I will answer with it`),
    }];
    expect(assembled[0].reasoningContent).toContain('<redacted-credential:');
    const out = hydrateCredentialsInMessages(AGENT, assembled);
    expect(out[0].reasoningContent).toBe(`the code is ${FETCHED}, so I will answer with it`);
    expect(JSON.stringify(out)).not.toContain('<redacted-credential');
  });

  it('adds no reasoning field to a message that never had one', () => {
    noteHandedCredentialValues(AGENT, [FETCHED], 'out');
    const messages = [{
      role: 'user' as const,
      content: `key=${redactHandedCredentials(AGENT, FETCHED)}`,
    }];
    const out = hydrateCredentialsInMessages(AGENT, messages);
    expect(out[0].content).toBe(`key=${FETCHED}`);
    expect(Object.keys(out[0])).toEqual(['role', 'content']);
  });

  it('still returns the assembler\'s own array BY REFERENCE when neither field carries one (OR7 / roadmap #10)', () => {
    noteHandedCredentialValues(AGENT, [FETCHED], 'out');
    const messages = [
      { role: 'user' as const, content: 'what is the weather' },
      {
        role: 'assistant' as const,
        content: [{ type: 'text', text: 'checking' }] as never,
        reasoningContent: 'nothing to restore in here',
      },
    ];
    expect(hydrateCredentialsInMessages(AGENT, messages)).toBe(messages);
  });
});
