// ════════════════════════════════════════════════════════════════════════════════════════
// t141 — "NO ROW VISIBLE TODAY BECOMES INVISIBLE", AS A PROPERTY; AND THE DELETIONS, AS CENSUSES.
//
// §1 enumerates EVERY own-row shape the scopers can meet (role × lane × label × stamp × turn)
// and compares the live scopers against the PRE-t141 rule restated as an oracle over the state
// the old writer would have left. They must agree on every shape. That is the owner's rule
// ("label, never hide") made mechanical: labelling may change what a row SAYS, never WHETHER it
// is in view.
//
// §2 are the deletion censuses (G4: comment-stripped, counted in both directions).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message, MessageOrigin } from '@dojo/shared';
import { scopeToHumanConversation, scopeToA2AThread } from '../assembler.js';
import type { SubjectKind } from '../message-store.js';
import type { TurnCounterparty } from '../../agent/v2/counterparty.js';
import { engineSources } from '../../agent/v2/__tests__/engine-sources.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

const C = 'conv-this';
const OTHER = 'conv-other';
const NOW = 42;
const PAST = 41;
const ownerCp: TurnCounterparty = { kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard', senderId: 'owner', threadId: null, senderIsAgent: false };

type Shape = { id: string; role: 'assistant' | 'tool'; lane: 'owner' | 'a2a'; kind: SubjectKind | null; conv: string | null; turn: number; tool: boolean };

/** Every shape the post-t141 writer (and migration 188) can leave, with the stamp the PRE-t141
 *  system would have shown the scoper for the same row: the late stamp wrote a person turn's
 *  owner-lane rows at turn END (so the in-flight turn's rows read NULL), and nothing else. */
function shapes(): Array<Shape & { oldConv: string | null }> {
  const out: Array<Shape & { oldConv: string | null }> = [];
  let i = 0;
  for (const role of ['assistant', 'tool'] as const)
    for (const lane of ['owner', 'a2a'] as const)
      for (const kind of ['conv', 'a2a_thread', 'engine_event', 'background', 'legacy', 'unknown', null] as const)
        for (const conv of [null, C, OTHER])
          for (const turn of [NOW, PAST])
            for (const tool of [true, false]) {
              // Only shapes the writers produce: a `conv` label always names its conversation;
              // `legacy` carries a reconstructed one; agent-thread / engine / background never do.
              if (kind === 'conv' && !conv) continue;
              if ((kind === 'a2a_thread' || kind === 'engine_event' || kind === 'background') && conv) continue;
              if (lane === 'a2a' && kind !== 'a2a_thread' && kind !== null) continue;
              // An UNLABELLED row of the live turn carrying a stamp is not a shape any writer makes:
              // the live turn's rows are written through `message-store.ts`, which labels them.
              if (kind === null && conv && turn === NOW) continue;
              const oldConv = kind === 'conv' && lane === 'owner' && turn === PAST ? conv
                : kind === null ? conv : null;   // an unlabelled row (fixture / bypass) carries its stamp as-is
              out.push({ id: `s${i++}`, role, lane, kind, conv, turn, tool, oldConv });
            }
  return out;
}

function asMessage(s: Shape): Message & { subjectKind?: SubjectKind | null } {
  const origin: MessageOrigin = { kind: 'self', relation: 'agent', channel: s.lane === 'a2a' ? 'a2a' : null, senderName: null, senderId: null, threadId: null, intent: null, authorized: true };
  return {
    id: s.id, agentId: 'a', role: s.role, tokenCount: 1, modelId: null, cost: null, latencyMs: null,
    createdAt: '2026-10-12 10:00:00', turnNumber: s.turn, conversationId: s.conv, origin,
    content: s.tool ? '[{"type":"tool_use","id":"t","name":"x","input":{}}]' : 'text',
    ...(s.kind === null ? {} : { subjectKind: s.kind }),
  } as Message & { subjectKind?: SubjectKind | null };
}

describe('§1 membership is unchanged on every shape (the oracle is the pre-t141 rule)', () => {
  const all = shapes();

  it('the owner\'s conversation keeps exactly what it kept before', () => {
    const live = new Set(scopeToHumanConversation(all.map(asMessage), ownerCp, C, NOW).map((m) => m.id));
    const oracle = new Set(all.filter((s) => !s.oldConv || s.oldConv === C).map((s) => s.id));
    const diff = all.filter((s) => live.has(s.id) !== oracle.has(s.id));
    expect(diff, JSON.stringify(diff.slice(0, 5))).toEqual([]);
    expect(all.length).toBeGreaterThan(60);
  });

  it('an agent thread keeps exactly what it kept before', () => {
    // On an agent-thread turn the live turn IS that thread's: a person-conversation row of the
    // live turn cannot exist there, so those shapes are not in this scoper's domain.
    const domain = all.filter((s) => !(s.turn === NOW && s.kind === 'conv'));
    const live = new Set(scopeToA2AThread(domain.map(asMessage), 'thread-x').map((m) => m.id));
    const oracle = new Set(domain.filter((s) => {
      const humanStamped = !!s.oldConv && s.lane !== 'a2a';
      return (s.tool && !humanStamped) || s.lane === 'a2a';
    }).map((s) => s.id));
    const diff = domain.filter((s) => live.has(s.id) !== oracle.has(s.id));
    expect(diff, JSON.stringify(diff.slice(0, 5))).toEqual([]);
  });

  it('the in-flight fact is the turn number: this turn\'s rows are kept whatever their stamp', () => {
    const mine = asMessage({ id: 'now', role: 'tool', lane: 'owner', kind: 'conv', conv: OTHER, turn: NOW, tool: true });
    expect(scopeToHumanConversation([mine], ownerCp, C, NOW).map((m) => m.id)).toEqual(['now']);
    expect(scopeToHumanConversation([mine], ownerCp, C, NOW + 1).map((m) => m.id)).toEqual([]);
  });
});

describe('§2 the deletions, counted', () => {
  const asm = stripComments(read('memory/assembler.ts'));

  it('NULL-means-mine is gone from every scoper: no scoper reads a missing stamp as "keep"', () => {
    expect(asm).not.toMatch(/!m\.conversationId/);
    expect(asm).not.toMatch(/m\.conversationId\s*\|\|/);
    // ...and the label is read in EXACTLY the three scopers (A2A, engine, human) — both ways.
    expect(asm.match(/subjectOf\(m\)/g) ?? []).toHaveLength(3);
    // The in-flight fact: defined once, used by the two scopers that used to infer it.
    expect(asm.match(/isInFlight\(m, inFlightTurn\)/g) ?? []).toHaveLength(2);
  });

  it('the email-wake view is no longer a partial copy: the notification turn scopes to the owner conversation it shows', () => {
    expect(asm).toMatch(/servedConversationId\(agentId, turnContext\), inFlightTurn\)/);
    expect(stripComments(read('memory/row-label.ts'))).toMatch(/if \(live \|\| !turnContext\?\.isNotificationTurn\) return live;/);
  });

  it('the "surface it" steer is gone from the EVENTS head and the Gmail notice body', () => {
    expect(asm).not.toMatch(/Surface one to the owner/i);
    expect(asm).toMatch(/NEW = arrived since/);
    expect(stripComments(read('services/gmail-watcher.ts'))).not.toMatch(/surface it/i);
  });

  it('round 2: no notice body anywhere tells the agent to "surface it" — Gmail, Outlook and SMS alike', () => {
    for (const f of ['services/gmail-watcher.ts', 'services/outlook-watcher.ts', 'twilio/sms-inbound.ts']) {
      expect(stripComments(read(f)), f).not.toMatch(/surface it|looks important/i);
    }
  });

  it('ONE instant formatter for the model-facing memory lanes this lane owns', () => {
    const stamp = stripComments(read('memory/message-stamp.ts'));
    expect(stamp.match(/toLocaleString\(/g) ?? []).toHaveLength(1);
    for (const f of ['memory/assembler.ts', 'memory/recall-lane.ts', 'memory/deliveries-lane.ts', 'memory/row-label.ts']) {
      const src = stripComments(read(f));
      expect(src, f).not.toMatch(/toLocaleString\(|toLocaleTimeString\(|toISOString\(\)\.slice/);
      // No bare SQLite instant is printed to the model by these files.
      expect(src, f).not.toMatch(/`- \[\$\{row\.created_at\}\]/);
    }
  });

  it('round 2: NO reader anywhere in memory/ or agent/ treats a missing conversation stamp as "mine"', () => {
    // Every production source under the two trees, comments stripped. The engine's step
    // packages come through the shared corpus (engine-sources.ts); the rest is a plain walk.
    const walk = (dir: string): string[] => fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((d) => {
      const rel = `${dir}/${d.name}`;
      if (d.isDirectory()) return d.name === '__tests__' ? [] : walk(rel);
      return d.name.endsWith('.ts') ? [rel] : [];
    });
    const corpus = new Map<string, string>();
    for (const rel of [...walk('memory'), ...walk('agent')]) corpus.set(rel, stripComments(read(rel)));
    for (const e of engineSources()) corpus.set(e.rel, stripComments(e.text));
    expect(corpus.has('memory/recall.ts') && corpus.has('memory/assembler.ts') && corpus.size > 150, 'the corpus is whole').toBe(true);
    const NULL_AS_MINE = [
      /!\s*[\w.]+\??\.conversationId\s*\|\|/,                              // TS: `!m.conversationId || …`
      /conversation_id IS NULL\s+AND\s+\(?\s*role IN \('assistant'/,            // SQL: untagged own row = mine
      /\(\s*conversation_id IS NULL\s+OR\s+conversation_id\s*=/,               // SQL: NULL-or-this-one
    ];
    const hits = [...corpus].flatMap(([rel, text]) => NULL_AS_MINE.filter((re) => re.test(text)).map((re) => `${rel} ${re}`));
    expect(hits).toEqual([]);
    // ...and the positive half: recall now reads the LABEL, as the scopers do.
    expect(corpus.get('memory/recall.ts')).toMatch(/IFNULL\(subject_kind/);
  });

  it('round 3 (N-1): ONE neutraliser, and every value a label writer interpolates is accounted for — both ways', () => {
    // The neutraliser is defined once in the whole production tree.
    const walk = (dir: string): string[] => fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((d) => {
      const rel = `${dir}/${d.name}`;
      if (d.isDirectory()) return d.name === '__tests__' ? [] : walk(rel);
      return d.name.endsWith('.ts') ? [rel] : [];
    });
    const defs = walk('.').filter((f) => /function labelText\(/.test(stripComments(read(f))));
    expect(defs).toEqual(['./memory/row-label.ts']);
    // Every `${…}` in the label module: either outside text passed through `labelText(…)`, or one of
    // these platform-built pieces (themselves composed only of neutralised parts). A new
    // interpolation of anything else — a raw subject, sender, name, intent — changes this list.
    const src = stripComments(read('memory/row-label.ts'));
    const interps: string[] = [];
    for (let i = src.indexOf('${'); i >= 0; i = src.indexOf('${', i + 2)) {
      let d = 0; let j = i + 2;
      for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { if (d === 0) break; d--; } }
      interps.push(src.slice(i + 2, j));
    }
    expect(interps.filter((e) => e.startsWith('labelText(')).length).toBe(16);
    expect(interps.filter((e) => !e.startsWith('labelText('))).toEqual([
      's.slice(0, cap)',
      'CHANNEL_PHRASE[c.channel] ?? `${labelText(c.channel, 24)} conversation`',
      'who', 'subj', 'subj ? `, subject "${subj}"` : \'\'', 'subj',
      'renderInstant(r.created_at)',
      'o.intent ? `: ${labelText(o.intent, 32)}` : \'\'',
      'subj', 'subj ? `, subject "${subj}"` : \'\'', 'subj',
      '(m.conversationId && facts.conversation(m.conversationId)) || \'a person\\\'s conversation\'',
      'notice', 'where', 'asked ? `, for the request of ${asked}` : \'\'', 'asked',
      'at.slice(0, -1)', 'subject', 'subject',
      'o?.intent ? `: ${labelText(o.intent, 32)}` : \'\'',
    ]);
    // The EVENTS bullet carries outside text only through the addressee and the neutralised gist.
    const asm = stripComments(read('memory/assembler.ts'));
    expect(asm).toMatch(/\[\$\{eventAddressee\(m\)\}\] \$\{gist\}/);
    expect(asm.match(/labelText\(meta\?\.(sender|emailSubject)/g) ?? []).toHaveLength(2);
  });

  it('the late stamp is DELETED with its three callers: one conversation writer is left, for inbound rows', () => {
    const store = stripComments(read('memory/message-store.ts'));
    // The one `UPDATE messages SET conversation_id` left is the inbound pickup repair (a
    // person's row no door resolved). A late stamp of the agent's own rows would be a second.
    expect(store.match(/UPDATE messages SET conversation_id/g) ?? []).toHaveLength(1);
    expect(store).not.toMatch(/function tagTurnOutputConversationId/);
    // The engine corpus through the shared derivation (`engine-sources.ts`), never a path walk.
    const callers = engineSources().filter((e) => /tagTurnOutputConversationId|tagTurnOutputs\(/.test(stripComments(e.text)));
    expect(callers.map((e) => e.rel)).toEqual([]);
  });
});
