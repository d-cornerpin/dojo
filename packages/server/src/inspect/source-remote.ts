// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect A2 — THE DOJO'S SOURCE, READ FROM GITHUB AT THE COMMIT THIS BOX RUNS.
//
// OWNER RULING 2026-10-20: "We don't need the source code on the box. Instead, the tool can
// point the agent to the repo on GitHub." The repository is public, so a file the agent can
// name is one unauthenticated raw read away, at the exact commit the running code was built
// from. Search is GitHub's code search, which needs the owner's GitHub connection; without one
// the agent is told so and still gets the link and the raw-read form.
//
// WHICH COMMIT. The same resolver the boot stamp uses (`boot-stamp.ts`: an explicit override,
// then the packaged `build-info.json`, then the dev checkout's HEAD), and the version from the
// tree's one version authority. No second answer to "what code is this".
//
// NEVER A THROW, NEVER A WRITE. Every failure (no connection, GitHub down, a refusal, a file
// not in that commit) is a plain sentence plus the link, so the agent never has to interpret an
// error. A refusal is GitHub's own words; nothing is recorded on the connection ledger, because
// dojo_inspect never writes. Every result passes the scrubber and ends with the pointer line.
// ════════════════════════════════════════════════════════════════════════════════════════

import { resolveSha } from '../boot-stamp.js';
import { getCurrentVersion } from '../gateway/routes/update.js';
import { DOJO_REPORT_REPO_DEFAULT } from '../report/repo.js';
import { getGithubToken } from '../github/account.js';
import { GITHUB_API, ISSUE_HTTP_TIMEOUT_MS } from '../github/issues.js';
import { readRefusal, githubsWords } from '../github/refusal.js';
import { redactText } from './redact.js';

export interface SourceRef { owner: string; repo: string; sha: string; version: string; url: string }

const [OWNER, REPO] = DOJO_REPORT_REPO_DEFAULT.split('/');

let cached: { key: string | undefined; ref: SourceRef } | null = null;

/** The commit and version this box runs. With no resolvable sha, the release tag of the
 *  running version, which is the next most exact name GitHub knows for the same code. */
export function sourceRef(): SourceRef {
  const key = process.env.DOJO_BUILD_SHA;
  if (cached && cached.key === key) return cached.ref;
  const version = getCurrentVersion();
  const sha = resolveSha().sha ?? `v${version}`;
  const ref = { owner: OWNER, repo: REPO, sha, version, url: `https://github.com/${OWNER}/${REPO}/tree/${sha}` };
  cached = { key, ref };
  return ref;
}

/** The line every code result ends with, so the agent can hand the link on or browse it. */
export function pointerLine(ref: SourceRef = sourceRef()): string {
  return `Source: ${ref.url} (the commit this box runs, v${ref.version}).`;
}

function rawUrl(ref: SourceRef, path: string): string {
  return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function blobUrl(ref: SourceRef, path: string): string {
  return `https://github.com/${ref.owner}/${ref.repo}/blob/${ref.sha}/${path}`;
}

/** A repository-relative path, or null. No climbing, no absolute path, no URL, no home. */
export function repoPath(input: string): string | null {
  const p = input.trim().replace(/^\.\//, '');
  if (p === '' || p.startsWith('/') || p.startsWith('~') || p.includes('\\') || p.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(p)) return null;
  const segs = p.split('/');
  if (segs.some((s) => s === '..' || s === '.' || s === '')) return null;
  return p;
}

const REFUSED_PATH = (input: string): string =>
  `"${input}" is not a path inside the Dojo repository. Give it from the repository root, for example packages/server/src/work/store.ts.`;

function unreachable(ref: SourceRef, what: string, err: unknown): string {
  const why = err instanceof Error ? err.message : String(err);
  return `GitHub could not be reached (${why}), so ${what}. Open it in a browser at ${ref.url}, or try again in a minute.\n\n${pointerLine(ref)}`;
}

type Got = { ok: true; body: string } | { ok: false; down: false; status: number; words: string } | { ok: false; down: true; error: unknown };

async function get(url: string, headers: Record<string, string> = {}): Promise<Got> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(ISSUE_HTTP_TIMEOUT_MS) });
    if (res.ok) return { ok: true, body: await res.text() };
    return { ok: false, down: false, status: res.status, words: githubsWords(await readRefusal(res)) };
  } catch (error) {
    return { ok: false, down: true, error };
  }
}

/** Number lines `from..to` (1-based, inclusive) of `lines`, right-aligned to the widest number. */
function numbered(lines: string[], from: number, to: number): string {
  const width = String(to).length;
  return lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(width)}  ${l}`).join('\n');
}

function splitLines(body: string): string[] {
  const lines = body.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** One file at the running commit, numbered; the asked range, or the whole file. */
export async function readSourceFile(path: string, from?: number, to?: number): Promise<string> {
  const ref = sourceRef();
  const p = repoPath(path);
  if (p === null) return `${REFUSED_PATH(path)}\n\n${pointerLine(ref)}`;
  const got = await get(rawUrl(ref, p));
  if (!got.ok) {
    if (got.down) return unreachable(ref, `${p} was not read; it is at ${blobUrl(ref, p)}`, got.error);
    if (got.status === 404) return `No file at ${p} in the commit this box runs. Search for it with code_search, or browse ${ref.url}.\n\n${pointerLine(ref)}`;
    return `GitHub refused the read of ${p} (HTTP ${got.status}). ${got.words} It is at ${blobUrl(ref, p)}.\n\n${pointerLine(ref)}`;
  }
  const lines = splitLines(redactText(got.body));
  const total = lines.length;
  const a = Math.max(1, Math.min(from ?? 1, total));
  const b = Math.max(a, Math.min(to ?? total, total));
  const range = a === 1 && b === total ? `all ${total} lines` : `lines ${a}–${b} of ${total}`;
  return `${p} — ${range}\n\n${numbered(lines, a, b)}\n\n${pointerLine(ref)}`;
}

/** GitHub's own documented page size ceiling for search results. */
const SEARCH_PER_PAGE = 100;

/**
 * Search the repository. GitHub's code search indexes the DEFAULT BRANCH, so each file it names
 * is then read at the running commit and the matching lines are shown from THAT copy: the line
 * numbers are the running code's, and a hit that has since moved says so.
 */
export async function searchSource(pattern: string, pathPrefix?: string): Promise<string> {
  const ref = sourceRef();
  const token = getGithubToken();
  if (!token) {
    return `Searching the Dojo's source needs a GitHub connection, and this box has none (the owner can connect GitHub in Settings). `
      + `Browse the source at ${ref.url}, or read a file you can name with code_read, which reads `
      + `${rawUrl(ref, '').replace(/\/$/, '')}/<path> and needs no connection.\n\n${pointerLine(ref)}`;
  }
  const prefix = pathPrefix ? repoPath(pathPrefix) : null;
  if (pathPrefix && prefix === null) return `${REFUSED_PATH(pathPrefix)}\n\n${pointerLine(ref)}`;
  const q = `${pattern} repo:${ref.owner}/${ref.repo}${prefix ? ` path:${prefix}` : ''}`;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}` };
  const paths: string[] = [];
  let total = 0; let stopped = '';
  for (let page = 1; ; page++) {
    const got = await get(`${GITHUB_API}/search/code?q=${encodeURIComponent(q)}&per_page=${SEARCH_PER_PAGE}&page=${page}`, headers);
    if (!got.ok) {
      if (paths.length === 0 && got.down) return unreachable(ref, 'the search did not run', got.error);
      const why = got.down ? 'GitHub stopped answering before the last page.' : `GitHub refused the search (HTTP ${got.status}). ${got.words}`;
      if (paths.length === 0) return `${why} Browse the source at ${ref.url}.\n\n${pointerLine(ref)}`;
      stopped = why;
      break;
    }
    let body: { total_count?: number; items?: Array<{ path?: unknown }> } = {};
    try { body = JSON.parse(got.body) as typeof body; } catch { stopped = 'GitHub answered the search with a body this box could not read.'; break; }
    const items = (body.items ?? []).map((i) => i.path).filter((x): x is string => typeof x === 'string');
    total = body.total_count ?? items.length;
    paths.push(...items);
    if (items.length < SEARCH_PER_PAGE || paths.length >= total) break;
  }
  if (paths.length === 0 && stopped) return `${stopped} Browse the source at ${ref.url}.\n\n${pointerLine(ref)}`;
  if (paths.length === 0) return `No match for "${pattern}"${prefix ? ` under ${prefix}` : ''} in the Dojo's source.\n\n${pointerLine(ref)}`;
  const terms = pattern.toLowerCase().split(/\s+/).filter((t) => t && !t.includes(':'));
  const files = await Promise.all([...new Set(paths)].map(async (p) => {
    const got = await get(rawUrl(ref, p));
    if (!got.ok) return `${p}\n  (named by the search; not readable at this commit: ${!got.down && got.status === 404 ? 'the file is not in it' : 'GitHub did not answer'})`;
    const hits = splitLines(redactText(got.body))
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => terms.every((t) => l.toLowerCase().includes(t)));
    return hits.length === 0
      ? `${p}\n  (named by the search, which reads the default branch; no line at this commit contains it)`
      : `${p}\n${hits.map(({ l, n }) => `  ${n}: ${l}`).join('\n')}`;
  }));
  const head = `${total} file${total === 1 ? '' : 's'} match "${pattern}"${prefix ? ` under ${prefix}` : ''}; lines are from the commit this box runs.`;
  return `${head}\n\n${files.join('\n\n')}${stopped ? `\n\n${stopped}` : ''}\n\n${pointerLine(ref)}`;
}
