// ════════════════════════════════════════════════════════════════════════════════════════
// NO OWNER-FACING TEXT CARRIES AN EM-DASH (owner, standing: "No em-dashes"; owner test 2 found one on the compaction card).
//
// Read from the AST of the shipped source of both packages (strings, template parts and JSX text), so a comment is never
// counted. WHAT IS OWNER-FACING:
//   - DASHBOARD: every string, template and JSX text, except a `console.*` argument (the browser console is a developer's)
//     and a GLSL shader source (code, not words).
//   - SERVER: the text that reaches the owner through one of its doors:
//       * the arguments of `sendAlert`, `ownerCardFrame`, `ownerCardEnded` (the phone text and the owner cards);
//       * the `error` of a `chat:error` frame (an agent's card in the chat);
//       * the `error` and `message` of a route's JSON answer (`c.json({ ok: false, error })`, shown as the dashboard's toast);
//       * every string in a declaration or function named as owner words (`*_WORDS`, `*Words`, `*CardText`, `*Notice`,
//         `*NOTICE`), the single-sourced card and notice texts;
//       * (audit round, widened) the argument of `dojoVoice`, any text that starts with "Dojo:" or carries the shared
//         "Dojo:" prefix constant (an engine line a person reads), and a same-file variable a chat:error frame's `error`
//         names (`error: userMsg`).
//   Model-facing text (prompts, tool descriptions, steers) and log lines are not owner-facing and are not counted here.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const PACKAGES = path.resolve(__dirname, '../../..');
const EM_DASH = '\u2014';
const SERVER_DOORS = new Set(['sendAlert', 'ownerCardFrame', 'ownerCardEnded', 'dojoVoice']);
const DOJO_PREFIX_NAMES = new Set(['OWNER_ALERT_DOJO_PREFIX', 'DOJO_VOICE_PREFIX']);
const OWNER_WORDS_NAME = /(_WORDS|Words|CardText|Notice|NOTICE)$/;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const isText = (n: ts.Node): n is ts.StringLiteralLike | ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail | ts.JsxText =>
  ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n);

const calleeName = (c: ts.CallExpression): string => {
  const e = c.expression;
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
};
const nameOf = (n: ts.Node): string | null =>
  (ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isPropertyAssignment(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name) ? n.name.text : null;

/** Variables a chat:error frame's `error` names, per file (audit round: `error: userMsg`). */
function chatErrorVariables(src: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n) && n.properties.some((q) => ts.isPropertyAssignment(q) && ts.isIdentifier(q.name) && q.name.text === 'type'
      && ts.isStringLiteralLike(q.initializer) && q.initializer.text === 'chat:error')) {
      for (const q of n.properties) {
        if (ts.isPropertyAssignment(q) && ts.isIdentifier(q.name) && q.name.text === 'error' && ts.isIdentifier(q.initializer)) names.add(q.initializer.text);
        if (ts.isShorthandPropertyAssignment(q) && q.name.text === 'error') names.add('error');
      }
    }
    n.forEachChild(visit);
  };
  visit(src);
  return names;
}

/** Does this text start a "Dojo:" line, as a literal or through the shared prefix constant? */
function dojoLine(n: ts.Node): boolean {
  if (ts.isStringLiteralLike(n) && /^\s*Dojo:/.test(n.text)) return true;
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isTemplateExpression(p)) {
      if (/^\s*Dojo:/.test(p.head.text)) return true;
      if (p.templateSpans.some((sp) => ts.isIdentifier(sp.expression) && DOJO_PREFIX_NAMES.has(sp.expression.text))) return true;
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const first = (e: ts.Expression): ts.Expression => (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken ? first(e.left) : e);
      const head = first(p);
      if (ts.isTemplateExpression(head) && head.templateSpans.some((sp) => ts.isIdentifier(sp.expression) && DOJO_PREFIX_NAMES.has(sp.expression.text))) return true;
      if (ts.isStringLiteralLike(head) && /^\s*Dojo:/.test(head.text)) return true;
    }
  }
  return false;
}

/** Is this text, in the server, on one of the owner's doors (header)? */
function serverOwnerFacing(n: ts.Node, chatErrorVars: ReadonlySet<string> = new Set()): boolean {
  if (dojoLine(n)) return true;
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && chatErrorVars.has(p.name.text)) return true;
    if (ts.isCallExpression(p) && SERVER_DOORS.has(calleeName(p))) return true;
    const name = nameOf(p);
    if (name && OWNER_WORDS_NAME.test(name)) return true;
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && (p.name.text === 'error' || p.name.text === 'message')) {
      const obj = p.parent;
      if (ts.isObjectLiteralExpression(obj)) {
        const chatError = obj.properties.some((q) => ts.isPropertyAssignment(q) && ts.isIdentifier(q.name) && q.name.text === 'type'
          && ts.isStringLiteralLike(q.initializer) && q.initializer.text === 'chat:error');
        const routeAnswer = ts.isCallExpression(obj.parent) && ts.isPropertyAccessExpression(obj.parent.expression) && obj.parent.expression.name.text === 'json';
        if ((chatError && p.name.text === 'error') || routeAnswer) return true;
      }
    }
  }
  return false;
}

/** Is this text, in the dashboard, a developer's (header)? */
function dashboardNotOwnerFacing(n: ts.Node, src: ts.SourceFile): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.expression.expression.getText(src) === 'console') return true;
  }
  return isText(n) && /\b(?:precision\s+highp|gl_FragColor|uniform\s+sampler2D)\b/.test(n.text);
}

export function ownerFacingEmDashes(): string[] {
  const hits: string[] = [];
  for (const pkg of ['server', 'dashboard'] as const) {
    for (const file of sources(path.join(PACKAGES, pkg, 'src'))) {
      const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const vars = pkg === 'server' ? chatErrorVariables(src) : new Set<string>();
      const visit = (n: ts.Node): void => {
        if (ts.isRegularExpressionLiteral(n)) return;
        if (isText(n) && n.text.includes(EM_DASH)
          && (pkg === 'server' ? serverOwnerFacing(n, vars) : !dashboardNotOwnerFacing(n, src))) {
          const { line } = src.getLineAndCharacterOfPosition(n.getStart(src));
          hits.push(`${pkg}/src/${path.relative(path.join(PACKAGES, pkg, 'src'), file)}:${line + 1}: ${n.text.replace(/\s+/g, ' ').trim().slice(0, 100)}`);
        }
        n.forEachChild(visit);
      };
      visit(src);
    }
  }
  return hits;
}

describe('no owner-facing text carries an em-dash', () => {
  it('server doors and dashboard text: every hit is listed here (none)', () => {
    expect(ownerFacingEmDashes()).toEqual([]);
  });

  it('CONTROL: the scanner sees an owner card and a chat:error frame, and skips a log line and a comment', () => {
    const probe = path.join(PACKAGES, 'server', 'src', '__tests__', 'no-owner-text-has-an-em-dash.test.ts');
    const code = [
      `ownerCardFrame('a ${EM_DASH} b', 'warning', undefined, 'action');`,
      `broadcast({ type: 'chat:error', agentId: 'x', error: 'c ${EM_DASH} d' });`,
      `logger.info('e ${EM_DASH} f');`,
      `// g ${EM_DASH} h`,
      `const userMsg = 'i ${EM_DASH} j'; broadcast({ type: 'chat:error', agentId: 'x', error: userMsg });`,
      `const line = \`\${OWNER_ALERT_DOJO_PREFIX} k ${EM_DASH} l\`;`,
    ].join('\n');
    const src = ts.createSourceFile(probe, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const vars = chatErrorVariables(src);
    const seen: string[] = [];
    const visit = (n: ts.Node): void => { if (isText(n) && n.text.includes(EM_DASH) && serverOwnerFacing(n, vars)) seen.push(n.text); n.forEachChild(visit); };
    visit(src);
    expect(seen).toEqual([`a ${EM_DASH} b`, `c ${EM_DASH} d`, `i ${EM_DASH} j`, ` k ${EM_DASH} l`]);
  });
});
