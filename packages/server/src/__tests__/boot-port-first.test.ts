// PHASE-0 T12c Step 1 — the port is the mutual exclusion.
//
// Boot mutates the real database: it creates ~/.dojo/data, opens dojo.db, runs
// every pending migration, seeds config rows and re-arms timers. Before this
// task the listen/bind was the LAST thing main() did, so a second instance
// started against a box that was already running did all of that to the running
// box's database and only then discovered the port was taken.
//
// This test starts a real second instance against a port something else already
// holds and asserts the canaries NEVER move. connection.ts derives its path from
// os.homedir(), which on POSIX is $HOME, so pointing HOME at a temp directory
// gives the child its own would-be database and nothing goes near the live one
// on :3001.
//
// The scratch database is seeded to look like an ESTABLISHED box, not a fresh
// one, because the two boot writes have opposite triggers:
//
//   • runMigrations() — writes when _migrations is missing or behind. Canary:
//     the _migrations table must still not exist.
//   • the startup recovery sweep — flips agents stuck in 'working' to 'idle'
//     and broadcasts it. It only fires when the agents table EXISTS, so a fresh
//     scratch home would skip it and the test would pass on a box the real fix
//     had not reached. Canary: the seeded stuck agent must still be 'working'.
//
// Seeding a schema the child could reject would also fake a pass, so both
// canaries were proven to MOVE against the pre-fix code before being kept.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(HERE, '..', 'index.ts');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

// The bind retry (5 attempts, 2s apart) plus tsx start-up. Generous so a slow
// machine cannot turn a pass into a flake.
const EXIT_BUDGET_MS = 60_000;

const STUCK_AGENT = 'canary-agent';

let squatter: net.Server;
let busyPort: number;
let scratchHome: string;
let scratchDbPath: string;

function seedEstablishedBox(): void {
  scratchDbPath = path.join(scratchHome, '.dojo', 'data', 'dojo.db');
  fs.mkdirSync(path.dirname(scratchDbPath), { recursive: true });
  const db = new Database(scratchDbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, model_id TEXT,
      updated_at TEXT, created_at TEXT
    );
    CREATE TABLE models (id TEXT PRIMARY KEY, provider_id TEXT);
  `);
  // Stale enough that the stuck-agent sweep would reap it (its threshold is
  // well under a day) — this is the row the boot path must not touch.
  db.prepare(`
    INSERT INTO agents (id, name, status, model_id, updated_at, created_at)
    VALUES (?, 'Canary', 'working', NULL, datetime('now', '-2 days'), datetime('now', '-9 days'))
  `).run(STUCK_AGENT);
  db.close();
}

beforeAll(async () => {
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-portfirst-'));
  seedEstablishedBox();
  squatter = net.createServer();
  await new Promise<void>((resolve, reject) => {
    squatter.once('error', reject);
    // WILDCARD, deliberately: serve() binds 0.0.0.0, and SO_REUSEADDR (which
    // Node sets by default) lets a wildcard bind succeed alongside a loopback
    // one. Squatting on 127.0.0.1 would leave the port bindable and the test
    // would pass on a server that never noticed a conflict at all.
    squatter.listen(0, () => resolve());
  });
  const addr = squatter.address();
  if (addr === null || typeof addr === 'string') throw new Error('could not take a port to squat on');
  busyPort = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => squatter.close(() => resolve()));
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

describe('boot order: the port is bound before any database work', () => {
  it('a second instance against a busy port exits without writing to the database', async () => {
    const child = spawn(TSX, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: scratchHome, DOJO_PORT: String(busyPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (c: Buffer) => { output += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { output += c.toString(); });

    const exit = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      const killer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: null, timedOut: true });
      }, EXIT_BUDGET_MS);
      child.once('exit', (code) => {
        clearTimeout(killer);
        resolve({ code, timedOut: false });
      });
    });

    // The platform logs to a file rather than stdout, so the reason it gave up
    // is read from the scratch HOME's own log when there is one.
    const scratchLog = path.join(scratchHome, '.dojo', 'logs', 'dojo.log');
    const said = output + (fs.existsSync(scratchLog) ? fs.readFileSync(scratchLog, 'utf8') : '');

    const after = new Database(scratchDbPath, { readonly: true });
    const agent = after.prepare('SELECT status FROM agents WHERE id = ?').get(STUCK_AGENT) as { status: string };
    const migrated = after
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_migrations'")
      .get() as { present: number } | undefined;
    after.close();

    // Soft so BOTH canaries report: they cover different boot writes (the
    // import-time recovery sweep and main()'s migration chain) and a run that
    // stopped at the first one would hide whether the other also moved.
    expect.soft(agent.status, `the boot path reaped an agent on a box it does not own:\n${said}`).toBe('working');
    expect.soft(migrated, `the boot path ran migrations before it had the port:\n${said}`).toBeUndefined();
    expect(exit.timedOut, `the duplicate instance never exited:\n${said}`).toBe(false);
    expect(exit.code, `expected a non-zero exit:\n${said}`).not.toBe(0);
    expect(said, 'nothing said the port was the reason').toMatch(/in use|EADDRINUSE/i);
  }, EXIT_BUDGET_MS + 20_000);
});
