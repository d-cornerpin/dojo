#!/usr/bin/env node
// The release scripts' one version order, the engine's compareVersions (gateway/routes/update.ts): a higher base
// wins, a stable release outranks every pre-release of its base, two pre-releases compare by ordinal, and a
// malformed segment counts as 0.
//   node version-rank.mjs A B ...           prints the highest
//   node version-rank.mjs --above A B ...   exits 0 iff A ranks strictly above every other
const parse = (v) => {
  const s = String(v).replace(/^v/, '');
  const d = s.indexOf('-');
  const base = (d === -1 ? s : s.slice(0, d)).split('.').map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0));
  const pt = d === -1 ? '' : s.slice(d + 1);
  return { base, pre: pt ? Number(pt.match(/(\d+)\s*$/)?.[1] ?? 0) : null };
};
const cmp = (x, y) => {
  const [a, b] = [parse(x), parse(y)];
  for (let i = 0; i < 3; i++) { const d = (a.base[i] || 0) - (b.base[i] || 0); if (d) return d; }
  if (a.pre === null || b.pre === null) return (a.pre === null ? 1 : 0) - (b.pre === null ? 1 : 0);
  return a.pre - b.pre;
};

const args = process.argv.slice(2).filter(Boolean);
if (args[0] === '--above') {
  const [, v, ...others] = args;
  process.exit(others.every((o) => cmp(v, o) > 0) ? 0 : 1);
}
console.log(args.reduce((hi, v) => (cmp(v, hi) > 0 ? v : hi), args[0] ?? ''));
