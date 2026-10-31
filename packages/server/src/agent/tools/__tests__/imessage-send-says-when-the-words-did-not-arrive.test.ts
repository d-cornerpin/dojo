// A PICTURE SENT WITHOUT ITS WORDS READS AS A PERFECT SEND.
//
// When a file goes out while its caption fails — even after the bridge's own
// retry of the words — `sendIMessageWithAttachments` (imessage-bridge.ts)
// answers `{ ok: true, sentFiles: [file], failedFiles: [], textSent: false }`:
// `ok` is only "no file failed". `comms.ts` then handed the agent
// "iMessage sent to X with 1/1 attachment(s).", the audit row said `success`,
// and the agent told the owner the whole message landed. The person got a
// picture with none of its words, and nobody was told the words were missing.
// The send string has to say the words did not arrive.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };

// The send is replaced whole: each case hands back the exact shape the real
// bridge records for that outcome. Nothing goes out — no imsg, no osascript,
// no network.
const bridgeSend = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-imessage-words-not-arrived', 'dojo.db'),
  };
});

// The bridge runs (the precondition for reaching the send at all); every other
// bridge entry stays real — the safe-sender reader the recipient gate depends
// on is one of them.
vi.mock('../../../services/imessage-bridge.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../services/imessage-bridge.js')>();
  return {
    ...real,
    getIMBridgeStatus: () => ({
      running: true, enabled: true, connected: true,
      approvedSenders: [], safeSenders: [], lastSeenRowId: 0,
    }),
    sendIMessageWithAttachments: bridgeSend.fn,
  };
});

// The effects facade performs I/O only inside a gate-loop-authorized call; this
// suite calls the handler directly, so it is backed by the real fs here.
vi.mock('../../effects/fs.js', () => ({
  existsSync: (target: fs.PathLike) => fs.existsSync(target),
  statSync: (target: fs.PathLike) => fs.statSync(target),
}));

import { FX } from '../../../../../../deploy/checks/fixture-vocabulary.mjs';
import { runMigrations } from '../../../db/migrations.js';
import { commsHandlers } from '../cat/comms.js';
import { reloadApprovedSenders } from '../../../services/imessage-bridge.js';

const AGENT = 'a1';
const RECIPIENT = '+15550100198';

let dir = '';
let fileA = '';

beforeEach(() => {
  const fresh = new Database(':memory:');
  fresh.pragma('foreign_keys = ON');
  mockDb.current = fresh;
  runMigrations();
  fresh.pragma('foreign_keys = ON');
  fresh.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Primary', 'idle', '1970-01-01')`,
  ).run(AGENT);
  fresh.prepare(
    "INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)",
  ).run(JSON.stringify([{ name: FX.n11, address: RECIPIENT, is_primary: true }]));
  reloadApprovedSenders();

  // A real file — the attachment pre-flight refuses what it cannot find on disk.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-imessage-words-'));
  fileA = path.join(dir, 'a.png');
  fs.writeFileSync(fileA, 'PNG-A');

  bridgeSend.fn.mockReset();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

function send(message: string) {
  return commsHandlers['imessage_send']!(
    { agentId: AGENT, args: { recipient: RECIPIENT, message, attachments: [fileA] } } as never,
  );
}

describe('imessage_send says when the words did not arrive', () => {
  it('a file that went out without its caption says the text did NOT arrive', async () => {
    // The incident shape: the file landed, the words failed twice, `ok` is true.
    bridgeSend.fn.mockResolvedValue({ ok: true, sentFiles: [fileA], failedFiles: [], textSent: false });
    const out = await send('hello');
    // The file did go, so this stays a success — but it must not read as a whole send.
    expect(out.isError).toBe(false);
    expect(out.content).toContain('did NOT arrive');
  });

  it('CONTROL — everything in: the success string is the one that has always been here', async () => {
    bridgeSend.fn.mockResolvedValue({ ok: true, sentFiles: [fileA], failedFiles: [], textSent: true });
    const out = await send('hello');
    expect(out.isError).toBe(false);
    expect(out.content).toBe(`iMessage sent to ${FX.n11} (+15550100198) with 1/1 attachment(s).`);
    expect(out.content).not.toContain('NOT');
  });

  it('CONTROL — attachment only: no words were owed, so nothing warns', async () => {
    bridgeSend.fn.mockResolvedValue({ ok: true, sentFiles: [fileA], failedFiles: [], textSent: false });
    const out = await send('');
    expect(out.isError).toBe(false);
    expect(out.content).not.toContain('NOT');
  });
});
