// ════════════════════════════════════════════════════════════════════════════════════════
// t98 — THE SHIPPED CHUNKED SHAPE. The measurement that sized `VAULT_CANDIDATE_CHUNK_ROWS`
// and produced the ms/entry figures quoted at the constants in `vault/bounded-reads.ts`.
//
// ⚠ WHY THIS IS A COMMITTED SCRIPT (fix round 1, I5). The review found that this script — the one
// whose output the constants cite — did not survive the sitting that produced it, while its
// companion (`t98-measure-vault-candidate-cost.mjs`) survived only in a session scratchpad. The
// in-suite clause corroborates the per-entry TOTAL, but nothing reproduced the on-thread scoring
// split or the per-chunk burst, which are the two numbers the chunk size is argued from. So both are
// committed now, with their output in the header, and re-running either reproduces the constants.
//
// NOT A SUITE FILE. Run it by hand, from `packages/server` so that `better-sqlite3` resolves:
//
//     $ cd packages/server && node ../../scripts/t98-measure-chunked-vault-scan.mjs 100000 5000
//                                                                                  rows  chunk
//     $ DIM=3072 node ../../scripts/t98-measure-chunked-vault-scan.mjs 25000 5000   # width growth
//
// Fixtures are generated and fictional. Nothing reads a real database.
//
// ── WHAT IT MEASURES ──
// PRE-FIX: one synchronous unbounded `SELECT *` + cosine, on this thread — the shape the capture
// recorded. POST-FIX: the shipped shape — chunked reads through a worker, each chunk scored as it
// arrives, with a turn of the event loop between chunks. Both are wrapped in the starved-ms
// instrument (elapsed minus the time the loop demonstrably serviced, at 10 ms per tick it managed),
// and the two walks' best-similarity results are compared so a faster answer cannot be a wrong one.
//
// ── THE NUMBERS IT PRODUCED (this machine, 2026-10-05, 100,000 entries, chunk 5,000, ×3) ──
//   FIXTURE   100000 entries · 768-float blobs · 395.9 MB on disk
//   PRE-FIX   starved 601 / 721 / 599 ms of the same elapsed — 0 ticks serviced, 0 %, every run
//   POST-FIX  628 / 681 / 621 ms wall — 65 % / 62 % / 64 % serviced
//             worst on-thread scoring burst 8.7 / 8.8 / 8.8 ms · 20 chunks · 293.0 MB read
//   PER ROW   total   0.006280 / 0.006810 / 0.006210 ms/row
//             scoring 0.001747 / 0.001755 / 0.001761 ms/row  ← main-thread, cannot be offloaded
//   AGREEMENT pre best 0.162207 · post best 0.162207, identical every run
//
// READ: the cap is 100,000 because the TOTAL at that size is ~0.63 s wall, well inside the reader
// pool's 15 s deadline. The CHUNK is 5,000 because the scoring half — 0.00175 ms/entry, which the
// pool cannot take away — then costs ~8.8 ms per chunk, one frame, with a yield between chunks.
//
// ⚠ RE-RUN FOR THE REVIEW (same machine, 2026-10-05, with nine other lanes' suites running), AND THE
// ABSOLUTE MILLISECONDS MOVED WHILE EVERY RATIO HELD. Recorded here rather than replacing the
// numbers above, because a constant re-tuned from a loaded measurement is a constant tuned to the
// wrong machine:
//   run 1   PRE-FIX 0% serviced · POST-FIX 62% · 20 chunks · 293.0 MB · burst 28.7ms · 0.0103 ms/row
//   run 2   PRE-FIX 0% serviced · POST-FIX 46% · 20 chunks · 293.0 MB · burst 25.8ms · 0.0225 ms/row
//   both    agreement pre 0.162207 · post 0.162207 — identical, which is the claim that matters
// What is load-independent and is what the argument rests on: the pre-fix shape services ZERO ticks
// every time; the chunked one services 46-64%; the answers are identical; 20 chunks and 293.0 MB are
// arithmetic. What load moves is ms/row (0.0062 idle → 0.0103-0.0225 loaded) and therefore the
// per-chunk burst (8.7 ms idle → 26-29 ms loaded, i.e. still bounded, still far from a freeze).
// ════════════════════════════════════════════════════════════════════════════════════════
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const DIM = Number(process.env.DIM ?? 768);
const ROWS = Number(process.argv[2] ?? 100_000);
const CHUNK = Number(process.argv[3] ?? 5_000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't98-chunk-'));
const dbPath = path.join(dir, 'fixture.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE vault_entries (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, content TEXT NOT NULL,
  is_obsolete INTEGER DEFAULT 0, embedding BLOB, namespace TEXT, created_at TEXT)`);
db.exec('CREATE INDEX idx_vault_obsolete ON vault_entries(is_obsolete)');
db.exec('CREATE INDEX idx_vault_agent ON vault_entries(agent_id)');
/** A deterministic, fictional vector of the real width — so the bytes are the real bytes. */
function blob(seed) {
  const v = new Float32Array(DIM);
  let x = seed + 1;
  for (let i = 0; i < DIM; i += 1) { x = (x * 1103515245 + 12345) % 2147483648; v[i] = (x / 2147483648) - 0.5; }
  return Buffer.from(v.buffer);
}
const ins = db.prepare('INSERT INTO vault_entries (id, agent_id, content, embedding, created_at) VALUES (?,?,?,?,?)');
db.transaction(() => {
  for (let i = 0; i < ROWS; i += 1) {
    ins.run(`v-${i}`, `agent-${i % 4}`,
      `fictional distilled fact number ${i}, padded out so the row has real bytes in it`,
      blob(i), '2026-01-01 00:00:00');
  }
})();
db.close();
console.log(`FIXTURE  ${ROWS} entries · ${DIM}-float blobs · ${(fs.statSync(dbPath).size / 1048576).toFixed(1)} MB on disk · chunk ${CHUNK}`);

const q = new Float32Array(DIM);
for (let i = 0; i < DIM; i += 1) q[i] = (i % 17) / 17 - 0.5;
function cos(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const dn = Math.sqrt(na) * Math.sqrt(nb);
  return dn === 0 ? 0 : d / dn;
}

/** The reader pool's protocol, inlined — SQL in, rows out, nothing else. */
const SRC = `
  const { parentPort, workerData } = require('node:worker_threads');
  const Database = require('better-sqlite3');
  const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
  parentPort.on('message', (req) => {
    try { parentPort.postMessage({ id: req.id, rows: db.prepare(req.sql).all(...(req.params||[])) }); }
    catch (err) { parentPort.postMessage({ id: req.id, error: String(err && err.message || err) }); }
  });
`;
const w = new Worker(SRC, { eval: true, workerData: { dbPath } });
const ask = (sql, params) => new Promise((res, rej) => {
  w.once('message', (m) => (m.error ? rej(new Error(m.error)) : res(m.rows)));
  w.postMessage({ sql, params });
});
/** Elapsed wall time minus the time the loop demonstrably serviced, at 10 ms per tick it managed. */
async function starved(fn) {
  let ticks = 0;
  const t = setInterval(() => { ticks += 1; }, 10);
  const s = Date.now();
  const out = await fn();
  const el = Date.now() - s;
  clearInterval(t);
  return { starvedMs: Math.max(0, el - ticks * 10), elapsedMs: el, ticks, serviced: Math.min(1, (ticks * 10) / Math.max(1, el)), out };
}

const PAGE = 'SELECT id, embedding, rowid AS rid FROM vault_entries WHERE is_obsolete = 0 AND embedding IS NOT NULL AND rowid <= ? AND rowid > ? ORDER BY rid DESC';
const COST = 'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(embedding)),0) AS bytes FROM vault_entries WHERE is_obsolete = 0 AND rowid <= ? AND rowid > ?';

await ask('SELECT 1 AS ok', []);          // warm: the spawn cost belongs at boot, not in a measurement

// ── 1. PRE-FIX: one synchronous unbounded SELECT * + score, on this thread.
const ro = new Database(dbPath, { readonly: true });
const pre = await starved(async () => {
  const rows = ro.prepare('SELECT * FROM vault_entries WHERE is_obsolete = 0 AND embedding IS NOT NULL').all();
  let best = -1;
  for (const r of rows) best = Math.max(best, cos(q, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.length / 4)));
  return { rows: rows.length, best };
});
ro.close();
console.log(`PRE-FIX   starved ${pre.starvedMs}ms of ${pre.elapsedMs}ms (${pre.ticks} ticks, ${(pre.serviced * 100).toFixed(0)}% serviced) · ${pre.out.rows} rows scored`);

// ── 2. POST-FIX: chunked pooled reads, scored per chunk, a turn of the loop between chunks.
const post = await starved(async () => {
  let ceiling = ROWS, scored = 0, rowsRead = 0, bytesRead = 0, chunks = 0, oldest = ceiling, best = -1, worstChunkMs = 0;
  while (scored < ROWS && ceiling > 0) {
    const floor = Math.max(0, ceiling - CHUNK);
    const cost = (await ask(COST, [ceiling, floor]))[0];
    const page = await ask(PAGE, [ceiling, floor]);
    const s = process.hrtime.bigint();
    for (const r of page) {
      best = Math.max(best, cos(q, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.length / 4)));
      oldest = Math.min(oldest, r.rid);
    }
    worstChunkMs = Math.max(worstChunkMs, Number(process.hrtime.bigint() - s) / 1e6);
    scored += page.length; rowsRead += cost.n; bytesRead += cost.bytes; chunks += 1; ceiling = floor;
    await new Promise((r) => setImmediate(r));
  }
  return { scored, rowsRead, bytesRead, chunks, oldest, best, worstChunkMs };
});
console.log(`POST-FIX  starved ${post.starvedMs}ms of ${post.elapsedMs}ms (${post.ticks} ticks, ${(post.serviced * 100).toFixed(0)}% serviced)`);
console.log(`          ${post.out.scored} scored · ${post.out.chunks} chunks · ${(post.out.bytesRead / 1048576).toFixed(1)} MB of embedding read · worst on-thread scoring burst ${post.out.worstChunkMs.toFixed(1)}ms`);
console.log(`          agreement: pre best ${pre.out.best.toFixed(6)} · post best ${post.out.best.toFixed(6)}`);
console.log(`PER ROW   total ${(post.elapsedMs / ROWS).toFixed(6)} ms/row · on-thread scoring ${(post.out.worstChunkMs / CHUNK).toFixed(6)} ms/row`);
await w.terminate();
fs.rmSync(dir, { recursive: true, force: true });
