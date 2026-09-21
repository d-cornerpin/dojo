// ════════════════════════════════════════════════════════════════════════════
// THE SIGN-IN SCOPES ARE DERIVED FROM THE CALLS, NOT VIBES (t83)
//
// ── THE INCIDENT ──
// `microsoft/auth.ts`'s SCOPES list never requested the Teams delegated
// permissions, while `microsoft/tools-read.ts` + `tools-write.ts` shipped
// teams_list_teams / teams_list_channels / teams_read_channel_messages /
// teams_send_channel_message calling /me/joinedTeams, /teams/{id}/channels,
// and channel-message endpoints. The Entra app registration was configured to
// MIRROR the code's scope list, so a portal audit could never see the gap —
// only comparing the requested scopes against the REAL endpoint surface can.
//
// ── WHAT THIS TEST IS ──
// The comparison, kept honest against drift, so it never happens again:
//   (a) STATICALLY EXTRACT every Microsoft Graph endpoint the production code
//       can call. Not a hand list of endpoint strings — a small source-level
//       parser over the actual call sites (msGraphRead / msGraphWrite / a raw
//       fetch()), so a brand-new endpoint is found automatically the day it's
//       coded, the same way `tool-list-conformance.test.ts` derives its
//       registry from source instead of a maintained list (the house
//       precedent named in the task).
//   (b) Map each endpoint's normalized SHAPE to its required delegated Graph
//       scope(s) via the explicit, commented MAPPING table below — every row
//       cites the Graph permission its docs page names. THIS TABLE is the
//       reviewable artifact: a reviewer checks it against Microsoft's Graph
//       permissions reference, not against the parser.
//   (c) Assert every required scope is a member of SCOPES.
//   (d) FAIL CLOSED: an endpoint whose normalized shape matches no row in the
//       table is a test FAILURE naming the endpoint — never a silent pass.
//
// Twin: google/__tests__/the-signin-scopes-cover-every-google-call.test.ts
// (same structure; different call shapes and a completely different scope
// vocabulary, so it stays a separate file rather than one force-shared
// abstraction — see that file's header for the argument).
//
// Mutation-proof (2026-09-20, David Cliff / t83): a fake
// `msGraphRead('groups/${groupId}/members', ...)` call was added to
// tools-read.ts and this test failed with "no mapping row matches
// 'groups/*/members'" as expected, then the line was removed. Confirms
// clause (d) actually fails closed rather than silently passing an unknown
// shape.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MS_DIR = path.resolve(HERE, '..');

// ── Files that make Graph calls, scanned for call sites. `client.ts` is
// EXCLUDED here on purpose: it DEFINES msGraphRead/msGraphWrite (its own
// declaration lines would otherwise look like call sites), and its only
// internal fetch() takes a fully-dynamic `endpoint` argument that is just
// every call site below, already counted once at its real origin. client.ts's
// prefix HELPERS (calendarPrefix / drivePrefix) are instead pinned by a
// separate textual guard below, so a change to their shapes still fails this
// file instead of silently invalidating the CAL/DRV assumptions baked into
// the scanner.
const SCAN_FILES = ['auth.ts', 'tools-read.ts', 'tools-write.ts', 'tools-office.ts'];
const CLIENT_TS = path.join(MS_DIR, 'client.ts');

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';

// ════════════════════════════════════════════════════════════════════════════
// ── A small source-level parser ──
// No AST library: a hand-rolled balanced scanner over backticks / quotes /
// parens / braces, exactly the level of "static scan" the house precedent
// (tool-list-conformance.test.ts) uses for its own regex-over-source scans.
// ════════════════════════════════════════════════════════════════════════════

function skipStringLiteral(s: string, i: number): number {
  const quote = s[i];
  i++;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === quote) return i + 1;
    i++;
  }
  return i;
}

function skipTemplateLiteral(s: string, i: number): number {
  i++; // past opening backtick
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '`') return i + 1;
    if (s[i] === '$' && s[i + 1] === '{') { i = skipBraces(s, i + 1); continue; }
    i++;
  }
  return i;
}

// Recognizes exactly /'/ or /"/ (optionally with flag letters) — the one
// regex-literal shape these files use (`.replace(/'/g, "''")`, building an
// OData $filter value in tools-write.ts's getOrCreateOneDriveFolder). Without
// this, the scanner reads the quote INSIDE the regex as a STRING opener and
// then hunts for the next matching quote, which lands inside the following
// `"''"` and swallows everything after it as one bogus "string" — verified
// against a real failure this exact call site produced. A full regex-vs-
// division disambiguator is unneeded complexity for a test-only scanner;
// this narrow, exact recognition is enough.
function skipQuoteEscapingRegexLiteral(s: string, i: number): number | null {
  if (s[i] !== '/') return null;
  if ((s[i + 1] === '\'' || s[i + 1] === '"') && s[i + 2] === '/') {
    let k = i + 3;
    while (/[a-zA-Z]/.test(s[k] ?? '')) k++;
    return k;
  }
  return null;
}

function skipBraces(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    const rx = skipQuoteEscapingRegexLiteral(s, i);
    if (rx !== null) { i = rx; continue; }
    if (c === '{') { depth++; i++; }
    else if (c === '}') { depth--; i++; if (depth === 0) return i; }
    else if (c === '`') i = skipTemplateLiteral(s, i);
    else if (c === '\'' || c === '"') i = skipStringLiteral(s, i);
    else if (c === '(') i = skipParens(s, i);
    else i++;
  }
  return i;
}

function skipParens(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    const rx = skipQuoteEscapingRegexLiteral(s, i);
    if (rx !== null) { i = rx; continue; }
    if (c === '(') { depth++; i++; }
    else if (c === ')') { depth--; i++; if (depth === 0) return i; }
    else if (c === '`') i = skipTemplateLiteral(s, i);
    else if (c === '\'' || c === '"') i = skipStringLiteral(s, i);
    else if (c === '{') i = skipBraces(s, i);
    else i++;
  }
  return i;
}

// Blank out comments (preserving length/newlines so offsets stay meaningful)
// without touching string/template literal CONTENTS — a prose comment like
// "a read-only Sent-Items re-fetch (never re-sends)" contains the literal
// text "fetch (" and would otherwise be misread as a call site.
function stripComments(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '`') { const end = skipTemplateLiteral(s, i); out += s.slice(i, end); i = end; continue; }
    if (s[i] === '\'' || s[i] === '"') { const end = skipStringLiteral(s, i); out += s.slice(i, end); i = end; continue; }
    { const rx = skipQuoteEscapingRegexLiteral(s, i); if (rx !== null) { out += s.slice(i, rx); i = rx; continue; } }
    if (s[i] === '/' && s[i + 1] === '/') {
      let j = i;
      while (j < s.length && s[j] !== '\n') j++;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (s[i] === '/' && s[i + 1] === '*') {
      let j = i + 2;
      while (j < s.length && !(s[j] === '*' && s[j + 1] === '/')) j++;
      j = Math.min(j + 2, s.length);
      let blanked = '';
      for (let k = i; k < j; k++) blanked += s[k] === '\n' ? '\n' : ' ';
      out += blanked;
      i = j;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

function splitTopLevelArgs(s: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '`') { i = skipTemplateLiteral(s, i); continue; }
    if (c === '\'' || c === '"') { i = skipStringLiteral(s, i); continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; i++; continue; }
    if (c === ',' && depth === 0) { args.push(s.slice(start, i)); start = i + 1; i++; continue; }
    i++;
  }
  args.push(s.slice(start));
  return args.map(a => a.trim());
}

function readStatementRHS(s: string, i: number): string {
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if (c === '`') { i = skipTemplateLiteral(s, i); continue; }
    if (c === '\'' || c === '"') { i = skipStringLiteral(s, i); continue; }
    if (c === '(') { i = skipParens(s, i); continue; }
    if (c === '{') { i = skipBraces(s, i); continue; }
    if (c === ';') break;
    i++;
  }
  return s.slice(start, i);
}

function splitTernary(expr: string): { then: string; else: string } | null {
  let depth = 0;
  let qIdx = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '`') { i = skipTemplateLiteral(expr, i) - 1; continue; }
    if (c === '\'' || c === '"') { i = skipStringLiteral(expr, i) - 1; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (depth === 0 && c === '?' && expr[i + 1] !== '.' && expr[i + 1] !== '?') { qIdx = i; break; }
  }
  if (qIdx === -1) return null;
  let balance = 1;
  let i = qIdx + 1;
  let colonIdx = -1;
  let d2 = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '`') { i = skipTemplateLiteral(expr, i); continue; }
    if (c === '\'' || c === '"') { i = skipStringLiteral(expr, i); continue; }
    if (c === '(' || c === '[' || c === '{') { d2++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { d2--; i++; continue; }
    if (d2 === 0 && c === '?' && expr[i + 1] !== '.' && expr[i + 1] !== '?') { balance++; i++; continue; }
    if (d2 === 0 && c === ':') { balance--; if (balance === 0) { colonIdx = i; break; } i++; continue; }
    i++;
  }
  if (colonIdx === -1) return null;
  return { then: expr.slice(qIdx + 1, colonIdx), else: expr.slice(colonIdx + 1) };
}

interface Ctx { fileText: string; }
interface Expansion { strings: string[]; unresolved: string[]; }

function cartesian(prefixes: string[], options: string[]): string[] {
  const out: string[] = [];
  for (const p of prefixes) for (const o of options) out.push(p + o);
  return out;
}

// Nearest preceding `case '...':` (this codebase's per-tool block boundary),
// bounded to at most 6000 chars back so a top-level helper function (not
// inside any switch) still gets a sane local window instead of the whole file.
function blockStart(fileText: string, idx: number): number {
  const caseRe = /\bcase\s+'[^']*'\s*:/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(fileText))) {
    if (m.index >= idx) break;
    last = m.index;
  }
  return Math.max(last, idx - 6000, 0);
}

function findAssignmentsInRange(fileText: string, ident: string, from: number, to: number): string[] {
  const scope = fileText.slice(from, to);
  const results: string[] = [];
  const re = new RegExp(String.raw`(?<![.\w$])(?:const|let)?\s*\b${ident}\b\s*=(?!=)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope))) {
    const rhs = readStatementRHS(scope, m.index + m[0].length).trim();
    if (rhs) results.push(rhs);
  }
  return results;
}

// Local (per-tool-case / 6000-char-bounded) window first; a module-level
// const declared once near the top of the file (e.g. auth.ts's AUTH_BASE)
// falls outside every local window, so an empty local result retries across
// the WHOLE file up to the use site before being reported unresolved.
function findAssignmentsBefore(fileText: string, ident: string, idx: number): string[] {
  const local = findAssignmentsInRange(fileText, ident, blockStart(fileText, idx), idx);
  if (local.length > 0) return local;
  return findAssignmentsInRange(fileText, ident, 0, idx);
}

// Expand a template literal's inner text to every fully-expanded string it
// can produce, recursing into each `${...}` via resolveExpr (below) — so a
// ternary of ACTION NAMES nested inside an interpolation (`${replyAll ?
// 'replyAll' : 'reply'}`) resolves to its real branches instead of
// collapsing to a wildcard that would hide the reply-vs-createReply /
// Mail.Send-vs-Mail.ReadWrite distinction the mapping table depends on.
function expandTemplateInner(content: string, ctx: Ctx, nearIndex: number): Expansion {
  let results = [''];
  const unresolved: string[] = [];
  let i = 0;
  while (i < content.length) {
    if (content[i] === '\\') { results = results.map(r => r + content[i] + (content[i + 1] ?? '')); i += 2; continue; }
    if (content[i] === '$' && content[i + 1] === '{') {
      const close = skipBraces(content, i + 1);
      const inner = content.slice(i + 2, close - 1).trim();
      const opt = resolveExpr(inner, ctx, nearIndex);
      results = cartesian(results, opt.strings.length ? opt.strings : ['*']);
      unresolved.push(...opt.unresolved);
      i = close;
      continue;
    }
    const ch = content[i];
    results = results.map(r => r + ch);
    i++;
  }
  return { strings: results, unresolved };
}

function resolveExpr(expr: string, ctx: Ctx, nearIndex: number): Expansion {
  expr = expr.trim();
  if (expr === 'GRAPH_BASE') return { strings: [GRAPH_ROOT], unresolved: [] };
  if (expr === 'prefix' || /^drivePrefix\(/.test(expr)) return { strings: ['@@DRV@@'], unresolved: [] };
  if (/^calendarPrefix\(/.test(expr)) return { strings: ['@@CAL@@'], unresolved: [] };
  if (expr.startsWith('`') && expr.endsWith('`')) {
    return expandTemplateInner(expr.slice(1, -1), ctx, nearIndex);
  }
  if ((expr.startsWith("'") && expr.endsWith("'")) || (expr.startsWith('"') && expr.endsWith('"'))) {
    return { strings: [expr.slice(1, -1)], unresolved: [] };
  }
  const tern = splitTernary(expr);
  if (tern) {
    const a = resolveExpr(tern.then, ctx, nearIndex);
    const b = resolveExpr(tern.else, ctx, nearIndex);
    return { strings: [...a.strings, ...b.strings], unresolved: [...a.unresolved, ...b.unresolved] };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) return resolveIdentifier(expr, ctx, nearIndex);
  // Anything else — a function call (encodeURIComponent(...), Math.min(...)),
  // a cast/coalesce ((x as number) ?? 10), member/computed access
  // (endpointMap[response]) — is, at every site in this codebase (verified by
  // hand), a runtime VALUE: an id, a count. It is never a resource-family
  // path segment, so it wildcards rather than fails. The fail-closed
  // guarantee lives in the OUTER shape-vs-mapping-table check below, not
  // here — see this file's header for why that split is safe.
  return { strings: ['*'], unresolved: [] };
}

function resolveIdentifier(ident: string, ctx: Ctx, nearIndex: number): Expansion {
  const assigns = findAssignmentsBefore(ctx.fileText, ident, nearIndex);
  if (assigns.length === 0) {
    // No `const`/`let`/bare-reassignment found — almost always a function
    // PARAMETER (maxResults, days, max, ...): a caller-supplied VALUE by
    // definition, never a resource-family path segment. Wildcard it; the
    // fail-closed guarantee is the outer shape-vs-mapping-table check, not
    // this trace. Recorded (not thrown) so the extraction-sanity describe
    // block below can still sanity-check the size of this bucket.
    UNRESOLVED_IDENTIFIERS.add(ident);
    return { strings: ['*'], unresolved: [] };
  }
  const strings: string[] = [];
  const unresolved: string[] = [];
  for (const rhs of assigns) {
    const r = resolveExpr(rhs, ctx, nearIndex);
    strings.push(...r.strings);
    unresolved.push(...r.unresolved);
  }
  return { strings, unresolved };
}

const UNRESOLVED_IDENTIFIERS = new Set<string>();

// ── Call-site discovery: every literal endpoint msGraphRead / msGraphWrite /
// a raw fetch() can be handed, across the whole file. ──
interface CallSite { file: string; kind: 'read' | 'write' | 'fetch'; verb?: string; endpointExprText: string; index: number; }

function findCallSites(file: string, fileText: string): CallSite[] {
  const sites: CallSite[] = [];
  const re = /\b(msGraphRead|msGraphWrite|fetch)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fileText))) {
    const name = m[1];
    const openIdx = re.lastIndex - 1;
    const afterClose = skipParens(fileText, openIdx);
    const inner = fileText.slice(openIdx + 1, afterClose - 1);
    const args = splitTopLevelArgs(inner);
    if (name === 'msGraphRead' && args[0] !== undefined) {
      sites.push({ file, kind: 'read', endpointExprText: args[0], index: openIdx });
    } else if (name === 'msGraphWrite' && args[1] !== undefined) {
      const verbMatch = args[0]?.trim().match(/^['"]([A-Z]+)['"]$/);
      sites.push({ file, kind: 'write', verb: verbMatch?.[1], endpointExprText: args[1], index: openIdx });
    } else if (name === 'fetch' && args[0] !== undefined) {
      sites.push({ file, kind: 'fetch', endpointExprText: args[0], index: openIdx });
    }
    re.lastIndex = afterClose;
  }
  return sites;
}

interface ResolvedEndpoint { file: string; kind: 'read' | 'write' | 'fetch'; verb?: string; shape: string; sourceHint: string; }

// A raw fetch() argument that is a Graph-ISSUED URL from a PRIOR call in the
// same function, not a statically-authored path — the URL's own resource
// already required a scope this table assigns elsewhere. Each entry names
// exactly which prior call authorizes it, so this list can't silently grow
// into a real fail-closed hole.
const KNOWN_DYNAMIC_PASSTHROUGH: Record<string, string> = {
  'session.uploadUrl': 'the uploadUrl returned by a prior createUploadSession call on a me/drive|drives/ item — already covered by the Files.ReadWrite(.All) row',
  'att.contentUrl': 'a Teams attachment contentUrl from a prior chats/*/messages/* read — non-SharePoint fallback branch; the SharePoint branch resolves the same attachment via shares/{id}, already covered by the Files.ReadWrite.All row',
};

// OAuth-FLOW plumbing, not a Graph resource a scope gates: the token/auth
// endpoint (login.microsoftonline.com), scanned because it's the `fetch()`
// AUTH_BASE resolves to in auth.ts's exchangeCodeForTokens/refresh calls.
// An explicit, named allowlist — NOT a blanket "any other https:// URL is
// fine" — because that blanket form is exactly how a brand-new endpoint on a
// brand-new domain (a real regression) would go undetected instead of
// failing closed (caught in review: an earlier draft of this scanner did
// exactly that, and a mutation probe on a wholly different domain slipped
// through silently instead of failing).
const OOB_URL_PREFIXES = ['https://login.microsoftonline.com/'];

function normalizeExpanded(raw: string): string | null {
  let s = raw;
  if (s.startsWith(GRAPH_ROOT + '/')) s = s.slice(GRAPH_ROOT.length + 1);
  else if (s.startsWith(GRAPH_ROOT)) s = s.slice(GRAPH_ROOT.length);
  else if (OOB_URL_PREFIXES.some(p => s.startsWith(p))) return null;
  else if (/^https?:\/\//.test(s)) return s; // an unrecognized absolute URL: keep it AS the shape so it fails the mapping-table check below, rather than vanishing silently.
  const qIdx = s.indexOf('?');
  if (qIdx !== -1) s = s.slice(0, qIdx);
  return s;
}

const errors: string[] = [];
const resolved: ResolvedEndpoint[] = [];

for (const relFile of SCAN_FILES) {
  const abs = path.join(MS_DIR, relFile);
  const fileText = stripComments(fs.readFileSync(abs, 'utf8'));
  const ctx: Ctx = { fileText };
  for (const site of findCallSites(relFile, fileText)) {
    const passthroughReason = KNOWN_DYNAMIC_PASSTHROUGH[site.endpointExprText.trim()];
    if (passthroughReason) continue; // acknowledged above; not a new endpoint
    const exp = resolveExpr(site.endpointExprText, ctx, site.index);
    if (exp.unresolved.length > 0) {
      for (const u of exp.unresolved) {
        errors.push(`${relFile} (near offset ${site.index}, call \`${site.endpointExprText.slice(0, 60)}\`): ${u}`);
      }
      continue;
    }
    for (const raw of exp.strings) {
      const shape = normalizeExpanded(raw);
      if (shape === null) continue; // not a Graph URL (e.g. a non-Graph fetch)
      resolved.push({ file: relFile, kind: site.kind, verb: site.verb, shape, sourceHint: site.endpointExprText.slice(0, 60) });
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ── THE MAPPING TABLE — the reviewable artifact ──
// Ordered most-specific-first; first match wins. Each row cites the
// permission Microsoft Graph's own API reference page names for that
// resource/action (see learn.microsoft.com/graph/permissions-reference).
// ════════════════════════════════════════════════════════════════════════════
interface Rule { label: string; test: (shape: string, e: ResolvedEndpoint) => boolean; scopes: string[]; cite: string; }

const RULES: Rule[] = [
  // ── Calendar-sharing accept rides a /messages/{id}/... action, but Graph
  // docs list its permission as Calendars.ReadWrite, not a Mail permission —
  // an exception that must be checked before the generic me/messages rule.
  {
    label: 'accept a calendarSharingMessage',
    test: s => /^me\/messages\/\*\/microsoft\.graph\.calendarSharingMessage\/accept$/.test(s),
    scopes: ['Calendars.ReadWrite'],
    cite: 'Graph docs, calendarSharingMessage: accept action — permission Calendars.ReadWrite',
  },
  // ── Mail SEND actions (Mail.Send) vs mail DRAFT/CRUD (Mail.ReadWrite). ──
  { label: 'sendMail', test: s => s === 'me/sendMail', scopes: ['Mail.Send'], cite: 'Graph docs, user: sendMail — permission Mail.Send' },
  { label: 'message: reply', test: s => /^me\/messages\/\*\/reply$/.test(s), scopes: ['Mail.Send'], cite: 'Graph docs, message: reply — permission Mail.Send' },
  { label: 'message: replyAll', test: s => /^me\/messages\/\*\/replyAll$/.test(s), scopes: ['Mail.Send'], cite: 'Graph docs, message: replyAll — permission Mail.Send' },
  { label: 'message: forward', test: s => /^me\/messages\/\*\/forward$/.test(s), scopes: ['Mail.Send'], cite: 'Graph docs, message: forward — permission Mail.Send' },
  // createReply/createReplyAll build a DRAFT reply (outlook_draft) and never
  // send — Graph docs list Mail.ReadWrite for these, not Mail.Send.
  { label: 'message: createReply', test: s => /^me\/messages\/\*\/createReply$/.test(s), scopes: ['Mail.ReadWrite'], cite: 'Graph docs, message: createReply — permission Mail.ReadWrite' },
  { label: 'message: createReplyAll', test: s => /^me\/messages\/\*\/createReplyAll$/.test(s), scopes: ['Mail.ReadWrite'], cite: 'Graph docs, message: createReplyAll — permission Mail.ReadWrite' },
  // Generic mail CRUD: messages, drafts, attachments, move, categories, mail
  // folders (list/create/child folders/sent-items re-fetch).
  { label: 'mail messages/folders CRUD', test: s => /^me\/(messages|mailFolders)(\/|$)/.test(s), scopes: ['Mail.ReadWrite'], cite: 'Graph docs, message / mailFolder resources — permission Mail.ReadWrite' },

  // ── Calendar family. calendarPrefix() can resolve to me/, users/{email}/
  // calendar/, or me/calendars/{id}/ depending on the runtime calendar_id —
  // both scopes must be present to cover every branch it can take. ──
  {
    label: 'calendar (own + delegate/shared)',
    test: s => s.startsWith('@@CAL@@') || /^me\/calendars(\/|$)/.test(s) || /^me\/events(\/|$)/.test(s) || s === 'me/calendar/getSchedule' || /^users\/\*\/calendar/.test(s),
    scopes: ['Calendars.ReadWrite', 'Calendars.ReadWrite.Shared'],
    cite: 'Graph docs, event/calendar resources + getSchedule — permission Calendars.ReadWrite; delegate access via users/{id}/calendar — permission Calendars.ReadWrite.Shared',
  },

  // ── Files/OneDrive family. drivePrefix() resolves to me/drive/ (own) or
  // drives/{id}/ (a shared drive or SharePoint library) — both scopes must be
  // present. shares/{id}/driveItem resolves a Teams SharePoint-backed
  // attachment link and needs the same file-read capability. ──
  {
    label: 'OneDrive/Files (own + shared/SharePoint-backed)',
    test: s => s.startsWith('@@DRV@@') || /^me\/drives?(\/|$)/.test(s) || /^drives\//.test(s) || /^shares\//.test(s),
    scopes: ['Files.ReadWrite', 'Files.ReadWrite.All'],
    cite: 'Graph docs, driveItem resource (own drive) — permission Files.ReadWrite; drives/{id} (shared drive/library) and shares/{id} — permission Files.ReadWrite.All',
  },
  { label: 'SharePoint sites', test: s => /^sites(\/|$)/.test(s), scopes: ['Sites.ReadWrite.All'], cite: 'Graph docs, site resource / site: search — permission Sites.ReadWrite.All' },

  // ── Teams: the exact incident. Team-level and channel-level LIST calls are
  // Team.ReadBasic.All / Channel.ReadBasic.All; channel MESSAGES split by
  // verb into a read scope and a send scope. ──
  { label: 'joinedTeams', test: s => s === 'me/joinedTeams', scopes: ['Team.ReadBasic.All'], cite: 'Graph docs, user: list joinedTeams — permission Team.ReadBasic.All' },
  { label: 'team channels list', test: s => /^teams\/\*\/channels$/.test(s), scopes: ['Channel.ReadBasic.All'], cite: 'Graph docs, team: list channels — permission Channel.ReadBasic.All' },
  {
    label: 'channel messages (read)',
    test: (s, e) => /^teams\/\*\/channels\/\*\/messages$/.test(s) && e.kind === 'read',
    scopes: ['ChannelMessage.Read.All'],
    cite: 'Graph docs, channel: list messages — permission ChannelMessage.Read.All',
  },
  {
    label: 'channel messages (send)',
    test: (s, e) => /^teams\/\*\/channels\/\*\/messages$/.test(s) && e.kind === 'write',
    scopes: ['ChannelMessage.Send'],
    cite: 'Graph docs, chatMessage: send in a channel — permission ChannelMessage.Send',
  },

  // ── Chats (1:1 / group), online meetings, tasks, contacts, OneNote — one
  // Graph permission each covers the whole resource, read and write alike. ──
  { label: 'chats (1:1 / group)', test: s => /^(me\/)?chats(\/|$)/.test(s), scopes: ['Chat.ReadWrite'], cite: 'Graph docs, chat/chatMessage resources — permission Chat.ReadWrite' },
  { label: 'me', test: s => s === 'me', scopes: ['User.Read'], cite: 'Graph docs, user: get (/me) — permission User.Read' },
  { label: 'onlineMeetings', test: s => /^me\/onlineMeetings(\/|$)/.test(s), scopes: ['OnlineMeetings.ReadWrite'], cite: 'Graph docs, onlineMeeting resource — permission OnlineMeetings.ReadWrite' },
  { label: 'Microsoft To Do (tasks)', test: s => /^me\/todo\/lists(\/|$)/.test(s), scopes: ['Tasks.ReadWrite'], cite: 'Graph docs, todoTaskList/todoTask resources — permission Tasks.ReadWrite' },
  { label: 'contacts', test: s => /^me\/contacts(\/|$)/.test(s), scopes: ['Contacts.ReadWrite'], cite: 'Graph docs, contact resource — permission Contacts.ReadWrite' },
  { label: 'OneNote', test: s => /^me\/onenote(\/|$)/.test(s), scopes: ['Notes.ReadWrite'], cite: 'Graph docs, onenoteNotebook/onenoteSection/onenotePage resources — permission Notes.ReadWrite' },
];

const SCOPES_MODULE = fs.readFileSync(path.join(MS_DIR, 'auth.ts'), 'utf8');
function extractScopes(): string[] {
  const m = SCOPES_MODULE.match(/const SCOPES = \[([\s\S]*?)\]\.join\(' '\)/);
  if (!m) throw new Error('could not find the SCOPES array in auth.ts — has it been renamed/restructured?');
  const body = m[1];
  const strRe = /'([^']+)'/g;
  const out: string[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = strRe.exec(body))) out.push(mm[1]);
  return out;
}
const SCOPES = extractScopes();
const SCOPE_SET = new Set(SCOPES);

describe('the sign-in scopes cover every Graph call — extraction sanity', () => {
  it('scanned files and found call sites (scanner is not silently broken)', () => {
    expect(resolved.length).toBeGreaterThan(60);
  });

  it('extraction hit no unresolvable call-site arguments (structural failures only — see resolveIdentifier for value-parameter wildcarding)', () => {
    expect(errors, errors.join('\n')).toEqual([]);
  });

  // Every function-PARAMETER identifier this run wildcarded (maxResults, days,
  // action, ...) should be a plain lowerCamel value name — never something
  // path-shaped like `endpoint` or `url`, which WOULD indicate a genuine
  // resolver gap (those names are supposed to resolve via findAssignmentsBefore,
  // not fall through here). Guards the wildcard fallback from quietly
  // swallowing a real miss.
  it('every wildcarded parameter identifier is a plain value name, not an endpoint-shaped one', () => {
    const suspicious = [...UNRESOLVED_IDENTIFIERS].filter(n => /endpoint|url|path|uri/i.test(n));
    expect(suspicious, `looks endpoint-shaped but had no traceable assignment: ${suspicious.join(', ')}`).toEqual([]);
  });

  // Positive canary: the scanner must actually FIND the exact endpoints this
  // incident was about, not merely "find something". A scanner that silently
  // stopped matching msGraphRead/msGraphWrite calls would still pass the
  // ">60 shapes" count check below by other means; this pins the specific
  // shapes.
  it('found the exact endpoints the incident was about', () => {
    const shapes = new Set(resolved.map(e => e.shape));
    for (const expectedShape of [
      'me/joinedTeams',
      'teams/*/channels',
      'teams/*/channels/*/messages',
      'me/sendMail',
      'me/messages/*/reply',
      'me/todo/lists',
      'me/onenote/notebooks',
      'me/contacts',
    ]) {
      expect(shapes.has(expectedShape), `expected shape '${expectedShape}' was not extracted — scanner regression?`).toBe(true);
    }
  });

  it('SCOPES was actually parsed out of auth.ts (guard against a rename)', () => {
    expect(SCOPES.length).toBeGreaterThan(10);
    expect(SCOPES).toContain('User.Read');
  });

  // Pins the assumption classifyInterpolation hardcodes for calendarPrefix()/
  // drivePrefix(): if client.ts's actual shapes ever change, this fails too,
  // so the mapping table above gets reviewed instead of silently going stale.
  it('client.ts still returns the prefix shapes this scanner assumes', () => {
    const clientSrc = fs.readFileSync(CLIENT_TS, 'utf8');
    expect(clientSrc).toContain("if (!calendarId) return 'me/';");
    expect(clientSrc).toContain('return `users/${encodeURIComponent(calendarId)}/calendar/`;');
    expect(clientSrc).toContain('return `me/calendars/${encodeURIComponent(calendarId)}/`;');
    expect(clientSrc).toContain("if (!driveId) return 'me/drive/';");
    expect(clientSrc).toContain('return `drives/${encodeURIComponent(driveId)}/`;');
  });
});

describe('the sign-in scopes cover every Graph call — mapping + fail-closed', () => {
  const unmatched: string[] = [];
  const requiredScopes = new Set<string>();
  const perEndpointRequirement = new Map<string, string[]>();

  for (const e of resolved) {
    const rule = RULES.find(r => r.test(e.shape, e));
    if (!rule) {
      unmatched.push(`${e.file}: shape '${e.shape}' (from \`${e.sourceHint}\`, ${e.kind}${e.verb ? ' ' + e.verb : ''}) matches no row in the mapping table`);
      continue;
    }
    for (const sc of rule.scopes) requiredScopes.add(sc);
    perEndpointRequirement.set(e.shape, rule.scopes);
  }

  it('every extracted endpoint shape matches a row in the mapping table (fail-closed on unknown endpoints)', () => {
    expect(unmatched, unmatched.join('\n')).toEqual([]);
  });

  it('at least one endpoint required each of the four Teams scopes this incident was about', () => {
    expect(requiredScopes.has('Team.ReadBasic.All')).toBe(true);
    expect(requiredScopes.has('Channel.ReadBasic.All')).toBe(true);
    expect(requiredScopes.has('ChannelMessage.Read.All')).toBe(true);
    expect(requiredScopes.has('ChannelMessage.Send')).toBe(true);
  });

  it('every scope required by a real Graph call is present in SCOPES', () => {
    const missing = [...requiredScopes].filter(s => !SCOPE_SET.has(s)).sort();
    expect(
      missing,
      `\nSCOPES is missing permission(s) that the tool surface actually calls: ${missing.join(', ')}\n` +
      `Add each to the SCOPES array in microsoft/auth.ts. See the mapping table in this file for ` +
      `which endpoint(s) need it and the Graph docs citation.`,
    ).toEqual([]);
  });

  // Anti-omission twin of the tool-list-conformance house precedent: pins that
  // no mapping ROW has silently gone dead (every scope it grants is actually
  // needed by at least one real call, and none of the four Teams scopes was
  // added to SCOPES speculatively beyond what the endpoints require).
  it('every scope in SCOPES this table cares about is required by at least one real endpoint (no speculative grants among the Graph-resource scopes)', () => {
    // openid/offline_access are OIDC plumbing, not Graph resource permissions —
    // this table has no opinion on them.
    const OIDC_EXEMPT = new Set(['openid', 'offline_access']);
    const tableScopes = new Set(RULES.flatMap(r => r.scopes));
    const speculative = SCOPES.filter(s => !OIDC_EXEMPT.has(s) && tableScopes.has(s) && !requiredScopes.has(s));
    expect(speculative, `scope(s) requested but no extracted endpoint needs them: ${speculative.join(', ')}`).toEqual([]);
  });
});
