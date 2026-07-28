// PHASE-2 T1 Step 3 — preserve-catalogue addition (research 21 §guards-missed):
// the A2A-HANDOFF FLOOR's law — **user turns are NEVER reclassified mid-turn**
// — at BOTH re-stamp sites, plus the persistence union they share.
//
// The incident this encodes (owner law 2026-07-09, production transcript): a
// turn serving a HUMAN delegates to a peer with send_to_agent; the recency terms
// in the turn-kind union then see "the most recent traffic is A2A" and flip the
// live turn kind to 'a2a'. Live, that hides the working dots and the stop button
// in regular (non-wordy) mode; on reload, the same union drives
// `source: 'a2a'` persistence, so the rest of the turn's output — including the
// answer the person is waiting for — is buried as inter-agent traffic. Two
// separate symptoms, one predicate.
//
// The fix is one clause, repeated at both stamps: `counterparty.kind !== 'user'
// && (…)`. With a human counterparty the whole union is forced false, so no
// recency term can reclassify the turn. Delete that clause at EITHER site and
// the incident returns — at the pre-model site it returns live, at the post-model
// site it returns on reload — which is exactly why both are asserted here and
// why the sites are counted, not just found.
//
// Sites re-derived at HEAD 1ca2c91 by reading the file (not inherited):
//   agent/v2/loop.ts, `const preModelInterAgent = …`   (pre-model stamp)
//   agent/v2/loop.ts, `const interAgentTurn = …`        (post-model stamp AND
//                                                        the persistence union)
// The suite had NO assertion of this law before this file (`git grep -n
// "NEVER RECLASSIFIED" -- packages/server/src` → 2 hits, both comments in
// loop.ts; no test file mentions preModelInterAgent or interAgentTurn).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const loop = fs.readFileSync(path.join(srcRoot, 'agent/v2/loop.ts'), 'utf8');

// Every declaration of a turn-kind union in the loop. The law must hold on ALL
// of them; the count is asserted so a THIRD re-stamp site added later cannot
// slip in unguarded (it would fail this test until it is either guarded or
// deliberately recorded here).
const UNION_DECLS = [
  { name: 'preModelInterAgent', label: 'pre-model re-stamp (live turn kind before the first chunk)' },
  { name: 'interAgentTurn', label: 'post-model re-stamp + the persistence union (source:a2a on reload)' },
];

function unionLine(varName: string): string {
  const re = new RegExp(`^\\s*const ${varName} = .*$`, 'm');
  const m = loop.match(re);
  expect(m, `no declaration of \`${varName}\` found in agent/v2/loop.ts`).not.toBeNull();
  return (m as RegExpMatchArray)[0];
}

describe('user turns are NEVER reclassified mid-turn (A2A-handoff floor)', () => {
  for (const site of UNION_DECLS) {
    it(`${site.name} — ${site.label} — is floored by counterparty.kind !== 'user'`, () => {
      const line = unionLine(site.name);
      // The floor is a CONJUNCTION that gates the whole union, so it must be the
      // left operand of the `&&` that precedes the parenthesised recency terms.
      expect(line).toMatch(/=\s*counterparty\.kind !== 'user' &&\s*\(/);
      // …and the recency terms that caused the incident must genuinely be inside
      // those parentheses (a guard in front of an empty union proves nothing).
      const inner = line.slice(line.indexOf('&& (') + 3);
      expect(inner).toMatch(/isA2ATurn/);
      expect(inner).toMatch(/counterparty\.kind === 'agent'/);
    });
  }

  it('there are exactly the two known re-stamp sites, and both set turnKind a2a behind their union', () => {
    const stamps = [...loop.matchAll(/currentTurnKind\.set\(agentId, 'a2a'\)/g)];
    // Turn start stamps the ORIGINAL kind (`isA2ATurn ? 'a2a' : 'user'`) via a
    // ternary and is not a re-stamp; the two re-stamps are the literal sets.
    expect(stamps.length).toBe(UNION_DECLS.length);
    for (const site of UNION_DECLS) {
      const guard = new RegExp(`if \\(${site.name} && currentTurnKind\\.get\\(agentId\\) !== 'a2a'\\) \\{`);
      expect(loop).toMatch(guard);
    }
  });

  it('the PERSISTENCE union is the same guarded variable — live and reload cannot disagree', () => {
    // The incident had two faces because two different predicates decided the
    // live view and the persisted row. The fix made them one variable; if a
    // second predicate is ever introduced for persistence, this fails.
    expect(loop).toMatch(/if \(interAgentTurn\) \{/);
    expect(loop).toMatch(/lane: 'a2a'/);
  });

  it("the law is still written down at both sites, so a future editor is told why", () => {
    const notices = [...loop.matchAll(/USER TURNS ARE NEVER RECLASSIFIED/g)];
    expect(notices.length).toBe(UNION_DECLS.length);
  });
});

describe('the A2A-handoff floor itself still fires only for a human counterparty', () => {
  it("the floor's hard arm excludes an agent sender (counterpartyIsAgentSender)", () => {
    // The floor exists so a turn that delegates and then says nothing still
    // leaves the WAITING HUMAN with a line. It must never fire at a peer.
    expect(loop).toMatch(/nudgedForA2AHandoffFloorThisTurn && !counterpartyIsAgentSender/);
    expect(loop).toMatch(/const counterpartyIsAgentSender = counterparty\.kind === 'user' && !!counterparty\.senderIsAgent;/);
  });
});
