// ════════════════════════════════════════════════════════════════════════════════════════
// EVERY CHANNEL-INBOUND PRODUCER PUTS THE PERSON'S CONVERSATION ON THE WIRE.
//
// t106 fixed this for the dashboard's own door (`gateway/routes/chat.ts`, commit `6302f7fa`)
// and handed up the rest: `messages.conversation_id` is stamped at ingest and projected by the
// history route, so a RELOADED feed always carried it — but the `chat:message` frame the LIVE
// feed builds its row from did not, and `lib/working-note-visibility.ts` R4 reads that column
// to tell a PERSON'S message apart from an engine-synthetic trigger. One fact served two ways,
// and with R4 in place it is a visible disagreement: a routed-channel reply stayed collapsed
// until the owner refreshed, then quietly un-collapsed.
//
// Seven producers in this family omitted it the same way. One of them —
// `gateway/routes/twilio.ts`'s voicemail door — resolved NO conversation at all, so its reload
// path was wrong too and no frame field alone could have fixed it; it now resolves the caller's
// phone identity exactly as `twilio/call-session.ts` does for the same caller.
//
// ── WHY THE CENSUS IS SCOPED TO "RESOLVES A CONVERSATION", AND WHY THAT IS THE RIGHT LINE ──
// A tree-wide sweep for user-role frames finds twenty, and most of them SHOULD carry no
// conversation: the Healer, the scheduler, the PM poke, the rate-limit notice, the scaffold
// title, vault maintenance and the technique importers all synthesise a `role:'user'` row with
// no person behind it, and telling those apart from a person's question is the whole of what
// R4 does. So the census keys on the producer's own act of resolving an identity — a module
// that calls `resolveOrCreateConversation` has decided there IS a person — and requires every
// user-role frame it sends to carry it.
//
// BOTH DIRECTIONS (G4): the set is DERIVED by walking the tree, not listed. A new channel
// producer that resolves a conversation and broadcasts a person's row without the field is red
// here on the day it is added, and a producer that stops resolving one leaves the set honestly.
// Comments are stripped first, so the prose above a call cannot satisfy a clause.
//
// ⚠ ONE FILE IS DELIBERATELY OUT OF SCOPE AND IS NOT AN EXEMPTION: `gateway/routes/chat.ts` is
// t106's fence and t106 has already fixed it on its own branch. The scanned roots are this
// lane's own (`services/`, `twilio/`, and the one webhook route in `gateway/routes/`), so this
// file neither duplicates that clause nor reds against a branch it cannot edit.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The roots this lane owns. `gateway/routes/` is included for the Twilio webhook door. */
const ROOTS = ['services', 'twilio', 'gateway/routes'];

/**
 * NOT AN EXEMPTION — A FENCE. `gateway/routes/chat.ts` is the dashboard's own door and it is
 * t106's fence; t106 fixed it in `6302f7fa` with its own clause (`the-live-frame-carries-the-
 * conversation.test.ts`). It is excluded BY NAME rather than by narrowing the walk, so this
 * census still sweeps the whole of `gateway/routes/` and a NEW webhook door there is caught.
 * When t106 merges, the two clauses cover one family from two files, deliberately.
 */
const OTHER_LANES: Record<string, string> = {
  'gateway/routes/chat.ts': 't106 owns this door and fixed it in 6302f7fa, with its own clause',
};

/** Source with comments removed — only code may satisfy a clause. */
function codeOf(abs: string): string {
  return fs.readFileSync(abs, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

function filesUnder(rel: string): string[] {
  const root = path.join(SRC, rel);
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.name === '__tests__') continue;
    const abs = path.join(root, e.name);
    if (e.isDirectory()) out.push(...filesUnder(path.join(rel, e.name)));
    else if (e.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

/** Every `broadcast({ … })` argument literal in a source, by brace matching (t106's shape). */
function broadcastLiterals(src: string): string[] {
  const out: string[] = [];
  for (let i = src.indexOf('broadcast({'); i !== -1; i = src.indexOf('broadcast({', i + 1)) {
    let depth = 0;
    const open = src.indexOf('{', i);
    for (let j = open; j < src.length; j += 1) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') { depth -= 1; if (depth === 0) { out.push(src.slice(open, j + 1)); break; } }
    }
  }
  return out;
}

interface Producer { rel: string; frames: string[] }

/** The DERIVED set: a module that resolves a person's conversation and broadcasts their row. */
function channelInboundProducers(): Producer[] {
  const out: Producer[] = [];
  for (const root of ROOTS) {
    for (const abs of filesUnder(root)) {
      const src = codeOf(abs);
      const rel0 = path.relative(SRC, abs);
      if (OTHER_LANES[rel0] !== undefined) continue;
      if (!/resolveOrCreateConversation\(/.test(src)) continue;
      const frames = broadcastLiterals(src)
        .filter((f) => f.includes("type: 'chat:message'"));
      if (frames.length === 0) continue;
      out.push({ rel: path.relative(SRC, abs), frames });
    }
  }
  return out;
}

describe('a channel-inbound frame carries the conversation its insert already resolved', () => {
  it('the census finds the producers at all — an empty set would pass every clause below', () => {
    const found = channelInboundProducers().map((p) => p.rel).sort();
    // The seven the hand-up named, by their real paths. Named here so the set SHRINKING is as
    // visible as it growing: a producer silently losing its resolve is a regression, not a pass.
    expect(found).toEqual([
      'gateway/routes/twilio.ts',
      'services/gmail-watcher.ts',
      'services/imessage-bridge.ts',
      'services/outlook-watcher.ts',
      'services/teams-watcher.ts',
      'twilio/call-session.ts',
      'twilio/sms-inbound.ts',
    ]);
  });

  it('⚠ THE RED: every `chat:message` frame these producers send carries `conversationId`', () => {
    const missing: string[] = [];
    for (const p of channelInboundProducers()) {
      p.frames.forEach((f, i) => {
        if (!/\bconversationId\b/.test(f)) missing.push(`${p.rel} frame #${i + 1}`);
      });
    }
    expect(missing, 'a person\'s row went out without the conversation the insert resolved — '
      + 'its reply promotes only on refresh (t106 R4). Add `conversationId` to the broadcast\'s '
      + 'message object from the id this producer already resolved.').toEqual([]);
  });

  it('…and it is the SAME binding, never a second resolve at the frame', () => {
    // One fact, one writer. A producer that re-resolved at the broadcast could hand the wire an
    // identity the stored row does not carry, which is this defect wearing the other face.
    for (const p of channelInboundProducers()) {
      for (const f of p.frames) {
        expect(f, `${p.rel} re-resolves the conversation inside its own frame`)
          .not.toMatch(/resolveOrCreateConversation\(/);
      }
    }
  });

  it('the voicemail door resolves an identity before it inserts — the two-line case', () => {
    // It is the only one of the seven whose RELOAD path was wrong as well, because it stamped
    // no `conversation_id` at all. Pinned by shape: the resolve must precede the insert, and the
    // insert must name it, or the row goes back to being an orphan the frame cannot rescue.
    const src = codeOf(path.join(SRC, 'gateway/routes/twilio.ts'));
    const resolve = src.indexOf('resolveOrCreateConversation(primaryId');
    const insert = src.indexOf('insertInboundMessageIfAbsent({');
    expect(resolve, 'the voicemail door stopped resolving a conversation').toBeGreaterThan(-1);
    expect(resolve, 'the resolve moved after the insert — the row is stamped from nothing')
      .toBeLessThan(insert);
    expect(src.slice(insert, insert + 400)).toMatch(/\bconversationId,/);
  });

  it('the other-lane row is exact — a stale fence entry is a clause nobody re-reads', () => {
    for (const [rel, why] of Object.entries(OTHER_LANES)) {
      expect(fs.existsSync(path.join(SRC, rel)), `${rel} no longer exists — drop the row`).toBe(true);
      expect(why.length, `${rel} carries no written reason`).toBeGreaterThan(20);
      // And it must still BE a producer of this family, or it does not belong in this table.
      const src = codeOf(path.join(SRC, rel));
      expect(/resolveOrCreateConversation\(/.test(src),
        `${rel} is no longer a channel-inbound producer — drop the row`).toBe(true);
    }
  });

  it('an engine-synthetic user row is NOT in this set, and that is the point of the predicate', () => {
    // R4 exists to tell a person's question from an engine trigger. These doors synthesise a
    // `role:'user'` row with nobody behind it and resolve no conversation, so they are out of
    // the set by construction rather than by an exemption somebody has to maintain.
    const synthetic = [
      '../healer/healer-agent.ts', '../tracker/notify.ts', '../tracker/pm-agent.ts',
      '../agent/rate-limit-retry.ts', '../vault/maintenance.ts', '../google/reauth-notice.ts',
    ];
    for (const rel of synthetic) {
      const src = codeOf(path.resolve(SRC, 'services', rel));
      expect(/resolveOrCreateConversation\(/.test(src),
        `${rel} began resolving conversations — re-read this census's scope`).toBe(false);
    }
  });
});
