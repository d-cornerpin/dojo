// ════════════════════════════════════════════════════════════════════════════
// DESIGN RULING 13, AS THE OWNER CORRECTED IT (2026-09-22), in his own words:
//
//   "The agent should not reply with credentials. The user can see them in the
//    credentials store in the vault tab instead."
//
// ── WHAT THAT SETTLES, AND WHAT IT LEAVES ──────────────────────────────────
// The ruling first read the other way ("the owner asks, the agent SHOWS it"),
// and an earlier cut of this task built the machinery for it — a channel-keyed
// carve-out at the persist seam, then a render-time hydrator at the dashboard
// socket frame and the chat route. The correction deletes ALL of it. There is
// no surface where a credential value is rendered back into chat, so the
// clauses below pin the ABSENCE of one as hard as they pin the redaction.
//
// Round 8's actual defect is untouched by the correction and still fixed: the
// owner asked for his gate code and read `<redacted-credential:c1>` because the
// MODEL wrote it, having been handed its own prior `reasoning_content` back
// unhydrated at the provider boundary (`agent/model.ts` replays that field on
// tool-call turns). The agent keeps USING its credentials; it just never types
// one into a reply.
//
// The end-to-end half of this file — the real persist seam, both arms, row and
// socket frame — is
// `agent/v2/steps/post-call-classify/__tests__/no-screen-shows-a-credential.test.ts`.
//
// No real credential appears here; the strings are test material.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';
import {
  REDACTED_CREDENTIAL,
  CREDENTIAL_STALE_PLACEHOLDER,
  noteHandedCredentialValues,
  redactHandedCredentials,
  hydrateHandedCredentials,
  hydrateCredentialsInMessages,
  forgetHandedCredentialValues,
} from '../secret-values.js';
import { redactAssistantBlocksForPersist, redactDeclaredSecretArgs } from '../secret-fields.js';

const AGENT = 'agent-ruling13-a';
const OTHER = 'agent-ruling13-b';
/** What `credential_get` handed the agent back. */
const FETCHED = 'ruling13-gate-0000-AA';
/** What the owner typed into a declared secret field. */
const TYPED = 'ruling13-typed-1111-BB';

beforeEach(() => {
  forgetHandedCredentialValues();
});

// ════════════════════════════════════════════════════════════════════════════
// A — NO SURFACE SHOWS ONE, AND NO CODE EXISTS THAT COULD
// ════════════════════════════════════════════════════════════════════════════
describe('a credential never appears in chat, and nothing can make it', () => {
  it('scrubs a fetched value out of a reply that rides with a tool call', () => {
    noteHandedCredentialValues(AGENT, [FETCHED]);
    const stored = redactAssistantBlocksForPersist(AGENT, [
      { type: 'text', text: `Your building gate code is ${FETCHED}.` },
      { type: 'tool_use', id: 't1', name: 'vault_remember', input: { text: 'noted' } },
    ]);
    const text = (stored.find((b) => b.type === 'text') as unknown as { text: string }).text;
    expect(text).not.toContain(FETCHED);
    expect(text).toContain('<redacted-credential:');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B — THE GUARDS THAT ARE REAL BUGS WHATEVER THE RULING SAYS
// ════════════════════════════════════════════════════════════════════════════
describe('and nothing carrying one leaves the box', () => {
  it('scrubs the OUTBOUND copy of a reply (iMessage / Teams / email / phone / SMS)', () => {
    noteHandedCredentialValues(AGENT, [FETCHED]);
    const outbound = redactHandedCredentials(AGENT, `Your building gate code is ${FETCHED}.`);
    expect(outbound).not.toContain(FETCHED);
    expect(outbound).toContain('<redacted-credential:');
  });

  it('keeps the STORE direction redacted, and never hydrates the untagged form', () => {
    noteHandedCredentialValues(AGENT, [TYPED]);
    const args = redactDeclaredSecretArgs('credential_add', {
      service_name: 'gate', credentials: { gate_code: TYPED },
    });
    expect(JSON.stringify(args)).not.toContain(TYPED);
    expect(JSON.stringify(args)).toContain(REDACTED_CREDENTIAL);
    expect(hydrateHandedCredentials(AGENT, JSON.stringify(args))).not.toContain(TYPED);
  });

  it('scopes every value to the agent that handled it', () => {
    noteHandedCredentialValues(AGENT, [FETCHED]);
    const stored = redactHandedCredentials(AGENT, `key=${FETCHED}`);
    expect(hydrateHandedCredentials(OTHER, stored)).toBe(`key=${CREDENTIAL_STALE_PLACEHOLDER}`);
    expect(redactHandedCredentials(OTHER, `key=${FETCHED}`)).toBe(`key=${FETCHED}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C — THE PLACEHOLDER THE MODEL COPIED (round 8's actual defect)
// ════════════════════════════════════════════════════════════════════════════
describe('the model is never handed its own placeholder back', () => {
  it('hydrates the REPLAYED reasoning field, not only the content', () => {
    noteHandedCredentialValues(AGENT, [FETCHED]);
    // Exactly the shape `memory/assembler.ts` rebuilds and `agent/model.ts` sends.
    const assembled = [{
      role: 'assistant' as const,
      content: [{ type: 'tool_use', id: 't1', name: 'exec', input: { argv: ['echo', 'ok'] } }] as never,
      reasoningContent: redactHandedCredentials(AGENT, `the code is ${FETCHED}, so I will use it`),
    }];
    expect(assembled[0].reasoningContent).toContain('<redacted-credential:');
    const out = hydrateCredentialsInMessages(AGENT, assembled);
    expect(out[0].reasoningContent).toBe(`the code is ${FETCHED}, so I will use it`);
    expect(JSON.stringify(out)).not.toContain('<redacted-credential');
  });

  it('adds no reasoning field to a message that never had one', () => {
    noteHandedCredentialValues(AGENT, [FETCHED]);
    const messages = [{ role: 'user' as const, content: `key=${redactHandedCredentials(AGENT, FETCHED)}` }];
    const out = hydrateCredentialsInMessages(AGENT, messages);
    expect(out[0].content).toBe(`key=${FETCHED}`);
    expect(Object.keys(out[0])).toEqual(['role', 'content']);
  });

  it('still returns the assembler\'s own array BY REFERENCE when neither field carries one (OR7 / roadmap #10)', () => {
    noteHandedCredentialValues(AGENT, [FETCHED]);
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
