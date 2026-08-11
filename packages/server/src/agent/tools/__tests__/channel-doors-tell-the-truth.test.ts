// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 7 T29 — CHANNEL DOORS TELL THE TRUTH ABOUT ALTERNATIVES.
//
// THE RED, recorded at HEAD 3cafa8d, three doors, three strings:
//
//  1. imessage_send with the bridge down:
//       "iMessage bridge is currently disabled, so this message was NOT sent. Tell the user
//        that iMessage is turned off on this server and respond to them in the dashboard chat
//        instead. To re-enable iMessage delivery, the user can start it from Settings →
//        Channels (iMessage card)."
//     — prescribing the dashboard while `twilio_config` on the same box read
//       enabled=1, sms_enabled=1 and `twilio_sms_approved_senders` carried David at
//       +15550200. Round-7 S3: the user asked for a text; no text was sent on any channel.
//
//  2. gate ladder row 7, for a sub-agent:
//       "Permission denied: only the primary agent can call imessage_send. Escalate to the
//        primary agent instead."
//     — true, and silent about which channel the escalation should be about.
//
//  3. the relay-refusal alert (`a2a-transport.ts`), which fired on a DASHBOARD-origin join:
//       "Heads up: I could not send that answer back on dashboard, so it is here on the
//        dashboard instead. only the primary agent may send on the owner's channels, and this
//        join belongs to another agent."   (message 0dc84832, 2026-08-11 00:38:27)
//     — about an answer that had delivered fine, and against the arm's own ⚠ comment.
//
// THE WALL IS NOT TOUCHED. Only its guidance is. Every clause below that widens anything has
// a control beside it that must still refuse.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-t29-channel-doors', 'dojo.db'),
  };
});

// The bridge is DOWN for every clause here — that is the door under test. Only the status
// reader is replaced; `parseSafeSenders` and the rest stay real, because the safe-sender
// reader the alternative depends on is one of its callers.
const bridgeRunning = { value: false };
vi.mock('../../../services/imessage-bridge.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../services/imessage-bridge.js')>();
  return {
    ...real,
    getIMBridgeStatus: () => ({
      running: bridgeRunning.value, enabled: true, connected: false,
      approvedSenders: [], safeSenders: [], lastSeenRowId: 0,
    }),
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { gatesForCall } from '../gates.js';
import { commsHandlers } from '../cat/comms.js';
import { getSmsReachability, describeSmsRecipients } from '../../../services/capability-registry.js';
import { originHasNoRelayDoor } from '../../a2a-transport.js';

const AGENT = 'sub-agent-1';
const db = (): Database.Database => mockDb.current!;

function enableTwilioSms(approved: Array<{ name: string; address: string }>): void {
  db().prepare(
    `INSERT OR REPLACE INTO twilio_config
       (id, account_sid, auth_token_ciphertext, enabled, sms_enabled, voice_enabled)
     VALUES (1, 'AC_test', 'ciphertext', 1, 1, 0)`,
  ).run();
  db().prepare(
    `INSERT OR REPLACE INTO config (key, value) VALUES ('twilio_sms_approved_senders', ?)`,
  ).run(JSON.stringify(approved.map((a) => ({ ...a, is_primary: false }))));
}

beforeEach(() => {
  const fresh = new Database(':memory:');
  fresh.pragma('foreign_keys = ON');
  mockDb.current = fresh;
  runMigrations();
  fresh.pragma('foreign_keys = ON');
  fresh.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Sub', 'idle', '1970-01-01')`,
  ).run(AGENT);
  bridgeRunning.value = false;
});

// ══════════════════════════════════════════════════════════════════════════════
// §1 — THE FACT. Read at the moment of refusal, never asserted statically.
// ══════════════════════════════════════════════════════════════════════════════
describe('SMS reachability is a live read, not a claim', () => {
  it('nothing configured: not live, nobody named', () => {
    expect(getSmsReachability()).toEqual({ live: false, approved: [] });
  });

  it('enabled AND approved: live, with the recipients named', () => {
    enableTwilioSms([{ name: 'David', address: '+15550200' }]);
    const r = getSmsReachability();
    expect(r.live).toBe(true);
    expect(describeSmsRecipients(r)).toBe('David (+15550200)');
  });

  it('enabled with NOBODY approved is NOT an alternative — the sender would refuse it', () => {
    enableTwilioSms([]);
    expect(getSmsReachability().live).toBe(false);
  });

  it('sms_enabled off is not live even with an allowlist', () => {
    enableTwilioSms([{ name: 'David', address: '+15550200' }]);
    db().prepare('UPDATE twilio_config SET sms_enabled = 0 WHERE id = 1').run();
    expect(getSmsReachability().live).toBe(false);
  });

  it('a long allowlist cannot run away with a door\'s text', () => {
    enableTwilioSms([1, 2, 3, 4, 5].map((n) => ({ name: `P${n}`, address: `+1555020${n}` })));
    expect(describeSmsRecipients(getSmsReachability())).toBe(
      'P1 (+15550201), P2 (+15550202), P3 (+15550203) and 2 more');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §2 — DOOR 1. The bridge-is-down refusal, driven through the real handler.
// ══════════════════════════════════════════════════════════════════════════════
describe('the imessage-disabled door', () => {
  const send = () => commsHandlers['imessage_send']!(
    { agentId: AGENT, args: { recipient: '+15550200', message: 'hi' } } as never,
  );

  it('names sms_send FIRST when SMS is live, with the dashboard as the last resort', async () => {
    enableTwilioSms([{ name: 'David', address: '+15550200' }]);
    const out = await send();
    expect(out.isError).toBe(true);
    expect(out.content).toContain('iMessage bridge is currently disabled, so this message was NOT sent.');
    expect(out.content).toContain('SMS IS live on this server (approved: David (+15550200))');
    expect(out.content).toContain('send it with sms_send instead');
    // the dashboard is still offered — but after, and only as the fallback
    expect(out.content.indexOf('sms_send')).toBeLessThan(out.content.indexOf('dashboard chat'));
  });

  it('CONTROL — nothing else live: the sentence is byte-identical to the one at HEAD', async () => {
    const out = await send();
    expect(out.content).toBe(
      'iMessage bridge is currently disabled, so this message was NOT sent. '
      + 'Tell the user that iMessage is turned off on this server and respond to them in the dashboard chat instead. '
      + 'To re-enable iMessage delivery, the user can start it from Settings → Channels (iMessage card).');
  });

  it('CONTROL — the door still REFUSES; naming an alternative is not sending one', async () => {
    enableTwilioSms([{ name: 'David', address: '+15550200' }]);
    const out = await send();
    expect(out.isError).toBe(true);
    expect(out.content).toContain('NOT sent');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §3 — DOOR 2. Ladder row 7. The wall is unchanged; the escalation gains an aim.
// ══════════════════════════════════════════════════════════════════════════════
describe('the sub-agent permission wall', () => {
  const row7 = () => gatesForCall('imessage_send', {}).find((g) => g.row === '7');

  it('still fires, still primary_only, for both walled tools', () => {
    for (const tool of ['imessage_send', 'imessage_list_contacts']) {
      const g = gatesForCall(tool, {}).find((x) => x.row === '7');
      expect(g, tool).toBeDefined();
      expect(g!.kind).toBe('primary_only');
    }
  });

  it('names the channel that IS live, so the escalation is about the right door', () => {
    enableTwilioSms([{ name: 'David', address: '+15550200' }]);
    const g = row7()!;
    expect(g.message).toContain('only the primary agent can call imessage_send.');
    expect(g.message).toContain('SMS is enabled on this server (approved: David (+15550200))');
    // and it does NOT offer the sub-agent a tool it also may not call
    expect(g.message).toContain('sms_send is primary-only too');
    expect(g.message).toContain('Escalate to the primary agent');
  });

  it('CONTROL — nothing live: the message is byte-identical to the one at HEAD', () => {
    expect(row7()!.message).toBe(
      'Permission denied: only the primary agent can call imessage_send. '
      + 'Escalate to the primary agent instead.');
  });

  it('CONTROL — no OTHER row gained a channel clause', () => {
    enableTwilioSms([{ name: 'David', address: '+15550200' }]);
    const g13 = gatesForCall('cost_summary', {}).find((x) => x.row === '13');
    expect(g13!.message).toBe('Permission denied: only the primary agent can call cost_summary.');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §4 — THE ALERT ARM. It fires for a refusal, never for the ordinary case.
// ══════════════════════════════════════════════════════════════════════════════
describe('the relay-refusal alert stops firing on joins with no door to refuse them', () => {
  it('a DASHBOARD-origin join has no channel to be refused from (the incident)', () => {
    expect(originHasNoRelayDoor('dashboard')).toBe(true);
  });

  it('a voice-origin join likewise — the call is over, the dashboard IS the delivery', () => {
    expect(originHasNoRelayDoor('voice')).toBe(true);
  });

  it('an unstamped ask likewise — the arm\'s original case, unchanged', () => {
    expect(originHasNoRelayDoor(null)).toBe(true);
    expect(originHasNoRelayDoor(undefined)).toBe(true);
  });

  it('CONTROL — every REAL channel still has a door, so a refusal on it still alerts', () => {
    for (const ch of ['imessage', 'teams', 'email', 'sms']) {
      expect(originHasNoRelayDoor(ch), ch).toBe(false);
    }
  });

  it('CONTROL — a channel nobody has declared yet still alerts under its own name', () => {
    expect(originHasNoRelayDoor('whatsapp')).toBe(false);
  });

  it('the seed of the relay\'s refusal is GUARDED by that law, not by a copy of it', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, '../../a2a-transport.ts'), 'utf8');
    const at = src.indexOf('let relayRefusal: OwnerChannelRelayRefusal | null =');
    expect(at).toBeGreaterThan(-1);
    const seed = src.slice(at, src.indexOf(';', at));
    expect(seed).toContain('originHasNoRelayDoor(meta.channel)');
    expect(seed).toContain('ownerChannelRelayRefusal(');
  });
});
