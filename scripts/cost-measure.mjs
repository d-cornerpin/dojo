#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════════════════
// t204 — WHERE DOES EACH MODEL CALL'S INPUT GO, AND WHAT DOES IT COST PER DAY?
//
// A DEV/DIAGNOSTIC REPORT. Not shipped (it lives in the repo-root `scripts/`, not in the
// installer's `deploy/scripts/`), not imported by the server, and READ-ONLY: it opens the
// database with SQLite's `immutable=1` URI and reads receipt files; it writes nothing.
//
//     $ node scripts/cost-measure.mjs                      # the primary agent, last 14 days
//     $ node scripts/cost-measure.mjs --agent <id> --days 7
//     $ node scripts/cost-measure.mjs --json               # the same numbers, machine-readable
//     $ node scripts/cost-measure.mjs --price-in 1.32 --hit-factor 0.0333   # re-price a what-if
//
// ── WHAT IT USES, AND ONLY THAT ──
//   cost_records       one row per model call: real provider-reported input split into
//                      `input_tokens` (the MISS part) and `cache_read_tokens` (the HIT part),
//                      `cost_usd`, `latency_ms`, and the pre-send request size as
//                      `estimated_input_tokens` x `estimator_chars_per_token` (= request CHARS).
//   ~/.dojo/receipts/<agent>/*.json   the context receipts (mode `meta`): the system prompt's
//                      part sizes, the assembled messages' per-item sizes, and the assembly's
//                      lane ledger. The platform keeps the newest 200 per agent, so the lane
//                      attribution covers the most recent ~200 calls; the per-day cost table
//                      covers every recorded call.
//
// ── HOW A CALL'S TOKENS ARE ATTRIBUTED (the method, so a reader can argue with it) ──
//   1. REAL total = input_tokens + cache_read_tokens. Nothing here is an estimate of the total.
//   2. Lane CHARS come from the receipt: system parts, message items. Block items (the live
//      tail's tool calls and results) record only their text, so the rest of the tail is what
//      the messages hold beyond every itemised char (messages.chars minus the items), given to
//      the lane that owns the block items: `lane.fresh-tail`, or the PM's `lane.pm-tail`.
//   3. TOOL DEFINITIONS are not in the receipt. They are a fixed block on every request, so
//      across the receipted calls of one model, real total tokens = T + s x (system chars +
//      message chars). A least-squares line through those calls gives T, the tool head, as its
//      intercept, and s, the real tokens per char. The report prints the fit (n, correlation,
//      residual spread) and the assembly's own tool reserve beside T as a cross-check. (The
//      recorded `estimated_input_tokens x estimator_chars_per_token` is NOT used for this: it
//      fits the real totals worse, correlation 0.93 against 0.99 on the dev box.)
//      With no usable fit, the fallback is the residual: request chars (that estimate) minus
//      system minus message chars. The test file pins the fallback; the report flags its use.
//   4. Per call, tool head = T, and the remaining real tokens are shared across the other lanes
//      by chars, so the lanes add up to the real total exactly.
//   5. The blur: chars-proportional treats prose and JSON as equally dense, and a call whose
//      loaded tool set differs from the typical one is attributed the typical T.
//   6. The first receipt message merges the lanes that sit before the tail (vault, summaries,
//      briefing...). It is split back by what the assembly GRANTED each lane.
//   7. CACHED VERSUS UNCACHED. Providers cache a PREFIX, so the miss is the END of the
//      request. The miss tokens are walked backwards from the last lane; whatever lane they
//      run out inside is partly missed. Assumed request order: tool definitions, system
//      prompt, messages. (The provider reports only one hit total; the per-lane split is this
//      walk, not a measurement.)
//   8. COST per lane = miss x input price + hit x input price x hit factor. The lanes' costs
//      add up to the call's input cost exactly; output tokens are reported on their own line.
// ════════════════════════════════════════════════════════════════════════════════════════

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── pure functions (exported; pinned by packages/server/src/agent/v2/__tests__/t204-cost-measure.test.ts) ──

const TAIL_ID = 'lane.fresh-tail';
const MERGED_FIRST_MESSAGE_ID = 'lane.vault';
/** The two lanes that carry the live conversation: the main agents' tail and the PM's. */
const isTailId = (id) => id === TAIL_ID || id === 'lane.pm-tail';

/** Size of one receipt message item in chars. Text items carry `chars`; block items carry `textChars`. */
function itemChars(it) {
  return it.chars ?? it.textChars ?? 0;
}

/** A coarse group per lane id, for the "where does it go" headline table. */
export function groupOf(id) {
  if (id === 'tools') return 'tool definitions';
  if (id.startsWith('sys.')) return 'system prefix';
  if (id === 'lane.summaries') return 'summaries';
  if (isTailId(id)) return 'live tail';
  if (id === 'msg.active-tasks') return 'task list';
  return 'other lanes';
}

/**
 * Split a call's real input across lanes.
 * @param receipt one parsed context receipt (mode meta)
 * @param cost one cost_records row: input_tokens (miss), cache_read_tokens (hit), output_tokens,
 *   estimated_input_tokens, estimator_chars_per_token
 * @param opts { pricePerMIn, pricePerMOut, hitPriceFactor, toolTokens } USD per million tokens;
 *   hits cost `pricePerMIn * hitPriceFactor`. `toolTokens` is the fitted tool head (see
 *   `fitToolHead`); without it the tool head is the residual of the recorded request size.
 */
export function attributeCall(receipt, cost, opts = {}) {
  const pIn = opts.pricePerMIn ?? cost.input_cost_per_m ?? 0;
  const pOut = opts.pricePerMOut ?? cost.output_cost_per_m ?? 0;
  const hitFactor = opts.hitPriceFactor ?? 0.1;
  const missTokens = cost.input_tokens ?? 0;
  const hitTokens = cost.cache_read_tokens ?? 0;
  const totalTokens = missTokens + hitTokens;
  const outTokens = cost.output_tokens ?? 0;
  const base = { ok: false, totalTokens, missTokens, hitTokens, outTokens, costUsd: 0, lanes: [] };

  const sysChars = receipt.systemPrompt?.chars ?? 0;
  const msgChars = receipt.messages?.chars ?? 0;
  const fixedTools = typeof opts.toolTokens === 'number' && opts.toolTokens > 0 && opts.toolTokens < totalTokens;
  const reqChars = (cost.estimated_input_tokens ?? 0) * (cost.estimator_chars_per_token ?? 0);
  if (!(totalTokens > 0)) return { ...base, reason: 'no real usage recorded for this call' };
  let toolsChars = 0;
  if (!fixedTools) {
    if (!(reqChars > 0)) return { ...base, reason: 'no request size recorded for this call and no fitted tool head' };
    toolsChars = reqChars - sysChars - msgChars;
    if (toolsChars < 0) {
      return { ...base, reason: `receipt parts exceed the recorded request size (${sysChars + msgChars} > ${Math.round(reqChars)} chars): the pairing is wrong` };
    }
  }

  // ── lanes in request order ──
  const lanes = [{ id: 'tools', chars: toolsChars, fixedTokens: fixedTools ? opts.toolTokens : undefined }];
  const parts = receipt.systemPrompt?.parts ?? [];
  let partSum = 0;
  for (const p of parts) {
    lanes.push({ id: p.entryId ?? 'sys.unlabelled', chars: p.chars ?? 0 });
    partSum += p.chars ?? 0;
  }
  if (sysChars - partSum > 0) lanes.push({ id: 'sys.other', chars: sysChars - partSum });

  // the lanes folded into the first message, weighted by what the assembly granted each
  const merged = (receipt.assembly?.lanes ?? []).filter((l) => l.slot < 1000 && (l.granted ?? 0) > 0 && (l.status === 'admitted' || l.status === 'truncated'));
  const items = receipt.messages?.items ?? [];
  // Block items (the tool calls and results of the live conversation) record only their TEXT size.
  // What the messages hold beyond every itemised char is those blocks' bodies: it belongs to the
  // lane(s) that own block items, in proportion to how many block items each owns.
  const idOf = (it) => it.entryId ?? it.source ?? `unlabelled:${it.kind}`;
  const isBlock = (it) => it.kind === 'blocks' && idOf(it) !== 'lane.scaffolding-ack';
  const blockCount = new Map();
  for (const it of items) if (isBlock(it)) blockCount.set(idOf(it), (blockCount.get(idOf(it)) ?? 0) + 1);
  const totalBlocks = [...blockCount.values()].reduce((a, b) => a + b, 0);
  const itemised = items.reduce((n, it) => n + itemChars(it), 0);
  const leftover = Math.max(0, msgChars - itemised);

  const slots = [];
  for (const it of items) {
    const id = idOf(it);
    if (id === MERGED_FIRST_MESSAGE_ID && merged.length > 0) {
      const weight = merged.reduce((s, l) => s + l.granted, 0);
      for (const l of merged) slots.push({ id: l.id, chars: (itemChars(it) * l.granted) / weight });
    } else {
      slots.push({ id, chars: itemChars(it) });
    }
  }
  // the blocks' unitemised bodies, onto the lane(s) that own them (or the fresh tail if none do)
  if (leftover > 0) {
    if (totalBlocks > 0) for (const [id, n] of blockCount) slots.push({ id, chars: (leftover * n) / totalBlocks });
    else slots.push({ id: TAIL_ID, chars: leftover });
  }
  // one lane per id, at its first position
  for (const s of slots) {
    const hit = lanes.find((l) => l.id === s.id);
    if (hit) hit.chars += s.chars;
    else lanes.push({ id: s.id, chars: s.chars });
  }

  // ── tokens, then the miss walked backwards from the end of the request ──
  const bodyChars = lanes.reduce((n, l) => n + (l.fixedTokens === undefined ? l.chars : 0), 0);
  const bodyTokens = totalTokens - (fixedTools ? opts.toolTokens : 0);
  const tokPerChar = fixedTools ? (bodyChars > 0 ? bodyTokens / bodyChars : 0) : totalTokens / reqChars;
  for (const l of lanes) l.tokens = l.fixedTokens ?? l.chars * tokPerChar;
  let remaining = Math.min(missTokens, totalTokens);
  for (let i = lanes.length - 1; i >= 0; i--) {
    const take = Math.min(lanes[i].tokens, remaining);
    lanes[i].missTokens = take;
    remaining -= take;
  }
  for (const l of lanes) {
    l.group = groupOf(l.id);
    l.costUsd = (l.missTokens * pIn + (l.tokens - l.missTokens) * pIn * hitFactor) / 1e6;
  }
  const inputCost = (missTokens * pIn + hitTokens * pIn * hitFactor) / 1e6;
  return { ...base, ok: true, costUsd: inputCost + (outTokens * pOut) / 1e6, inputCostUsd: inputCost, toolsChars, reqChars, toolsFromFit: fixedTools, lanes };
}

const toMs = (sqlTime) => Date.parse(`${sqlTime.replace(' ', 'T')}Z`);

/**
 * Pair each receipt with the cost row of the call it assembled. A receipt is written just
 * before the request goes out; the cost row is written when the response ends, with a
 * second-resolution time and the call's latency. So `created - latency` is when the request
 * began. Each cost row is used at most once.
 */
export function matchReceiptsToCosts(receipts, costs, { toleranceMs = 5000 } = {}) {
  const used = new Set();
  const pairs = [];
  const sorted = [...receipts].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const receipt of sorted) {
    const at = Date.parse(receipt.at);
    let best = null;
    let bestDiff = Infinity;
    for (const c of costs) {
      if (used.has(c)) continue;
      // +500 ms: the stored second is truncated, so the true end is somewhere in the next second
      const diff = Math.abs(toMs(c.created_at) + 500 - (c.latency_ms ?? 0) - at);
      if (diff <= toleranceMs && diff < bestDiff) { best = c; bestDiff = diff; }
    }
    if (best) { used.add(best); pairs.push({ receipt, cost: best }); }
  }
  return pairs;
}

/**
 * The fixed tool-definition block, from the data. Across calls of ONE model the real input is
 * `T + s x (system chars + message chars)`: T (the intercept) is the tool head, s the real
 * tokens per char. Ordinary least squares; returns null when the points cannot support it.
 * @param pairs [{ receipt, cost }] already matched
 * @returns { toolTokens, tokensPerChar, n, r, residualSd } | null
 */
export function fitToolHead(pairs, { minPoints = 8, minR = 0.9 } = {}) {
  const pts = [];
  for (const { receipt, cost } of pairs) {
    const y = (cost.input_tokens ?? 0) + (cost.cache_read_tokens ?? 0);
    const x = (receipt.systemPrompt?.chars ?? 0) + (receipt.messages?.chars ?? 0);
    if (y > 0 && x > 0) pts.push([x, y]);
  }
  const n = pts.length;
  if (n < minPoints) return null;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
  if (sxx === 0 || syy === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = sxy / Math.sqrt(sxx * syy);
  const residualSd = Math.sqrt(pts.reduce((a, [x, y]) => a + (y - intercept - slope * x) ** 2, 0) / n);
  if (r < minR || intercept <= 0 || slope <= 0) return null;
  return { toolTokens: intercept, tokensPerChar: slope, n, r, residualSd };
}

/**
 * How big each tool's results are, from the conversation store: the live tail is made of these.
 * @param rows [{ role, content }] assistant rows (carry tool_use blocks naming each call) and tool
 *   rows (carry tool_result blocks keyed by the same id), as stored
 * @returns [{ tool, count, totalChars, meanChars, p95Chars, maxChars }] biggest total first
 */
export function toolResultSizes(rows) {
  const nameById = new Map();
  const parse = (c) => { try { const v = JSON.parse(c); return Array.isArray(v) ? v : []; } catch { return []; } };
  for (const r of rows) {
    if (r.role !== 'assistant') continue;
    for (const b of parse(r.content)) if (b?.type === 'tool_use' && b.id) nameById.set(b.id, b.name ?? 'unknown');
  }
  const sizes = new Map();
  for (const r of rows) {
    if (r.role !== 'tool') continue;
    for (const b of parse(r.content)) {
      if (b?.type !== 'tool_result') continue;
      const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      const name = nameById.get(b.tool_use_id) ?? 'unknown (call not in window)';
      sizes.set(name, [...(sizes.get(name) ?? []), body.length]);
    }
  }
  return [...sizes.entries()]
    .map(([tool, xs]) => {
      const sorted = [...xs].sort((a, b) => a - b);
      const total = xs.reduce((a, b) => a + b, 0);
      return { tool, count: xs.length, totalChars: total, meanChars: total / xs.length, p95Chars: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], maxChars: sorted[sorted.length - 1] };
    })
    .sort((a, b) => b.totalChars - a.totalChars);
}

/**
 * For each lane that follows the live tail: how often its bytes are identical to the previous
 * call's. Pairs are consecutive receipts of the same turn (loop n then n+1), by the item's sha256.
 * @returns [{ id, pairs, unchanged, unchangedShare }]
 */
export function laneStability(receipts) {
  const sorted = [...receipts].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const by = new Map();
  const shaOf = (r) => {
    const m = new Map();
    for (const it of r.messages?.items ?? []) {
      const id = it.entryId ?? it.source;
      if (id && !isTailId(id) && it.sha256) m.set(id, it.sha256);
    }
    return m;
  };
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (a.turnNumber !== b.turnNumber || b.loopCount !== a.loopCount + 1) continue;
    const sa = shaOf(a), sb = shaOf(b);
    for (const [id, sha] of sb) {
      if (!sa.has(id)) continue;
      const t = by.get(id) ?? { id, pairs: 0, unchanged: 0 };
      t.pairs += 1;
      if (sa.get(id) === sha) t.unchanged += 1;
      by.set(id, t);
    }
  }
  return [...by.values()].map((t) => ({ ...t, unchangedShare: t.unchanged / t.pairs })).sort((x, y) => y.pairs - x.pairs);
}

/**
 * Cache-hit ratio of the calls grouped by how long the agent had been quiet before them.
 * @param calls [{ gapMs, hitTokens, totalTokens, costUsd }]
 * @returns [{ bucket, n, hitRatio, meanCostUsd }] in ascending gap order
 */
export function hitByIdleGap(calls) {
  const edges = [[60_000, 'under 1 min'], [300_000, '1-5 min'], [1_800_000, '5-30 min'], [7_200_000, '30 min-2 h'], [Infinity, 'over 2 h']];
  const acc = edges.map(([, bucket]) => ({ bucket, n: 0, hit: 0, total: 0, cost: 0 }));
  for (const c of calls) {
    if (c.gapMs == null) continue;
    const i = edges.findIndex(([lim]) => c.gapMs < lim);
    acc[i].n += 1; acc[i].hit += c.hitTokens; acc[i].total += c.totalTokens; acc[i].cost += c.costUsd;
  }
  return acc.filter((a) => a.n > 0).map((a) => ({ bucket: a.bucket, n: a.n, hitRatio: a.hit / a.total, meanCostUsd: a.cost / a.n }));
}

/**
 * Where two consecutive requests of an agent first differ, from the receipts' per-item hashes.
 * Everything before the first differing item is a byte-identical prefix a provider can serve
 * from cache; everything from it on is billed as a miss. `systemPrompt.sha256` is checked first.
 * @returns { where, sharedItems, nextItems, keptShare } where = 'system' | 'message-0 (summaries/vault)' |
 *   'scaffolding-ack' | 'tail-head' (one of the first two tail items differs: the window moved) |
 *   'tail-body' | the entry id of a lane after the tail | 'identical'. `keptShare`
 *   is the share of the next request's messages (by count) that are byte-identical to the last one's.
 */
export function prefixBreak(prev, next) {
  if (prev.systemPrompt?.sha256 !== next.systemPrompt?.sha256) return { where: 'system', sharedItems: 0, nextItems: (next.messages?.items ?? []).length, keptShare: 0 };
  const a = prev.messages?.items ?? [];
  const b = next.messages?.items ?? [];
  let i = 0;
  for (; i < Math.min(a.length, b.length); i++) if (a[i].sha256 !== b[i].sha256) break;
  const id = i < b.length ? (b[i].entryId ?? b[i].source ?? 'unlabelled') : 'identical';
  const firstTail = b.findIndex((it) => isTailId(it.entryId ?? it.source));
  let where = id;
  if (id === 'identical') where = 'identical';
  else if (i === 0 && !isTailId(id)) where = 'message-0 (summaries/vault)';
  else if (id === 'lane.scaffolding-ack') where = 'scaffolding-ack';
  else if (isTailId(id)) where = i - firstTail < 2 ? 'tail-head' : 'tail-body';
  return { where, sharedItems: i, nextItems: b.length, keptShare: b.length ? i / b.length : 1 };
}

/** Group consecutive-receipt prefix breaks: first call of a turn vs a later call of the same turn. */
export function prefixBreaks(receipts) {
  const sorted = [...receipts].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const acc = { turnStart: new Map(), sameTurn: new Map() };
  const count = { turnStart: 0, sameTurn: 0 };
  const kept = { turnStart: [], sameTurn: [] };
  const byReceipt = new Map();
  for (let i = 1; i < sorted.length; i++) {
    const kind = sorted[i].loopCount === 1 ? 'turnStart' : sorted[i].turnNumber === sorted[i - 1].turnNumber && sorted[i].loopCount === sorted[i - 1].loopCount + 1 ? 'sameTurn' : null;
    if (!kind) continue;
    const b = prefixBreak(sorted[i - 1], sorted[i]);
    count[kind] += 1;
    kept[kind].push(b.keptShare);
    byReceipt.set(sorted[i].at, { kind, where: b.where });
    acc[kind].set(b.where, (acc[kind].get(b.where) ?? 0) + 1);
  }
  const rows = (kind) => [...acc[kind].entries()].map(([where, n]) => ({ where, n, share: n / count[kind] })).sort((x, y) => y.n - x.n);
  const stat = (kind) => {
    const xs = [...kept[kind]].sort((x, y) => x - y);
    return { medianKeptShare: xs.length ? xs[Math.floor(xs.length / 2)] : 0, breakInFirstQuarter: xs.length ? xs.filter((x) => x < 0.25).length / xs.length : 0 };
  };
  return { turnStart: { pairs: count.turnStart, ...stat('turnStart'), breaks: rows('turnStart') }, sameTurn: { pairs: count.sameTurn, ...stat('sameTurn'), breaks: rows('sameTurn') }, byReceipt };
}

/** Calls, tokens, cache-hit ratio and cost per UTC day (every call, every purpose). */
export function rollupByDay(costs) {
  const days = new Map();
  for (const c of costs) {
    const day = c.created_at.slice(0, 10);
    const d = days.get(day) ?? { day, calls: 0, miss: 0, hit: 0, costUsd: 0, byPurpose: {} };
    d.calls += 1;
    d.miss += c.input_tokens ?? 0;
    d.hit += c.cache_read_tokens ?? 0;
    d.costUsd += c.cost_usd ?? 0;
    const p = c.call_purpose || c.request_type || 'unlabelled';
    d.byPurpose[p] = (d.byPurpose[p] ?? 0) + (c.cost_usd ?? 0);
    days.set(day, d);
  }
  return [...days.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({ ...d, tokens: d.miss + d.hit, hitRatio: d.miss + d.hit > 0 ? d.hit / (d.miss + d.hit) : 0 }));
}

/** Average the attributed calls into per-lane and per-group figures. */
export function summarizeLanes(calls) {
  const ok = calls.filter((c) => c.ok);
  const n = ok.length;
  const totals = new Map();
  let allTokens = 0, allMiss = 0, allCost = 0;
  for (const c of ok) {
    allTokens += c.totalTokens;
    allMiss += c.missTokens;
    allCost += c.inputCostUsd ?? 0;
    for (const l of c.lanes) {
      const t = totals.get(l.id) ?? { id: l.id, group: l.group, tokens: 0, missTokens: 0, costUsd: 0, calls: 0, chars: 0 };
      t.tokens += l.tokens; t.missTokens += l.missTokens; t.costUsd += l.costUsd; t.chars += l.chars; t.calls += 1;
      totals.set(l.id, t);
    }
  }
  return [...totals.values()]
    .map((t) => ({
      id: t.id,
      group: t.group,
      calls: t.calls,
      meanTokens: n ? t.tokens / n : 0,
      meanMissTokens: n ? t.missTokens / n : 0,
      meanCostUsd: n ? t.costUsd / n : 0,
      share: allTokens ? t.tokens / allTokens : 0,
      missShare: allMiss ? t.missTokens / allMiss : 0,
      costShare: allCost ? t.costUsd / allCost : 0,
    }))
    .sort((a, b) => b.meanTokens - a.meanTokens);
}

/** Roll the per-lane rows up to the coarse groups. */
export function summarizeGroups(laneRows) {
  const g = new Map();
  for (const l of laneRows) {
    const t = g.get(l.group) ?? { group: l.group, meanTokens: 0, meanMissTokens: 0, meanCostUsd: 0, share: 0, missShare: 0, costShare: 0 };
    for (const k of ['meanTokens', 'meanMissTokens', 'meanCostUsd', 'share', 'missShare', 'costShare']) t[k] += l[k];
    g.set(l.group, t);
  }
  return [...g.values()].sort((a, b) => b.meanTokens - a.meanTokens);
}

// ── reading the box (CLI only) ──

function sqlite(dbPath, sql) {
  const uri = `file:${dbPath}?immutable=1`;
  const out = execFileSync('sqlite3', ['-json', uri, sql], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

function readReceipts(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* a half-written file is skipped */ }
  }
  return out;
}

function parseArgs(argv) {
  const a = { days: 14, json: false, agent: null, db: null, receipts: null, priceIn: null, priceOut: null, hitFactor: 0.1 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--json') a.json = true;
    else if (k === '--agent') a.agent = argv[++i];
    else if (k === '--days') a.days = Number(argv[++i]);
    else if (k === '--db') a.db = argv[++i];
    else if (k === '--receipts') a.receipts = argv[++i];
    else if (k === '--price-in') a.priceIn = Number(argv[++i]);
    else if (k === '--price-out') a.priceOut = Number(argv[++i]);
    else if (k === '--hit-factor') a.hitFactor = Number(argv[++i]);
    else if (k === '--help' || k === '-h') { a.help = true; }
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

const usd = (n, d = 4) => `$${n.toFixed(d)}`;
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const k = (n) => Math.round(n).toLocaleString('en-US');
const median = (xs) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('usage: cost-measure.mjs [--agent <id>] [--days N] [--db path] [--receipts dir] [--price-in $/M] [--price-out $/M] [--hit-factor f] [--json]');
    return;
  }
  const home = os.homedir();
  const dbPath = args.db ?? path.join(home, '.dojo', 'data', 'dojo.db');
  const receiptsRoot = args.receipts ?? path.join(home, '.dojo', 'receipts');
  const agent = args.agent ?? sqlite(dbPath, "SELECT value FROM config WHERE key='primary_agent_id'")[0]?.value;
  if (!agent) throw new Error('no --agent given and the database names no primary agent');
  const safe = agent.replace(/'/g, "''");
  const since = new Date(Date.now() - args.days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');

  const costs = sqlite(dbPath, `
    SELECT c.created_at, c.latency_ms, c.input_tokens, c.cache_read_tokens, c.output_tokens, c.cost_usd,
           c.call_purpose, c.request_type, c.estimated_input_tokens, c.estimator_chars_per_token, c.model_id,
           m.api_model_id, m.input_cost_per_m, m.output_cost_per_m
    FROM cost_records c LEFT JOIN models m ON m.id = c.model_id
    WHERE c.agent_id='${safe}' AND c.created_at >= '${since}' ORDER BY c.created_at`);
  const turns = costs.filter((c) => c.call_purpose === 'agent_turn');
  const days = rollupByDay(costs);

  const receipts = readReceipts(path.join(receiptsRoot, agent));
  const pairs = matchReceiptsToCosts(receipts, turns);
  const opts = { pricePerMIn: args.priceIn ?? undefined, pricePerMOut: args.priceOut ?? undefined, hitPriceFactor: args.hitFactor };
  // the tool head is fitted per model: a model's tokenizer changes the tokens per char
  const byModel = new Map();
  for (const p of pairs) byModel.set(p.cost.model_id, [...(byModel.get(p.cost.model_id) ?? []), p]);
  const fits = new Map();
  const fitNotes = new Map();
  for (const [modelId, ps] of byModel) {
    const fit = fitToolHead(ps);
    // a second, independent reading: the residual of the recorded request size. The fit is only
    // trusted where the two agree; where they do not (a lane whose density differs from the rest
    // bends the line), the residual is used and the report says so.
    const residual = ps.map((p) => attributeCall(p.receipt, p.cost, opts)).filter((a) => a.ok).map((a) => a.lanes[0].tokens);
    const resMedian = median(residual);
    const agrees = fit && resMedian > 0 && Math.abs(fit.toolTokens - resMedian) / resMedian <= 0.35;
    fits.set(modelId, agrees ? fit : null);
    fitNotes.set(modelId, { fit, residualMedianTokens: resMedian, agrees: !!agrees });
  }
  const attributed = pairs.map((p) => {
    const fit = fits.get(p.cost.model_id);
    const idx = turns.indexOf(p.cost);
    const prev = idx > 0 ? turns[idx - 1] : null;
    const gapMs = prev ? Math.max(0, toMs(p.cost.created_at) - (p.cost.latency_ms ?? 0) - toMs(prev.created_at)) : null;
    return { ...attributeCall(p.receipt, p.cost, { ...opts, toolTokens: fit?.toolTokens }), gapMs, loopCount: p.receipt.loopCount, at: p.receipt.at, recordedCostUsd: p.cost.cost_usd, modelId: p.cost.model_id, reserveTokens: p.receipt.assembly?.reserveTokens };
  });
  const good = attributed.filter((a) => a.ok);
  const lanes = summarizeLanes(good);
  const groups = summarizeGroups(lanes);

  // the extrapolation base: average agent_turn spend per UTC day that had any
  const turnDays = rollupByDay(turns);
  const callsPerActiveDay = turnDays.length ? turns.length / turnDays.length : 0;
  const repriced = args.priceIn !== null || args.priceOut !== null;
  // with a price override the recorded cost_usd no longer describes the what-if, so the daily figure
  // is calls per active day x the repriced mean cost of a receipted call
  const meanDailyTurnUsd = repriced
    ? callsPerActiveDay * (good.length ? good.reduce((sum, a) => sum + a.costUsd, 0) / good.length : 0)
    : turnDays.length ? turnDays.reduce((sum, d) => sum + d.costUsd, 0) / turnDays.length : 0;
  const first = good.filter((a) => a.loopCount === 1);
  const later = good.filter((a) => a.loopCount > 1);
  const gapRows = hitByIdleGap(first);
  const groupsFirst = summarizeGroups(summarizeLanes(first));
  const groupsLater = summarizeGroups(summarizeLanes(later));
  const mean = (xs, f) => (xs.length ? xs.reduce((s, x) => s + f(x), 0) / xs.length : 0);
  const fitRows = [...fits.entries()].map(([modelId, f]) => ({ model: costs.find((c) => c.model_id === modelId)?.api_model_id ?? modelId, receipted: byModel.get(modelId).length, fit: f, note: fitNotes.get(modelId) }));
  const fallbackCalls = good.filter((a) => !a.toolsFromFit).length;

  const sinceMs = Date.parse(`${since.replace(' ', 'T')}Z`);
  const convRows = sqlite(dbPath, `SELECT role, content FROM messages WHERE agent_id='${safe}' AND created_at >= ${sinceMs} AND role IN ('assistant','tool') AND (content LIKE '%"type":"tool_use"%' OR content LIKE '%"type":"tool_result"%')`);
  const toolSizes = toolResultSizes(convRows);
  const stability = laneStability(receipts);
  const breaks = prefixBreaks(receipts);

  // what a first call costs, by where its cached prefix broke
  const breakAcc = new Map();
  for (const a of first) {
    const w = breaks.byReceipt.get(a.at)?.where;
    if (!w) continue;
    const t = breakAcc.get(w) ?? { where: w, n: 0, miss: 0, cost: 0 };
    t.n += 1; t.miss += a.missTokens; t.cost += a.costUsd;
    breakAcc.set(w, t);
  }
  const breakCost = [...breakAcc.values()].map((t) => ({ where: t.where, n: t.n, meanMissTokens: t.miss / t.n, meanCostUsd: t.cost / t.n })).sort((x, y) => y.meanCostUsd * y.n - x.meanCostUsd * x.n);

  const report = {
    agent, windowDays: args.days, since,
    models: [...new Set(costs.map((c) => c.api_model_id).filter(Boolean))],
    pricing: { pricePerMIn: args.priceIn, pricePerMOut: args.priceOut, hitPriceFactor: args.hitFactor, note: 'null price = each model row from the models table' },
    receiptsFound: receipts.length, matched: pairs.length, attributed: good.length,
    rejected: attributed.filter((a) => !a.ok).map((a) => a.reason),
    perCall: {
      meanTotalTokens: mean(good, (a) => a.totalTokens), meanMissTokens: mean(good, (a) => a.missTokens),
      meanHitRatio: mean(good, (a) => a.hitTokens / a.totalTokens), meanCostUsd: mean(good, (a) => a.costUsd),
      firstCallOfTurn: { n: first.length, meanTotal: mean(first, (a) => a.totalTokens), hitRatio: mean(first, (a) => a.hitTokens / a.totalTokens), meanCostUsd: mean(first, (a) => a.costUsd) },
      laterCalls: { n: later.length, meanTotal: mean(later, (a) => a.totalTokens), hitRatio: mean(later, (a) => a.hitTokens / a.totalTokens), meanCostUsd: mean(later, (a) => a.costUsd) },
    },
    toolHeadFits: fitRows, callsUsingResidualFallback: fallbackCalls, medianAssemblyReserveTokens: median(good.map((a) => a.reserveTokens ?? 0)),
    meanDailyAgentTurnUsd: meanDailyTurnUsd, callsPerActiveDay, activeDays: turnDays.length, repriced,
    firstCallHitByIdleGap: gapRows, groupsFirstCall: groupsFirst, groupsLaterCalls: groupsLater, groups, lanes, days, toolResultSizes: toolSizes, laneStability: stability, prefixBreaks: { ...breaks, byReceipt: undefined }, firstCallCostByBreak: breakCost,
  };
  if (args.json) { console.log(JSON.stringify(report, null, 1)); return report; }

  const L = (s = '') => console.log(s);
  L(`COST MEASURE  agent ${agent}  window ${args.days}d (since ${since} UTC)`);
  L(`models: ${report.models.join(', ') || 'unknown'}   all calls in window: ${costs.length}   agent_turn calls: ${turns.length}`);
  L(`receipts on disk: ${receipts.length} (platform keeps the newest 200)   paired to a call: ${pairs.length}   attributable: ${good.length}`);
  for (const r of new Set(report.rejected)) L(`  rejected: ${r}`);
  L();
  L('PER DAY (every recorded call, every purpose)');
  L('  day         calls   input tokens   hit%     cost     of which agent_turn');
  for (const d of days) L(`  ${d.day}  ${String(d.calls).padStart(5)}  ${k(d.tokens).padStart(13)}  ${pct(d.hitRatio).padStart(6)}  ${usd(d.costUsd, 2).padStart(8)}   ${usd(d.byPurpose.agent_turn ?? 0, 2)}`);
  const purposeTotals = {};
  for (const d of days) for (const [p, v] of Object.entries(d.byPurpose)) purposeTotals[p] = (purposeTotals[p] ?? 0) + v;
  const spend = Object.values(purposeTotals).reduce((s, v) => s + v, 0);
  L(`  window total ${usd(spend, 2)}; by purpose: ${Object.entries(purposeTotals).sort((a, b) => b[1] - a[1]).map(([p, v]) => `${p} ${usd(v, 2)} (${pct(spend ? v / spend : 0)})`).join(', ')}`);
  L();
  if (good.length === 0) { L('No receipted call could be attributed; nothing more to report.'); return report; }
  const pc = report.perCall;
  L(`PER CALL (n=${good.length} receipted agent_turn calls)`);
  L(`  mean input ${k(pc.meanTotalTokens)} tokens, of which missed (billed full rate) ${k(pc.meanMissTokens)}; mean hit ratio ${pct(pc.meanHitRatio)}; mean cost ${usd(pc.meanCostUsd)}`);
  L(`  first call of a turn: n=${first.length}  input ${k(pc.firstCallOfTurn.meanTotal)}  hit ${pct(pc.firstCallOfTurn.hitRatio)}  cost ${usd(pc.firstCallOfTurn.meanCostUsd)}`);
  L(`  later calls in a turn: n=${later.length}  input ${k(pc.laterCalls.meanTotal)}  hit ${pct(pc.laterCalls.hitRatio)}  cost ${usd(pc.laterCalls.meanCostUsd)}`);
  for (const r of fitRows) {
    L(r.fit
      ? `  tool head, ${r.model}: ${k(r.fit.toolTokens)} tokens (fit over ${r.fit.n} calls: ${r.fit.tokensPerChar.toFixed(3)} tokens/char, r=${r.fit.r.toFixed(3)}, residual sd ${k(r.fit.residualSd)} tokens)`
      : `  tool head, ${r.model}: line fit ${r.note.fit ? `read ${k(r.note.fit.toolTokens)} tokens (r=${r.note.fit.r.toFixed(3)})` : 'unusable'}, residual reading ${k(r.note.residualMedianTokens)} tokens: they disagree, so the residual is used over ${r.receipted} receipted calls`);
  }
  for (const r of fitRows.filter((x) => x.fit)) L(`      residual reading of the same head: ${k(r.note.residualMedianTokens)} tokens (agrees within 35%)`);
  L(`  cross-check: the assembly's own reserve for tools + output, median ${k(report.medianAssemblyReserveTokens)} tokens (an estimate, expected to read high); calls on the residual fallback: ${fallbackCalls}`);
  L();
  L('WHERE THE INPUT GOES, BY GROUP   (tokens/call, % of tokens, % of the MISSED tokens, % of input cost, projected $/day)');
  for (const g of groups) L(`  ${g.group.padEnd(17)} ${k(g.meanTokens).padStart(8)}  ${pct(g.share).padStart(6)}  miss ${pct(g.missShare).padStart(6)}  cost ${pct(g.costShare).padStart(6)}  ~${usd(g.costShare * meanDailyTurnUsd, 3)}/day`);
  L();
  L('WHAT MISSES, FIRST CALL OF A TURN vs LATER CALLS   (missed tokens/call, % of that call type\'s misses, $/call)');
  for (const [label, gs, n] of [['first call', groupsFirst, first.length], ['later calls', groupsLater, later.length]]) {
    L(`  ${label} (n=${n})`);
    for (const g of [...gs].sort((a, b) => b.meanMissTokens - a.meanMissTokens)) L(`    ${g.group.padEnd(17)} miss ${k(g.meanMissTokens).padStart(7)}  ${pct(g.missShare).padStart(6)}  ${usd(g.meanCostUsd, 5)}/call`);
  }
  L();
  L('FIRST CALL OF A TURN: cache-hit ratio by how long the agent had been quiet');
  for (const g of gapRows) L(`  ${g.bucket.padEnd(12)} n=${String(g.n).padStart(3)}  hit ${pct(g.hitRatio).padStart(6)}  ${usd(g.meanCostUsd, 5)}/call`);
  L();
  L('BY LANE');
  L('  lane                          group              tokens/call   %tok    miss/call  %miss   %cost   ~$/day');
  for (const l of lanes) L(`  ${l.id.padEnd(30)}${l.group.padEnd(18)} ${k(l.meanTokens).padStart(9)}  ${pct(l.share).padStart(6)}  ${k(l.meanMissTokens).padStart(8)}  ${pct(l.missShare).padStart(6)}  ${pct(l.costShare).padStart(6)}  ${usd(l.costShare * meanDailyTurnUsd, 3)}`);
  L();
  L();
  L('WHERE THE CACHED PREFIX BREAKS between consecutive requests (first differing message by receipt hash)');
  for (const [label, d] of [['first call of a turn', breaks.turnStart], ['later call, same turn', breaks.sameTurn]]) {
    L(`  ${label} (${d.pairs} pairs): ${d.breaks.map((b) => `${b.where} ${pct(b.share)}`).join(', ')}`);
    L(`      median share of the messages kept byte-identical: ${pct(d.medianKeptShare)}; pairs whose break falls in the first quarter of the messages: ${pct(d.breakInFirstQuarter)}`);
  }
  L('  what a first call costs, by where its prefix broke:');
  for (const b of breakCost) L(`    ${b.where.padEnd(30)} n=${String(b.n).padStart(3)}  missed ${k(b.meanMissTokens).padStart(7)} tokens  ${usd(b.meanCostUsd, 5)}/call`);
  L();
  L('LANES AFTER THE TAIL: how often a lane is byte-identical to the previous call of the same turn');
  for (const t of stability.filter((x) => x.pairs >= 10)) L(`  ${t.id.padEnd(30)} ${pct(t.unchangedShare).padStart(6)} unchanged  (${t.unchanged}/${t.pairs} consecutive call pairs)`);
  L();
  L('WHAT FILLS THE TAIL: tool-result size by tool, conversation store, same window (chars; ~3 chars/token on this box)');
  L('  tool                          results   mean chars   p95 chars    max chars   total chars');
  for (const t of toolSizes.slice(0, 15)) L(`  ${t.tool.padEnd(30)}${String(t.count).padStart(7)}  ${k(t.meanChars).padStart(11)}  ${k(t.p95Chars).padStart(10)}  ${k(t.maxChars).padStart(11)}  ${k(t.totalChars).padStart(12)}`);
  L();
  L(`~$/day = the lane's share of input cost x the mean daily agent_turn spend in the window (${usd(meanDailyTurnUsd, 2)}${repriced ? ', repriced' : ''}; ${callsPerActiveDay.toFixed(0)} calls over ${turnDays.length} active days); an extrapolation from the receipted sample, which is the newest ${good.length} calls.`);
  L('Method and its blur (chars-proportional split; derived tool head; miss walked from the request end) are in the header of this file.');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`cost-measure: ${e.message}`); process.exit(1); }
}
