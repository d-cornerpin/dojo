// ════════════════════════════════════════════════════════════════════════════════════════
// t98 — WHAT ONE VAULT CANDIDATE ROW COSTS. The measurement that sized `VAULT_CANDIDATE_ROWS`.
//
// ⚠ WHY THIS IS A COMMITTED SCRIPT AND NOT A CLAUSE (fix round 1, I5). It builds a 198 MB / 396 MB
// fixture and runs for several seconds; a suite has no business doing that on every run, and the
// release ritual re-runs the suite dozens of times. But the constants in
// `packages/server/src/vault/bounded-reads.ts` cite numbers that came from HERE, and a number whose
// script does not survive is the next reader's guess. So: not a test, committed, reproducible.
//
// NOT A SUITE FILE. Run it by hand, from `packages/server` so that `better-sqlite3` resolves:
//
//     $ cd packages/server && node ../../scripts/t98-measure-vault-candidate-cost.mjs 50000
//
// Fixtures are generated and fictional — 768-float blobs built from a seeded LCG, content that is
// filler. Nothing reads a real database.
//
// ── WHAT IT MEASURES, AND WHAT EACH ROW OF THE OUTPUT IS FOR ──
//   A  the PRE-FIX shape: `SELECT *` (so every row drags its 3 KB vector) + cosine in JS, on-thread
//   B  the POST-FIX candidate projection: `id, embedding` + cosine in JS, on-thread
//   C  B's read with no scoring, so the SQLite half and the JavaScript half can be told apart
//   D  A's read with no scoring, which is what the projection saves
//   E  the same candidate read through a worker, plus the loop's starvation while it runs
//
// ── THE NUMBERS IT PRODUCED (this machine, 2026-10-05, 50,000 entries) ──
//   FIXTURE  50000 entries, 768-float blobs, built in 3285ms, file 197.9 MB
//   A pre-fix  SELECT * + score (on-thread)      median 501.1ms  (10.0229 us/row)
//   B post-fix id+embedding + score (on-thread)  median 310.0ms  ( 6.1995 us/row)
//   C read only id+embedding (no scoring)        median 166.7ms  ( 3.3346 us/row)
//   D read only SELECT * (no scoring)            median 377.2ms  ( 7.5438 us/row)
//   BYTES    50000 rows · embeddings 146.5 MB · content 4.9 MB
//   EXPLAIN  SEARCH vault_entries USING INDEX idx_vault_obsolete (is_obsolete=? AND rowid>?)
//   E pooled candidate read+score: read 243.8ms (0.004876 ms/row), loop starved 188ms of 328ms
//
// READ: the projection halves the READ (7.54 → 3.33 µs/row), which is R10.2. And C vs B says the
// cosine scoring is ~2.9 µs/row of MAIN-THREAD work that the pool cannot take away — which is why
// the chunk size, not the cap, is what decides serviceability. See the companion script
// `t98-measure-chunked-vault-scan.mjs` for the shipped chunked shape.
//
// ⚠ RE-RUN FOR THE REVIEW (same machine, 2026-10-05, nine other lanes' suites running). Every
// absolute figure roughly doubled and EVERY RATIO HELD, which is the half the argument rests on:
//   A 16.7969 · B 8.3089 · C 5.7111 · D 11.7318 µs/row
//   the projection still halves the read   D/C = 2.05×  (idle: 2.27×)
//   the scoring half is still main-thread  B−C = 2.60 µs/row  (idle: 2.87)
// Recorded rather than substituted: re-tuning a constant from a loaded box tunes it to the wrong
// machine.
// ════════════════════════════════════════════════════════════════════════════════════════
// Fictional content, real-shaped 768-float embedding blobs. No user data anywhere.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const DIM = 768;
const ROWS = Number(process.argv[2] ?? 50_000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't98-measure-'));
const dbPath = path.join(dir, 'fixture.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE vault_entries (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_name TEXT,
  type TEXT NOT NULL DEFAULT 'fact', content TEXT NOT NULL, context TEXT,
  confidence REAL DEFAULT 1.0, is_permanent INTEGER DEFAULT 0, tags TEXT DEFAULT '[]',
  is_pinned INTEGER DEFAULT 0, is_obsolete INTEGER DEFAULT 0, superseded_by TEXT,
  retrieval_count INTEGER DEFAULT 0, last_retrieved_at TEXT, source_conversation_id TEXT,
  source TEXT DEFAULT 'extraction', embedding BLOB,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  namespace TEXT, citation TEXT
)`);
db.exec(`CREATE INDEX idx_vault_agent ON vault_entries(agent_id)`);
db.exec(`CREATE INDEX idx_vault_obsolete ON vault_entries(is_obsolete)`);

function blob(seed) {
  const v = new Float32Array(DIM);
  let x = seed + 1;
  for (let i = 0; i < DIM; i += 1) { x = (x * 1103515245 + 12345) % 2147483648; v[i] = (x / 2147483648) - 0.5; }
  return Buffer.from(v.buffer);
}
const filler = 'a distilled fictional fact about a made-up project, long enough to cost real bytes to read, ';
const ins = db.prepare(`INSERT INTO vault_entries (id, agent_id, type, content, embedding, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?)`);
const t0 = Date.now();
db.transaction(() => {
  for (let i = 0; i < ROWS; i += 1) {
    ins.run(`v-${i}`, `agent-${i % 4}`, 'fact', `${filler}entry-${i}`, blob(i),
      '2026-01-01 00:00:00', '2026-01-01 00:00:00');
  }
})();
console.log(`FIXTURE  ${ROWS} entries, ${DIM}-float blobs, built in ${Date.now() - t0}ms, file ${(fs.statSync(dbPath).size / 1048576).toFixed(1)} MB`);
db.close();

const ro = new Database(dbPath, { readonly: true });
const q = new Float32Array(DIM); for (let i = 0; i < DIM; i += 1) q[i] = (i % 17) / 17 - 0.5;
function cos(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const dn = Math.sqrt(na) * Math.sqrt(nb); return dn === 0 ? 0 : d / dn;
}
function timeIt(label, fn, reps = 3) {
  const ts = [];
  for (let r = 0; r < reps; r += 1) { const s = process.hrtime.bigint(); fn(); ts.push(Number(process.hrtime.bigint() - s) / 1e6); }
  ts.sort((a, b) => a - b);
  const med = ts[Math.floor(ts.length / 2)];
  console.log(`${label.padEnd(44)} median ${med.toFixed(1)}ms  (${(med / ROWS * 1000).toFixed(4)} us/row, ${(med / ROWS).toFixed(6)} ms/row)`);
  return med;
}

// A: the PRE-FIX shape — SELECT * (3 KB blob per row), cosine in JS.
const starA = ro.prepare('SELECT * FROM vault_entries WHERE is_obsolete = 0 AND embedding IS NOT NULL');
const msA = timeIt('A pre-fix  SELECT * + score (on-thread)', () => {
  const rows = starA.all();
  let n = 0;
  for (const r of rows) { if (cos(q, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.length / 4)) >= 0.3) n += 1; }
  return n;
});

// B: the POST-FIX candidate projection — id, embedding only, scored.
const candB = ro.prepare('SELECT id, embedding, rowid AS rid FROM vault_entries WHERE is_obsolete = 0 AND embedding IS NOT NULL AND rowid > ? ORDER BY rid');
const msB = timeIt('B post-fix id+embedding + score (on-thread)', () => {
  const rows = candB.all(0);
  let n = 0;
  for (const r of rows) { if (cos(q, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.length / 4)) >= 0.3) n += 1; }
  return n;
});

// C: the READ alone, no scoring — how much is SQLite and how much is cosine.
const msC = timeIt('C read only id+embedding (no scoring)', () => candB.all(0));
const msD = timeIt('D read only SELECT * (no scoring)', () => starA.all());

// Bytes actually read.
const bytes = ro.prepare('SELECT COUNT(*) n, SUM(LENGTH(embedding)) emb, SUM(LENGTH(content)) txt FROM vault_entries').get();
console.log(`BYTES    ${bytes.n} rows · embeddings ${(bytes.emb / 1048576).toFixed(1)} MB · content ${(bytes.txt / 1048576).toFixed(1)} MB`);

// EXPLAIN for the capped scan.
console.log('EXPLAIN (capped candidate scan):');
for (const p of ro.prepare('EXPLAIN QUERY PLAN SELECT id, embedding, rowid AS rid FROM vault_entries WHERE is_obsolete = 0 AND embedding IS NOT NULL AND rowid > ? ORDER BY rid').all(0)) console.log('   ', p.detail);
console.log('EXPLAIN (pre-fix unbounded scan):');
for (const p of ro.prepare('EXPLAIN QUERY PLAN SELECT * FROM vault_entries WHERE is_obsolete = 0 AND embedding IS NOT NULL').all()) console.log('   ', p.detail);
console.log('EXPLAIN (capped + agent scope):');
for (const p of ro.prepare("EXPLAIN QUERY PLAN SELECT id, embedding, rowid AS rid FROM vault_entries WHERE is_obsolete = 0 AND embedding IS NOT NULL AND agent_id IN (?,?) AND rowid > ? ORDER BY rid").all('a','b',0)) console.log('   ', p.detail);
ro.close();

// E: the same candidate read THROUGH a worker (the pool's shape), and the loop's starvation.
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
  w.postMessage({ id: '1', sql, params });
});
async function starved(fn) {
  let ticks = 0; const t = setInterval(() => { ticks += 1; }, 10);
  const s = Date.now(); const out = await fn(); const el = Date.now() - s; clearInterval(t);
  return { starvedMs: Math.max(0, el - ticks * 10), elapsedMs: el, ticks, out };
}
const CAND_SQL = 'SELECT id, embedding, rowid AS rid FROM vault_entries WHERE is_obsolete = 0 AND embedding IS NOT NULL AND rowid > ? ORDER BY rid';
await ask('SELECT 1 AS ok', []);                                   // warm
const pooled = await starved(async () => {
  const s = process.hrtime.bigint();
  const rows = await ask(CAND_SQL, [0]);
  const readMs = Number(process.hrtime.bigint() - s) / 1e6;
  let n = 0;
  for (const r of rows) { if (cos(q, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.length / 4)) >= 0.3) n += 1; }
  return { readMs, rows: rows.length, n };
});
console.log(`E pooled candidate read+score: read ${pooled.out.readMs.toFixed(1)}ms (${(pooled.out.readMs / ROWS).toFixed(6)} ms/row), `
  + `total ${pooled.elapsedMs}ms, loop starved ${pooled.starvedMs}ms of ${pooled.elapsedMs}ms (${pooled.ticks} ticks)`);
await w.terminate();

console.log('\nCAP ARITHMETIC');
for (const budget of [250, 500, 1000, 2000]) {
  console.log(`  at ${String(budget).padStart(5)}ms of worker time: cap = ${Math.round(budget / (pooled.out.readMs / ROWS)).toLocaleString()} rows (read only)`
    + ` · ${Math.round(budget / (msB / ROWS)).toLocaleString()} rows (read+score)`);
}
fs.rmSync(dir, { recursive: true, force: true });
