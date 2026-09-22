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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { engineFileContaining } from '../../agent/v2/__tests__/engine-sources.js';

const AGENT = 'agent-ruling13-a';
const OTHER = 'agent-ruling13-b';
/** What `credential_get` handed the agent back. */
const FETCHED = 'ruling13-gate-0000-AA';
/** What the owner typed into a declared secret field. */
const TYPED = 'ruling13-typed-1111-BB';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      filesUnder(p, out);
    } else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

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

  it('THE REVEAL IS GONE: no production file hydrates a credential for a human surface', () => {
    // The correction deleted an owner-dashboard carve-out that had two render seams
    // (the socket frame and the chat route) and a channel predicate to key them. This
    // clause is what stops any of it coming back by halves: the ONLY hydrator in the
    // tree is the provider-boundary one, whose reader is the model, and its single
    // call site is already pinned by `credential-hydration.test.ts`.
    const banned = ['hydrateOwnerDashboardCredentials', 'isOwnerDashboardDelivery', 'redactHandedInCredentials'];
    const offenders = filesUnder(SRC)
      .filter((f) => banned.some((b) => fs.readFileSync(f, 'utf8').includes(b)))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
    // And the one hydrator that DOES exist reaches exactly one production caller, at
    // the provider boundary — never a route, never a broadcast.
    const hydrateCallers = filesUnder(SRC)
      .filter((f) => /\bhydrateCredentialsInMessages\s*\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f))
      .filter((f) => f !== 'credentials/secret-values.ts');
    expect(hydrateCallers).toEqual(['agent/v2/steps/call-llm/model-call.ts']);
    // The dashboard's own read route touches no credential seam at all.
    const chatRoute = fs.readFileSync(path.join(SRC, 'gateway/routes/chat.ts'), 'utf8');
    expect(chatRoute).not.toContain('redact');
    expect(chatRoute).not.toContain('hydrate');
  });

  it('the tool-less reply is scrubbed at its ONE birth point, so every row downstream of it is', () => {
    // The memory-recall path. `terminal-text.ts` is where `persistedContent` is born and
    // the only place it is derived from the model's raw text; the assistant row, the
    // working-note system row, their broadcasts and the channel-routed copy are all
    // downstream. A scrub at each writer instead is a scrub at whichever writers someone
    // remembered — this clause pins the single owner.
    const terminal = engineFileContaining('let persistedContent: string | null =');
    expect(terminal, 'the tool-less reply\'s birth point is in no engine file').not.toBeNull();
    expect(terminal!.rel).toBe('agent/v2/steps/post-call-classify/terminal-text.ts');
    expect(terminal!.text).toContain('redactHandedCredentials(agentId, result.content)');
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

  it('routes EVERY outbound arm through that scrub, including the two that are not the reply', () => {
    // Located through the shared engine corpus, so a cut that relocates the push throws
    // with the new home named instead of going quiet against a stale path.
    const push = engineFileContaining('export async function pushReplyToChannel(');
    expect(push, 'the channel push is in no engine file').not.toBeNull();
    expect(push!.text).toContain('redactHandedCredentials(agentId, state.lastAssistantTextForIM)');
    // m3: the phone arm's STREAMED TAIL is a second string this file sends.
    expect(push!.text).toContain('redactHandedCredentials(agentId, turnCtx.phoneStreamBuffer)');
    // No arm may reach past the derivation for the raw reply.
    const rawReads = push!.text.split('\n')
      .filter((l) => l.includes('lastAssistantTextForIM'))
      .filter((l) => !l.trimStart().startsWith('//'))
      .filter((l) => !l.includes('stateIn as AgentTurnState'))
      .filter((l) => !l.includes('redactHandedCredentials('));
    expect(rawReads).toEqual([]);
    // rm3: the SIXTH arm — the caption `stranded-attachments.ts` sends after the router
    // has already run — was fixed for m2 and pinned by nothing.
    const stranded = engineFileContaining('stranded-file iMessage delivery failed');
    expect(stranded, 'the stranded-attachment arm is in no engine file').not.toBeNull();
    expect(stranded!.text).toContain('redactHandedCredentials(agentId, captionText)');
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

  it('COVERS EVERY FIELD THE BOUNDARY SENDS — the census that stops this recurring one field later', () => {
    // The bug was not "reasoning was forgotten". It was "a field joined the message the
    // provider boundary sends and the hydrator did not learn about it". A fourth field
    // fails here on the commit that adds it, not on the next incident.
    const lanes = fs.readFileSync(path.join(SRC, 'memory/lanes.ts'), 'utf8');
    const shape = lanes.slice(lanes.indexOf('export type LaneMessage = {'));
    const fields = [...shape.slice(0, shape.indexOf('};')).matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(fields.sort()).toEqual(['content', 'reasoningContent', 'role']);
    const hydrator = fs.readFileSync(path.join(SRC, 'credentials/secret-values.ts'), 'utf8');
    const seam = hydrator.slice(hydrator.indexOf('export function hydrateCredentialsInMessages'));
    for (const f of fields.filter((f) => f !== 'role')) {
      expect(seam, `hydrateCredentialsInMessages never mentions \`${f}\``).toContain(f);
    }
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
