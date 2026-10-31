// THE imessage_send ATTACHMENT WORDING.
//
// When every attachment failed and only the words were re-sent alone, the bridge
// answers `{ ok: false, sentFiles: [], failedFiles: [all], textSent: true }` and
// the success string read "iMessage sent to X with 0/2 attachment(s) (failed:
// /a.png, /b.png)." — the model reads that as a send that happened, and the
// recipient never got the files. The three cases below are the three shapes the
// bridge can hand back with attachments: all in, one short, none in.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };

// The send itself is replaced whole: each case hands back the one recorded
// outcome the bridge produces for that shape.
const bridgeSend = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-imessage-send-result-wording', 'dojo.db'),
  };
});

// The bridge runs (that is the precondition for reaching the send at all) and
// every other bridge entry stays real — the safe-sender reader the recipient
// gate depends on is one of them.
vi.mock('../../../../services/imessage-bridge.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../services/imessage-bridge.js')>();
  return {
    ...real,
    getIMBridgeStatus: () => ({
      running: true, enabled: true, connected: true,
      approvedSenders: [], safeSenders: [], lastSeenRowId: 0,
    }),
    sendIMessageWithAttachments: bridgeSend.fn,
  };
});

// The effects facade performs I/O only inside a gate-loop-authorized call; this suite
// calls the handler directly, so it is backed by the real fs here.
vi.mock('../../../effects/fs.js', () => ({
  existsSync: (target: fs.PathLike) => fs.existsSync(target),
  statSync: (target: fs.PathLike) => fs.statSync(target),
}));

import { FX } from '../../../../../../../deploy/checks/fixture-vocabulary.mjs';
import { runMigrations } from '../../../../db/migrations.js';
import { commsHandlers } from '../comms.js';
import { reloadApprovedSenders } from '../../../../services/imessage-bridge.js';

const AGENT = 'a1';

let dir = '';
let fileA = '';
let fileB = '';

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
  ).run(JSON.stringify([{ name: FX.n11, address: '+15550200', is_primary: true }]));
  reloadApprovedSenders();

  // Real files for the attachment pre-flight — it refuses before the send what
  // it cannot find on disk.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-imessage-wording-'));
  fileA = path.join(dir, 'a.png');
  fileB = path.join(dir, 'b.png');
  fs.writeFileSync(fileA, 'PNG-A');
  fs.writeFileSync(fileB, 'PNG-B');

  bridgeSend.fn.mockReset();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

function send() {
  return commsHandlers['imessage_send']!(
    { agentId: AGENT, args: { recipient: '+15550200', message: 'The renders are attached', attachments: [fileA, fileB] } } as never,
  );
}

describe('imessage_send attachment summary', () => {
  it('counts every attachment that went out', async () => {
    bridgeSend.fn.mockResolvedValue({ ok: true, sentFiles: [fileA, fileB], failedFiles: [], textSent: true });
    const out = await send();
    expect(out.content).toContain('2/2 attachment(s)');
  });

  it('counts a partial send and names the file that did not go', async () => {
    bridgeSend.fn.mockResolvedValue({ ok: false, sentFiles: [fileA], failedFiles: [fileB], textSent: true });
    const out = await send();
    expect(out.content).toContain('1/2');
    expect(out.content).toContain('failed:');
  });

  it('says the words went alone when NONE of the attachments did', async () => {
    bridgeSend.fn.mockResolvedValue({ ok: false, sentFiles: [], failedFiles: [fileA, fileB], textSent: true });
    const out = await send();
    expect(out.content).toContain('as text only');
    expect(out.content).toContain('NONE of the 2');
  });
});
