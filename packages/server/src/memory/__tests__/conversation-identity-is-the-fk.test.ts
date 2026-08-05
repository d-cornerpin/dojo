// PHASE-2 T10I — conversation identity is `messages.conversation_id`, not `messages.conv_key`.
//
// RULING 11's order is backfill (`147`) -> readers -> drop (`148`). These clauses are the
// READER half, and they are written RED-first: every one of them fails at T10H's HEAD,
// because at that HEAD the identity readers scope on a composite string.
//
// ⚠ WHY THIS IS NOT A RENAME, in one line: `conv_key` also carried three ENGINE SENTINELS
// (`engine`, `engine-steer`, `engine-notice`) on rows that are not in any conversation, and it
// could not distinguish two mail threads from one sender. `conversation_id` is a real FK into
// a real table with `UNIQUE(agent_id, channel, provider, counterparty_id, thread_root)`, so it
// is STRICTLY more precise. The clauses below pin the three things that must not change with
// the precision gain:
//   (a) an UNSTAMPED row is still "this turn's own in-flight work" and is still KEPT — that
//       three-valued semantics (mine / another's / not yet stamped) is the re-answer ghost
//       guard (owner transcripts 2026-07-07, 2026-07-09) and it survives verbatim;
//   (b) another conversation's SETTLED output is still dropped;
//   (c) an events-lane rider is still not a conversation.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Message, MessageOrigin } from '@dojo/shared';
import { scopeToHumanConversation } from '../assembler.js';
import type { TurnCounterparty } from '../../agent/v2/counterparty.js';
import { engineFiles as engineFilesFromServerSrc } from '../../agent/v2/__tests__/engine-sources.js';

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
const src = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');
/** Blank comments, keeping line count, so prose ABOUT the column is never read as a live use. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length))
  .replace(/^\s*--[^\n]*/gm, (m) => ' '.repeat(m.length));

// PHASE-6 GUARD-AUDIT 2026-08-04 — THE ENGINE'S SOURCE, DERIVED ONCE AND SHARED.
// The T9b note in the STRIP-3 block below explains WHY the corpus is the driver plus every
// step package rather than `loop.ts`; the audit's addition is that the walk implementing it
// is no longer copied into six guards, each free to drift. `engine-sources.ts` returns paths
// relative to `packages/server/src` while `src()` here takes REPO-relative ones, so the
// prefix is re-attached at this boundary — `src()` and every clause reading through it are
// untouched. The shared walk is strictly stricter than the copy it replaces: it recurses
// into a step's SUB-modules (a step is a DIRECTORY under RULING P6-R1) and it THROWS if the
// driver has moved, where a hand-rolled walk would have returned a driverless corpus and let
// every ABSENCE clause below pass on nothing.
const engineRepoFiles = (): string[] =>
  engineFilesFromServerSrc().map((rel) => `packages/server/src/${rel}`);
/** Every engine source, comments blanked, joined. PRESENCE and ABSENCE clauses only — an
 *  order or window clause must pin itself to ONE file (see the STRIP-3 block). */
const engineSrc = (): string => engineRepoFiles().map((f) => stripComments(src(f))).join('\n');

const selfOrigin: MessageOrigin = {
  kind: 'self', relation: 'agent', channel: null,
  senderName: null, senderId: null, threadId: null, intent: null, authorized: true,
};
function userOrigin(channel: 'imessage', senderId: string, name: string): MessageOrigin {
  return { kind: 'user', relation: 'known_contact', channel, senderName: name, senderId, threadId: null, intent: null, authorized: true };
}
function msg(p: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return { agentId: 'a1', tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: '2026-07-30 12:00:00', ...p } as Message;
}
const cp = (senderId: string): TurnCounterparty =>
  ({ kind: 'user', name: 'Alex', relation: 'known_contact', channel: 'imessage', senderId, threadId: null, senderIsAgent: false });

describe('T10I — the assembler scopes on conversation_id', () => {
  // The counterparty's conversation, as the FK. `scopeToHumanConversation` must be able to
  // decide membership from it, which is what the extra argument is for: the turn resolved
  // this at pickup (loop.ts) and hands it down, rather than every reader re-deriving a string.
  const MINE = 'conv-mine';
  const THEIRS = 'conv-theirs';

  it('keeps THIS conversation\'s own settled output and drops ANOTHER conversation\'s', () => {
    const tail = [
      msg({ id: 'mine', role: 'assistant', content: 'here is your answer', origin: selfOrigin, conversationId: MINE }),
      msg({ id: 'theirs', role: 'assistant', content: 'a different party\'s answer', origin: selfOrigin, conversationId: THEIRS }),
    ];
    const kept = scopeToHumanConversation(tail, cp('+1555'), MINE).map((m) => m.id);
    expect(kept).toContain('mine');
    expect(kept).not.toContain('theirs');
  });

  it('KEEPS an unstamped own-output row — that is this turn\'s in-flight work, and dropping it is the bug', () => {
    const tail = [msg({ id: 'inflight', role: 'assistant', content: 'working…', origin: selfOrigin, conversationId: null })];
    expect(scopeToHumanConversation(tail, cp('+1555'), MINE).map((m) => m.id)).toEqual(['inflight']);
  });

  // PHASE-3 STRIP-3 — the causal link, pinned so nobody has to re-derive it. This is the
  // BEHAVIOUR the loop's stale turn-conversation map fed on: "I do not know this turn's
  // conversation" and "this turn has no conversation" are the same input here, and the
  // answer to both is to drop every stamped own-output row. That is correct for a genuine
  // engine/A2A turn and catastrophic for a human turn whose map was simply written too
  // early — it is the re-answer ghost's own shape. The map's write therefore has to happen
  // after its value is final (loop.ts, pinned below); this clause says why.
  it('a NULL counterparty conversation drops stamped own output — which is why the turn must publish the resolved id', () => {
    const tail = [
      msg({ id: 'answered', role: 'assistant', content: 'here is your answer', origin: selfOrigin, conversationId: MINE }),
    ];
    expect(scopeToHumanConversation(tail, cp('+1555'), null).map((m) => m.id)).toEqual([]);
    // The same row, with the identity the turn actually has, survives.
    expect(scopeToHumanConversation(tail, cp('+1555'), MINE).map((m) => m.id)).toEqual(['answered']);
  });

  it('still excludes ANOTHER human\'s inbound (the no-bleed property, carried across the re-point)', () => {
    const tail = [
      msg({ id: 'other-human', role: 'user', content: 'dinner?', origin: userOrigin('imessage', '+1999', 'Sam'), conversationId: THEIRS }),
      msg({ id: 'my-human', role: 'user', content: 'the flight time?', origin: userOrigin('imessage', '+1555', 'Alex'), conversationId: MINE }),
    ];
    const kept = scopeToHumanConversation(tail, cp('+1555'), MINE).map((m) => m.id);
    expect(kept).toContain('my-human');
    expect(kept).not.toContain('other-human');
  });
});

describe('T10I — the identity readers no longer read messages.conv_key', () => {
  it('conversation-scoped recall scopes on conversation_id', () => {
    const s = stripComments(src('packages/server/src/memory/recall.ts'));
    expect(s).not.toMatch(/conv_key/);
    expect(s).toMatch(/conversation_id = \?/);
    // The three-valued semantics must survive: an untagged row is still restricted to the
    // agent's OWN activity, never a bare `IS NULL` (inv 4 — another human's unclaimed inbound).
    expect(s).toMatch(/conversation_id IS NULL AND \(role IN \('assistant','tool'\)/);
  });

  it('the active-directive pin scopes on conversation_id', () => {
    const s = stripComments(src('packages/server/src/memory/directive.ts'));
    expect(s).not.toMatch(/conv_key/);
    expect(s).toMatch(/conversation_id = \?/);
  });

  it('the answered-in-this-conversation edge scopes on conversation_id', () => {
    const s = stripComments(src('packages/server/src/agent/v2/answered-edge.ts'));
    // `turns.conv_key` is a DIFFERENT column on a DIFFERENT table and is NOT in scope —
    // `work.origin_conv_key` still joins to it (tracker/delivery-evidence.ts). The clause
    // therefore pins the messages-side read only.
    expect(s).not.toMatch(/m1\.conv_key/);
    expect(s).toMatch(/m1\.conversation_id = \?/);
  });

  // STRIP (PHASE-3 T7 Step 2, 2026-08-01): the re-answer-guard clause is deleted with its
  // file. It read `re-answer-guard.ts` from disk and asserted the T10I re-point held there;
  // that module no longer exists, so the clause would throw ENOENT on a correct tree.
  // requirement preserved: the T10I re-point itself is still pinned by the seven surviving
  // clauses in this block (recall, the directive pin, the answered edge, the turn-output tag,
  // the recently-answered block, the party label, the dashboard), and the REQUIREMENT the
  // deleted guard served — delivered history is never deleted from the window — is now held
  // by `checks/check-reanswer-ghost.mjs`, wired into the kit roster and the dojo REQUIRED
  // list in this same task and green there.

  it('the turn\'s own output is tagged with the conversation, at turn END (not at insert)', () => {
    const s = stripComments(src('packages/server/src/memory/message-store.ts'));
    expect(s).not.toMatch(/conv_key/);
    expect(s).toMatch(/tagTurnOutputConversationId/);
    // The "do not re-tag" guard is the whole reason the tag is late: an already-tagged row
    // belongs to an earlier turn. Preserved as the same NULL test on the new column.
    expect(s).toMatch(/conversation_id IS NULL/);
  });

  it('the recently-answered block and the F9 sibling batch-claim scope on conversation_id', () => {
    // PHASE-6 GUARD-AUDIT 2026-08-04: THE CORPUS IS THE ENGINE — the driver plus every step
    // package — not `loop.ts` alone. Both halves needed it, for opposite reasons. The
    // ABSENCE half (`not.toMatch(/conv_key = \?/)`) is the quiet one: a tranche that carries
    // the recently-answered block into `agent/v2/steps/` leaves this reading a file the
    // block is no longer in, and it passes without having looked at the SQL it forbids. The
    // PRESENCE half would at least fail — but it would fail on a CORRECT tree, which is the
    // coin-flip this file's own STRIP note refuses. Both are safe over a join: neither reads
    // a position or a window.
    const s = engineSrc();
    expect(s).not.toMatch(/conv_key = \?/);
    expect(s).toMatch(/AND conversation_id = \?/);
  });

  it('the party label for own-output rows comes from the conversation, not from parsing a key', () => {
    const s = stripComments(src('packages/server/src/memory/party-label.ts'));
    expect(s).not.toMatch(/convKeyToLabel/);
  });

  it('the dashboard receives conversationId and tells a background row by LANE, not by a sigil', () => {
    const s = stripComments(src('packages/dashboard/src/pages/Chat.tsx'));
    expect(s).not.toMatch(/convKey/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-3 STRIP-3 — the conv-KEY-where-a-conversation-ID-is-required class, closed.
//
// STRIP-2 enumerated it tree-wide: 13 non-test signatures take a conversation-id parameter
// (21 call sites read), 51 direct SQL bind sites across 26 files, and every reader of
// key-holding turn state. The bind-site axis returns ZERO — both live members cross a
// FUNCTION BOUNDARY, and both values are `string`, so neither `tsc` nor a grep at the
// statement can see them. Signatures had to be read. These clauses are what stops the class
// coming back the same invisible way; the behavioural halves live in
// `agent/v2/__tests__/integration.test.ts` ("STRIP-3").
// ════════════════════════════════════════════════════════════════════════════════════════
describe('STRIP-3 — the two conv-key/conversation-id call sites, pinned', () => {
  // PHASE-6 T9b: THE CORPUS IS THE ENGINE, NOT ONE FILE. `claimAssembledSiblings(`
  // left `loop.ts` for `agent/v2/steps/teardown/` when the ninth tranche was cut, and
  // this clause went red — honestly, but only because it asserts PRESENCE. The scan's
  // requirement was never "these calls live in loop.ts"; it is "the engine still calls
  // them, and still with a conv KEY." So the corpus is the driver plus every step
  // package, which also covers the seven tranches still to come.
  //
  // PHASE-6 GUARD-AUDIT 2026-08-04: that corpus is UNCHANGED in reach; the walk that
  // derived it here has been deleted in favour of the single derivation in
  // `agent/v2/__tests__/engine-sources.ts` (see `engineRepoFiles` / `engineSrc` at the top
  // of this file). Six guards had each hand-rolled this walk, and six definitions of "the
  // engine" is six chances for one of them to quietly stop meaning what the others mean.
  const engineFiles = engineRepoFiles;
  const loop = engineSrc;

  it('the ghosted-ask ladder looks its recorded answer up by conversation ID, never by conv key', () => {
    const s = loop();
    expect(s).toMatch(/recordedAnswerInConversation\(agentId, chosenConversationId\)/);
    expect(s).not.toMatch(/recordedAnswerInConversation\(agentId, chosenConvKey\)/);
  });

  it('the turn-conversation map has ONE writer and it runs AFTER the pickup repair', () => {
    const s = loop();
    // One writer. Two `.set()`s would be two owners of one fact — and the second would be
    // exactly the "patch it later" shape that produced the stale value in the first place.
    expect(s.match(/turnCtx\.conversationId = /g) ?? []).toHaveLength(1);
    // …and it runs after the repair that can REASSIGN what it publishes. Written as an
    // ordering, because the defect was an ordering: the value was correct, the moment was not.
    // ⚠ THE ORDERING IS READ INSIDE ONE FILE, and that is a PHASE-6 correction rather
    // than a nicety: once the corpus is a concatenation, comparing two indexes across it
    // measures the order the files were joined in, not the order the engine executes. So
    // the clause first insists both sites are in the SAME source file — if a later
    // tranche ever splits them, this fails loudly instead of quietly measuring nothing.
    const withBoth = engineFiles()
      .map((f) => stripComments(src(f)))
      .filter((t) => t.includes('chosenConversationId = resolveOrCreateConversation(')
                  && t.includes('turnCtx.conversationId = '));
    expect(withBoth, 'the repair and the publish must stay in one file for their order to mean anything')
      .toHaveLength(1);
    const repairAt = withBoth[0].indexOf('chosenConversationId = resolveOrCreateConversation(');
    const publishAt = withBoth[0].indexOf('turnCtx.conversationId = ');
    expect(repairAt).toBeGreaterThan(-1);
    expect(publishAt).toBeGreaterThan(repairAt);
  });

  it('the correctly-typed KEY consumers are untouched — a "fix" that rekeyed these would be a new bug', () => {
    // Enumerated by STRIP-2 so nobody sweeps them up with the two real defects: these four
    // take a conv KEY on purpose and compare against `conversationKey()` output.
    const s = loop();
    // SWEEP-A TB1: the teardown batch-claim `claimAssembledSiblings(` became the READ
    // `assembledContextAsks(` — same conv KEY argument, same window, no state write. This
    // clause's subject is the ARGUMENT TYPE (a conv key, compared against `conversationKey()`
    // output), and that is exactly what survived the conversion; the name moved with it.
    expect(s).toMatch(/assembledContextAsks\(/);
    expect(s).toMatch(/accumulateUntrackedWorkAcrossTurns\(/);
    expect(stripComments(src('packages/server/src/agent/v2/counterparty.ts')))
      .toMatch(/quarantineWaitingConversation\(agentId: string, convKey: string/);
  });
});

describe('T10I — NEGATIVE CONTROLS: the four conv_key columns that are NOT in scope stay', () => {
  // Without these, every clause above could be satisfied by deleting the wrong thing. These
  // four columns are on OTHER tables, are read by live joins, and this task does not touch
  // them (`work.origin_conv_key` <-> `turns.conv_key` is the delivery-evidence join).
  it('work.origin_conv_key still exists and is still joined to turns.conv_key', () => {
    expect(stripComments(src('packages/server/src/tracker/delivery-evidence.ts')))
      .toMatch(/conv_key IS NOT NULL AND conv_key = \?/);
    expect(stripComments(src('packages/server/src/work/tracker-store.ts'))).toMatch(/origin\.convKey/);
  });
  it('turns.conv_key is still recorded', () => {
    expect(stripComments(src('packages/server/src/agent/v2/turn-record.ts'))).toMatch(/conv_key/);
  });
  it('tool_receipts.conv_key is still recorded and read', () => {
    expect(stripComments(src('packages/server/src/receipts/store.ts'))).toMatch(/conv_key/);
    expect(stripComments(src('packages/server/src/agent/v2/outbound-ledger.ts'))).toMatch(/conv_key/);
  });
  it('conversationKey() itself SURVIVES — it still keys the waiting set and the four columns above', () => {
    expect(stripComments(src('packages/server/src/agent/v2/counterparty.ts')))
      .toMatch(/export function conversationKey/);
  });
});
