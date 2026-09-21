// ════════════════════════════════════════════════════════════════════════════
// THE SIGN-IN SCOPES ARE DERIVED FROM THE CALLS, NOT VIBES (t83, Google side)
//
// Twin of microsoft/__tests__/the-signin-scopes-cover-every-graph-call.test.ts,
// built for the sibling incident class ("a portal/consent screen configured to
// mirror the code's scope list can never catch a gap between the two"). Same
// structure:
//   (a) STATICALLY EXTRACT every Google API endpoint the production code can
//       call — a small source-level parser over the real call sites
//       (googleRead / googleWrite / googleSilentFetch / a raw fetch()), not a
//       hand list of endpoint strings.
//   (b) Map each endpoint's normalized shape to its required OAuth scope(s)
//       via the explicit, commented MAPPING table below — each row cites the
//       Google API scope its docs page names.
//   (c) Assert every required scope is a member of SCOPES.
//   (d) FAIL CLOSED: an endpoint matching no row is a test FAILURE, not a
//       silent pass.
//
// This file is a SEPARATE file rather than one shared engine with the
// Microsoft twin because the two providers' call shapes genuinely differ in
// ways that would make a forced-shared abstraction the more complex option:
// Microsoft's tools route every relative path through TWO prefix-generating
// helpers (calendarPrefix/drivePrefix) whose resolvable shapes are baked into
// the scanner; Google's tools instead use a dozen flat per-file `const
// X_BASE = 'https://...'` domain constants and (once, for a Slides thumbnail
// URL) string concatenation instead of template interpolation. Sharing the
// low-level bracket/string skippers would save ~60 lines at the cost of a
// cross-provider import into two independently-evolving conformance gates;
// the house precedent (tool-list-conformance.test.ts) keeps its own scan
// self-contained for the same reason (see its header on the circular-import
// trap) rather than factoring a shared scanner module.
//
// FINDING (2026-09-20): no scope gap exists on the Google side today. The
// coordinator's lead ("Google Tasks tools ship without a tasks scope") does
// not hold — there is no Google Tasks integration in this codebase at all
// (grep for tasks.googleapis.com/tasks/v1/tasklists across the whole google/
// tree returns zero hits; the tasks_list/tasks_create tool family that DOES
// exist is Microsoft To Do, a different provider, already scoped via
// Tasks.ReadWrite in microsoft/auth.ts). This test still ships because
// preventing the NEXT drift (the real deliverable) does not depend on one
// having been found today — see the report for the full correction.
//
// Mutation-proof (2026-09-20): a fake `googleRead('https://tasks.googleapis
// .com/tasks/v1/users/@me/lists', ...)` call was added to tools-read.ts and
// this test failed with "no mapping row matches 'TASKS:/users/@me/lists'" as
// expected, then the line was removed.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOOGLE_DIR = path.resolve(HERE, '..');

// client.ts is EXCLUDED for the same reason as the Microsoft twin: it DEFINES
// googleRead/googleWrite/googleSilentFetch (its declaration lines would look
// like call sites) and its one internal fetch() takes a fully dynamic `url`
// that is just every call site below, already counted at its real origin.
const SCAN_FILES = ['auth.ts', 'tools-read.ts', 'tools-write.ts', 'tools-forms.ts', 'tools-slides.ts'];

// ════════════════════════════════════════════════════════════════════════════
// ── The same small source-level parser as the Microsoft twin ──
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
  i++;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '`') return i + 1;
    if (s[i] === '$' && s[i + 1] === '{') { i = skipBraces(s, i + 1); continue; }
    i++;
  }
  return i;
}

// See the Microsoft twin for why this exists: a `.replace(/'/g, "''")`-style
// regex literal escaping a quote character would otherwise be misread as a
// string-literal opener by the generic quote handling below, which then
// hunts for the next matching quote and can swallow everything after it.
// Not hit by any current Google-side call site (none of these files build a
// path via quote-escaping regex), kept for parity/defense since both scanners
// share this class of risk.
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

// Google-only addition: the Slides thumbnail URL is built with top-level `+`
// concatenation across four lines rather than one template literal. Splits
// on a top-level `+` (not inside strings/templates/brackets, and not a unary
// +, which never appears at the START of one of our split segments here).
function splitTopLevelConcat(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '`') { i = skipTemplateLiteral(expr, i); continue; }
    if (c === '\'' || c === '"') { i = skipStringLiteral(expr, i); continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; i++; continue; }
    if (depth === 0 && c === '+' && expr[i + 1] !== '+') {
      parts.push(expr.slice(start, i));
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }
  parts.push(expr.slice(start));
  return parts.map(p => p.trim());
}

interface Ctx { fileText: string; }
interface Expansion { strings: string[]; unresolved: string[]; }

function cartesian(prefixes: string[], options: string[]): string[] {
  const out: string[] = [];
  for (const p of prefixes) for (const o of options) out.push(p + o);
  return out;
}

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

function findAssignmentsBefore(fileText: string, ident: string, idx: number): string[] {
  const local = findAssignmentsInRange(fileText, ident, blockStart(fileText, idx), idx);
  if (local.length > 0) return local;
  return findAssignmentsInRange(fileText, ident, 0, idx);
}

const UNRESOLVED_IDENTIFIERS = new Set<string>();

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
  const concatParts = splitTopLevelConcat(expr);
  if (concatParts.length > 1) {
    let acc: Expansion = { strings: [''], unresolved: [] };
    for (const part of concatParts) {
      const p = resolveExpr(part, ctx, nearIndex);
      acc = { strings: cartesian(acc.strings, p.strings.length ? p.strings : ['*']), unresolved: [...acc.unresolved, ...p.unresolved] };
    }
    return acc;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) return resolveIdentifier(expr, ctx, nearIndex);
  // Anything else (a function call, a cast/coalesce, member/computed access)
  // is, at every site in this codebase (verified by hand), a runtime VALUE —
  // never a resource-family path segment. Wildcards rather than fails; the
  // fail-closed guarantee is the outer shape-vs-mapping-table check below.
  return { strings: ['*'], unresolved: [] };
}

function resolveIdentifier(ident: string, ctx: Ctx, nearIndex: number): Expansion {
  const assigns = findAssignmentsBefore(ctx.fileText, ident, nearIndex);
  if (assigns.length === 0) {
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

// ── Call-site discovery ──
interface CallSite { file: string; kind: 'read' | 'write' | 'silent' | 'fetch'; verb?: string; endpointExprText: string; index: number; }

function findCallSites(file: string, fileText: string): CallSite[] {
  const sites: CallSite[] = [];
  const re = /\b(googleRead|googleWrite|googleSilentFetch|fetch)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fileText))) {
    const name = m[1];
    const openIdx = re.lastIndex - 1;
    const afterClose = skipParens(fileText, openIdx);
    const inner = fileText.slice(openIdx + 1, afterClose - 1);
    const args = splitTopLevelArgs(inner);
    if (name === 'googleRead' && args[0] !== undefined) {
      sites.push({ file, kind: 'read', endpointExprText: args[0], index: openIdx });
    } else if (name === 'googleWrite' && args[1] !== undefined) {
      const verbMatch = args[0]?.trim().match(/^['"]([A-Z]+)['"]$/);
      sites.push({ file, kind: 'write', verb: verbMatch?.[1], endpointExprText: args[1], index: openIdx });
    } else if (name === 'googleSilentFetch' && args[1] !== undefined) {
      const verbMatch = args[0]?.trim().match(/^['"]([A-Z]+)['"]$/);
      sites.push({ file, kind: 'silent', verb: verbMatch?.[1], endpointExprText: args[1], index: openIdx });
    } else if (name === 'fetch' && args[0] !== undefined) {
      sites.push({ file, kind: 'fetch', endpointExprText: args[0], index: openIdx });
    }
    re.lastIndex = afterClose;
  }
  return sites;
}

interface ResolvedEndpoint { file: string; kind: CallSite['kind']; verb?: string; shape: string; sourceHint: string; }

// ── Known Google API base URLs → short family tag. Longest/most-specific
// domain+path prefixes first is not required here (verified: none of these
// ten constants is a prefix of another). ──
const KNOWN_BASES: Array<{ base: string; tag: string }> = [
  { base: 'https://gmail.googleapis.com/gmail/v1/users/me', tag: 'GMAIL:' },
  { base: 'https://www.googleapis.com/upload/drive/v3', tag: 'DRIVE:' }, // same family as DRIVE_BASE — multipart upload is still a Drive write
  { base: 'https://www.googleapis.com/drive/v3', tag: 'DRIVE:' },
  { base: 'https://www.googleapis.com/calendar/v3', tag: 'CALENDAR:' },
  { base: 'https://docs.googleapis.com/v1/documents', tag: 'DOCS:' },
  { base: 'https://sheets.googleapis.com/v4/spreadsheets', tag: 'SHEETS:' },
  { base: 'https://slides.googleapis.com/v1/presentations', tag: 'SLIDES:' },
  { base: 'https://forms.googleapis.com/v1/forms', tag: 'FORMS:' },
  { base: 'https://www.googleapis.com/oauth2/v3/tokeninfo', tag: 'TOKENINFO:' },
  { base: 'https://www.googleapis.com/oauth2/v2/userinfo', tag: 'USERINFO:' },
];

// Absolute URLs that are OAuth-FLOW plumbing, not resource APIs a scope
// gates: the Google authorize endpoint and DOJO's own token-exchange broker.
// Out of scope for a Graph-call-vs-scope mapping by construction.
const OOB_URL_PREFIXES = ['https://accounts.google.com/', 'https://googleconnect.theagentdojo.com/'];

function normalizeExpanded(raw: string): string | null {
  for (const { base, tag } of KNOWN_BASES) {
    if (raw.startsWith(base)) {
      const rest = raw.slice(base.length).split('?')[0];
      return tag + rest;
    }
  }
  if (OOB_URL_PREFIXES.some(p => raw.startsWith(p))) return null;
  // An absolute URL matching none of the ten known API bases and none of the
  // named OOB prefixes: keep it AS the shape rather than dropping it, so a
  // brand-new API domain (a real scope gap, not covered by any path-shape
  // rule below either) fails the mapping-table check instead of vanishing —
  // a blanket "any other https:// URL is fine" here is exactly how a new
  // domain would go undetected (caught in review by a mutation probe on
  // tasks.googleapis.com, an entirely different host, that this replaced).
  if (/^https?:\/\//.test(raw)) return raw;
  return null; // a bare relative fragment on its own is never a real call-site arg in these files
}

const KNOWN_DYNAMIC_PASSTHROUGH: Record<string, string> = {
  // (none identified on the Google side — kept as an explicit empty ledger,
  // matching the Microsoft twin's shape, so a future addition has an obvious
  // place to go with its justification.)
};

const resolved: ResolvedEndpoint[] = [];
const errors: string[] = [];

for (const relFile of SCAN_FILES) {
  const abs = path.join(GOOGLE_DIR, relFile);
  const fileText = stripComments(fs.readFileSync(abs, 'utf8'));
  const ctx: Ctx = { fileText };
  for (const site of findCallSites(relFile, fileText)) {
    const passthroughReason = KNOWN_DYNAMIC_PASSTHROUGH[site.endpointExprText.trim()];
    if (passthroughReason) continue;
    const exp = resolveExpr(site.endpointExprText, ctx, site.index);
    if (exp.unresolved.length > 0) {
      for (const u of exp.unresolved) errors.push(`${relFile} (near offset ${site.index}, call \`${site.endpointExprText.slice(0, 60)}\`): ${u}`);
      continue;
    }
    for (const raw of exp.strings) {
      const shape = normalizeExpanded(raw);
      if (shape === null) continue;
      resolved.push({ file: relFile, kind: site.kind, verb: site.verb, shape, sourceHint: site.endpointExprText.slice(0, 60) });
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ── THE MAPPING TABLE — the reviewable artifact ──
// Ordered most-specific-first. Each row cites the scope Google's own API
// reference names for that method (see developers.google.com/gmail/api/auth/
// scopes, /calendar/api/auth, /drive/api/guides/api-specific-auth,
// /docs/api/limits, /sheets/api/scopes, /slides/api/limits,
// /forms/api/limits).
// ════════════════════════════════════════════════════════════════════════════
interface Rule { label: string; test: (shape: string, e: ResolvedEndpoint) => boolean; scopes: string[]; cite: string; }

const RULES: Rule[] = [
  // ── Gmail: four distinct scopes granted, split by method. ──
  { label: 'gmail: send message', test: s => s === 'GMAIL:/messages/send', scopes: ['https://www.googleapis.com/auth/gmail.send'], cite: 'Gmail API scopes reference, users.messages.send — gmail.send (or gmail.compose/full)' },
  { label: 'gmail: create/manage draft', test: s => /^GMAIL:\/drafts/.test(s), scopes: ['https://www.googleapis.com/auth/gmail.compose'], cite: 'Gmail API scopes reference, users.drafts.create — gmail.compose (or full)' },
  { label: 'gmail: modify message (labels/mark read)', test: s => /^GMAIL:\/messages\/\*\/modify$/.test(s), scopes: ['https://www.googleapis.com/auth/gmail.modify'], cite: 'Gmail API scopes reference, users.messages.modify — gmail.modify (or full)' },
  { label: 'gmail: labels (write)', test: (s, e) => /^GMAIL:\/labels/.test(s) && e.kind === 'write', scopes: ['https://www.googleapis.com/auth/gmail.modify'], cite: 'Gmail API scopes reference, users.labels.create/delete — gmail.modify or gmail.labels (only modify is granted)' },
  { label: 'gmail: read (messages/labels list/get/attachments)', test: s => s.startsWith('GMAIL:'), scopes: ['https://www.googleapis.com/auth/gmail.readonly'], cite: 'Gmail API scopes reference, users.messages.list/get, users.messages.attachments.get, users.labels.list — gmail.readonly (or modify/full)' },

  // ── Calendar: one full-access scope covers every method. ──
  { label: 'calendar (all methods)', test: s => s.startsWith('CALENDAR:'), scopes: ['https://www.googleapis.com/auth/calendar'], cite: 'Calendar API auth guide — the non-readonly `calendar` scope covers all calendars/events/freeBusy/calendarList methods' },

  // ── Drive: one full-access scope covers both the metadata API and the
  // upload endpoint (files.create/get/update/delete/permissions/revisions). ──
  { label: 'drive (all methods, incl. multipart upload)', test: s => s.startsWith('DRIVE:'), scopes: ['https://www.googleapis.com/auth/drive'], cite: 'Drive API OAuth scopes — the non-readonly `drive` scope covers files/permissions/revisions read+write and the /upload endpoint' },

  { label: 'docs (all methods)', test: s => s.startsWith('DOCS:'), scopes: ['https://www.googleapis.com/auth/documents'], cite: 'Docs API OAuth scopes — `documents` covers get + batchUpdate' },
  { label: 'sheets (all methods)', test: s => s.startsWith('SHEETS:'), scopes: ['https://www.googleapis.com/auth/spreadsheets'], cite: 'Sheets API OAuth scopes — `spreadsheets` covers values get/update/append and batchUpdate' },
  { label: 'slides (all methods)', test: s => s.startsWith('SLIDES:'), scopes: ['https://www.googleapis.com/auth/presentations'], cite: 'Slides API OAuth scopes — `presentations` covers create/get/batchUpdate/thumbnail' },

  // ── Forms: two scopes, split by resource. ──
  { label: 'forms: responses (read)', test: s => /^FORMS:\/[^/]+\/responses/.test(s), scopes: ['https://www.googleapis.com/auth/forms.responses.readonly'], cite: 'Forms API OAuth scopes, forms.responses.list/get — forms.responses.readonly' },
  { label: 'forms: form CRUD (create/get/batchUpdate)', test: s => s.startsWith('FORMS:'), scopes: ['https://www.googleapis.com/auth/forms.body'], cite: 'Forms API OAuth scopes, forms.create/get/batchUpdate — forms.body' },

  // ── OAuth identity plumbing (bypasses the client.ts wrapper by design —
  // see that module's header). Not a resource scope in the Drive/Gmail sense,
  // but the identity claim these two endpoints exist to read. ──
  { label: 'oauth: tokeninfo/userinfo (identity)', test: s => s.startsWith('TOKENINFO:') || s.startsWith('USERINFO:'), scopes: ['email'], cite: 'Google OAuth2 userinfo/tokeninfo endpoints resolve the email claim — requires the `email` scope granted at consent' },
];

const AUTH_MODULE = fs.readFileSync(path.join(GOOGLE_DIR, 'auth.ts'), 'utf8');
function extractScopes(): string[] {
  const m = AUTH_MODULE.match(/const SCOPES = \[([\s\S]*?)\]\.join\(' '\)/);
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

describe('the sign-in scopes cover every Google call — extraction sanity', () => {
  it('scanned files and found call sites (scanner is not silently broken)', () => {
    expect(resolved.length).toBeGreaterThan(50);
  });

  it('extraction hit no unresolvable call-site arguments (structural failures only)', () => {
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('every wildcarded parameter identifier is a plain value name, not an endpoint-shaped one', () => {
    const suspicious = [...UNRESOLVED_IDENTIFIERS].filter(n => /endpoint|url|path|uri/i.test(n));
    expect(suspicious, `looks endpoint-shaped but had no traceable assignment: ${suspicious.join(', ')}`).toEqual([]);
  });

  it('SCOPES was actually parsed out of auth.ts (guard against a rename)', () => {
    expect(SCOPES.length).toBeGreaterThan(5);
    expect(SCOPES).toContain('openid');
  });

  it('found the exact endpoint families the mapping table depends on', () => {
    const shapes = new Set(resolved.map(e => e.shape));
    const prefixes = ['GMAIL:', 'CALENDAR:', 'DRIVE:', 'DOCS:', 'SHEETS:', 'SLIDES:', 'FORMS:'];
    for (const p of prefixes) {
      expect([...shapes].some(s => s.startsWith(p)), `no extracted shape starts with '${p}' — scanner regression?`).toBe(true);
    }
    expect(shapes.has('GMAIL:/messages/send'), 'gmail send shape missing').toBe(true);
    expect(shapes.has('GMAIL:/drafts'), 'gmail draft-create shape missing').toBe(true);
  });

  it('there is genuinely no Google Tasks or People/Contacts call in this codebase (corrects the initial lead)', () => {
    const offenders = resolved.filter(e => /tasks\.googleapis|people\.googleapis|contacts\.googleapis/i.test(e.shape));
    expect(offenders, JSON.stringify(offenders)).toEqual([]);
    // Cheap direct grep too, independent of the call-site scanner above, so a
    // change to HOW those APIs are called (bypassing googleRead/Write
    // entirely) still gets caught by something.
    for (const relFile of SCAN_FILES) {
      const text = fs.readFileSync(path.join(GOOGLE_DIR, relFile), 'utf8');
      expect(/tasks\.googleapis|people\.googleapis|contacts\.googleapis/i.test(text), `${relFile} now references a Tasks/People API — SCOPES needs a new row`).toBe(false);
    }
  });
});

describe('the sign-in scopes cover every Google call — mapping + fail-closed', () => {
  const unmatched: string[] = [];
  const requiredScopes = new Set<string>();

  for (const e of resolved) {
    const rule = RULES.find(r => r.test(e.shape, e));
    if (!rule) {
      unmatched.push(`${e.file}: shape '${e.shape}' (from \`${e.sourceHint}\`, ${e.kind}${e.verb ? ' ' + e.verb : ''}) matches no row in the mapping table`);
      continue;
    }
    for (const sc of rule.scopes) requiredScopes.add(sc);
  }

  it('every extracted endpoint shape matches a row in the mapping table (fail-closed on unknown endpoints)', () => {
    expect(unmatched, unmatched.join('\n')).toEqual([]);
  });

  it('every scope required by a real Google call is present in SCOPES', () => {
    const missing = [...requiredScopes].filter(s => !SCOPE_SET.has(s)).sort();
    expect(
      missing,
      `\nSCOPES is missing permission(s) that the tool surface actually calls: ${missing.join(', ')}\n` +
      `Add each to the SCOPES array in google/auth.ts. See the mapping table in this file for which ` +
      `endpoint(s) need it and the API docs citation.`,
    ).toEqual([]);
  });

  it('every scope in SCOPES this table cares about is required by at least one real endpoint (no speculative grants)', () => {
    // `openid` is OIDC plumbing this table has no opinion on; `email` is
    // covered by the identity rule above.
    const OIDC_EXEMPT = new Set(['openid']);
    const tableScopes = new Set(RULES.flatMap(r => r.scopes));
    const speculative = SCOPES.filter(s => !OIDC_EXEMPT.has(s) && tableScopes.has(s) && !requiredScopes.has(s));
    expect(speculative, `scope(s) requested but no extracted endpoint needs them: ${speculative.join(', ')}`).toEqual([]);
  });
});
