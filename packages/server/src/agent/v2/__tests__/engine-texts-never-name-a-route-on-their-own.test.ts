// 3.5, Task 6: the owner's law, as a harness test. The agent always knows who it is talking to and
// who it is sending to. No engine-written text names a reply route, or "the user", as a literal
// on its own: it reads the turn's address (or is on the sweep list below, to be reworded).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SWEEP, ALLOW } from './route-text-inventory.js';
import '../../../prompt/registry/entries.js';
import { getMessageEntries } from '../../../prompt/registry/registry.js';
import { renderCounterpartyHeader, type TurnCounterparty } from '../counterparty.js';
import { compileSteerText } from '../../../work/join-drive.js';
import { startAckSteerText } from '../steps/assemble/start-ack-door.js';
import { computeTurnAddress } from '../turn-address.js';
import { refuseSendWithNoRecipient, recipientNoteFor, routedReplyWords } from '../send-recipient.js';
import { openTurnContext, endTurnContext } from '../../turn-context.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');   // packages/server/src

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') walk(rel, out); } else if (e.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}
const SCOPE_FILES = [
  ...walk('agent/v2'),
  'agent/a2a-transport.ts', 'agent/runtime.ts', 'tracker/tools.ts', 'agent/tools/cat/comms.ts',
  'agent/tools/cat/media.ts', 'tools/name-help.ts', 'agent/tools/surface.ts', 'agent/tools/util.ts',
  'services/image-generation.ts', 'agent/access/engine-route.ts', 'work/join-drive.ts',
].sort();
const ROUTE_WORDS = /\bthe user\b|\bThe user\b|\bTHE USER\b|dashboard chat|reply to the owner|as your chat reply|owner's channel|owner is watching|(?:directly )?in (?:this|the) conversation\b|\bin chat\b/;

/** Source lines of the scoped files that hold a string literal naming the person or a route. */
function hits(): Array<{ file: string; line: string }> {
  const out: Array<{ file: string; line: string }> = [];
  for (const file of SCOPE_FILES) {
    for (const raw of fs.readFileSync(path.join(SRC, file), 'utf8').split('\n')) {
      const t = raw.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      if (!/['`"]/.test(raw)) continue;
      const code = raw.replace(/\s\/\/.*$/, '');
      if (ROUTE_WORDS.test(code) && !/logger\.|auditLog\(|^\s*import /.test(code)) out.push({ file, line: t });
    }
  }
  return out;
}

describe('the census: no engine text names a person or a route on its own without being listed', () => {
  it('every site is allowed (with a reason) or on the sweep list', () => {
    const listed = new Set([...SWEEP.map((s) => `${s.file}\u0000${s.old}`), ...ALLOW.map((a) => `${a.file}\u0000${a.line}`)]);
    const unlisted = hits().filter((h) => !listed.has(`${h.file}\u0000${h.line}`));
    expect(unlisted.map((u) => `${u.file}: ${u.line.slice(0, 120)}`),
      'a NEW engine text names "the user" or a reply route as a literal: read the turn address instead (agent/v2/turn-address.ts: userWords, replyChannelWords, currentAddress), or add it to ALLOW with a reason').toEqual([]);
  });

  it('every allowed entry carries a reason', () => {
    for (const a of ALLOW) expect(a.reason.length, `${a.file}: ${a.line.slice(0, 60)}`).toBeGreaterThan(10);
  });
});

describe('TASK 6 SWEEP LIST: texts still to be reworded (each case is EXPECTED TO FAIL until its line is swept)', () => {
  // `it.fails` passes while the old words are still in the file. Once the line has been reworded
  // the case starts failing: delete that entry from SWEEP in route-text-inventory.ts.
  for (const s of SWEEP) {
    it.fails(`${s.id} ${s.file}: no longer says the old words (see the sweep list: new = ${s.new.slice(0, 70)})`, () => {
      const lines = fs.readFileSync(path.join(SRC, s.file), 'utf8').split('\n').map((l) => l.trim());
      expect(lines).not.toContain(s.old);
    });
  }
});

// ── The second law: a turn whose counterparty is a contact never gets owner-route text ──
const contact: TurnCounterparty = { kind: 'user', name: 'Pat Example', relation: 'known_contact', channel: 'imessage', senderId: '+15550100', threadId: null, senderIsAgent: false };
const FORBIDDEN = /dashboard chat|the owner is watching|reply to the owner|as your chat reply|owner's channel|in this conversation \(do NOT|send Owner Example a note, a promise/i;

describe('a contact\'s turn never gets owner-route text, on any outbound path the engine writes', () => {
  const addr = computeTurnAddress({ autoRoutes: true, counterparty: contact, isEngineTurn: false, isNotificationTurn: false, inboundChannel: 'imessage', inboundContext: null, presence: 'in_dojo', imessageBridgeConfigured: true, ownerAffinityChannel: null });

  it('the turn block, the start-ack steer, the compile steer, the send-tool results and the failure words', () => {
    endTurnContext('primary');
    openTurnContext('primary').address = addr;
    const entry = getMessageEntries().find((e) => e.id === 'msg.turn-context')!;
    const block = (entry.render as (c: unknown) => { content: string })({
      agentId: 'primary', lastUserMessageContent: 'hi', isPrimary: true, ownerName: 'Owner Example',
      replyDestination: addr.deliveryChannel, replyRecipientName: contact.name, inboundChannel: 'imessage', smsFromNumber: null, phoneFromNumber: null,
      turnContext: { counterparty: contact, address: addr, othersWaiting: 1, conversationalTurn: true },
    }).content;
    const texts: Record<string, string> = {
      'turn block (header, tag, hints)': block,
      'header alone': renderCounterpartyHeader(contact, { address: addr }),
      'start-ack steer': startAckSteerText({ address: addr } as never),
      'compile steer (asker = this contact)': compileSteerText({ total: 2, pieces: ['x'], attempt: 1, bound: 3, asker: { name: contact.name, channel: 'iMessage' } }),
      'no-recipient refusal': refuseSendWithNoRecipient('primary', 'imessage_send', { message: 'x' }, 'c')!.content,
      'send note (someone else)': recipientNoteFor('primary', 'sms_send', { to: '+15550123', body: 'x' }),
      'failure words': routedReplyWords('primary') ?? '',
    };
    for (const [name, text] of Object.entries(texts)) {
      expect(text, name).not.toMatch(FORBIDDEN);
      expect(text.length, name).toBeGreaterThan(0);
    }
    // And the contact is named wherever a text says who it is talking to.
    expect(texts['turn block (header, tag, hints)']).toContain('Pat Example');
    expect(texts['no-recipient refusal']).toContain('Pat Example');
    endTurnContext('primary');
  });
});
