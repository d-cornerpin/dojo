// CRASH TEST C — the CHILD. Run by `crash-c.test.ts`, never by the suite directly.
//
// This process is meant to DIE. It opens the platform's real connection (its own
// `$HOME` is a temp dir, so `db/connection.ts` builds a genuine `~/.dojo/data/dojo.db`
// there with the same pragmas production uses), does two writes inside one
// `withUnit`, queues a post-commit effect, and then SIGKILLs itself — with no
// unwinding, no `finally`, no chance to roll anything back politely.
//
// SIGKILL rather than a thrown error is the whole point. A throw proves the
// try/catch works; a kill proves what is on DISK, which is the only thing a
// restart can read.
//
//   argv[2] = 'kill-inside'   → die mid-unit, before the commit
//   argv[2] = 'kill-after'    → commit, then die (the positive control)
//   argv[3] = the effect sink path

import fs from 'node:fs';
import { getDb } from '../connection.js';
import { withUnit, afterCommit } from '../unit.js';

const mode = process.argv[2];
const sink = process.argv[3];

const db = getDb();
db.exec('CREATE TABLE IF NOT EXISTS crash_c (id TEXT PRIMARY KEY)');
const put = (id: string): void => { db.prepare('INSERT INTO crash_c (id) VALUES (?)').run(id); };

// The "broadcast": a durable sink, because a ws frame leaves no evidence a restart
// can read and the corollary requires reading a durable sink, not observing.
const emit = (what: string): void => { fs.appendFileSync(sink, `${what}\n`); };

if (mode === 'kill-inside') {
  withUnit(() => {
    put('first');
    afterCommit(() => emit('EMITTED'));
    put('second');
    // Dead here. Both writes are in the transaction; neither is committed.
    process.kill(process.pid, 'SIGKILL');
    // unreachable
    emit('NEVER');
  });
} else if (mode === 'kill-after') {
  withUnit(() => {
    put('first');
    afterCommit(() => emit('EMITTED'));
    put('second');
  });
  process.kill(process.pid, 'SIGKILL');
} else {
  throw new Error(`unknown mode ${String(mode)}`);
}
