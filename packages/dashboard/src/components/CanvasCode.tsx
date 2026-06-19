import { Fragment, useMemo } from 'react';

/*
 * Lightweight, dependency-free syntax highlighter for the canvas (code files,
 * pretty-printed JSON, and the HTML "Code" tab). In the spirit of the custom
 * Markdown renderer, this avoids pulling in a heavyweight highlighter: it
 * tokenises the surface grammar (comments, strings, numbers, keywords; JSON
 * keys; markup tags/attributes) well enough for a clean preview, with full
 * control over the token colours so they sit on the dojo's warm palette.
 */

type Tok = { c: string | null; s: string };

const KEYWORDS = new Set([
  'abstract', 'and', 'as', 'async', 'await', 'bool', 'boolean', 'break', 'case', 'catch',
  'char', 'class', 'const', 'continue', 'def', 'default', 'del', 'delete', 'do', 'double',
  'elif', 'else', 'enum', 'export', 'extends', 'final', 'finally', 'float', 'fn', 'for',
  'from', 'func', 'function', 'global', 'go', 'if', 'impl', 'implements', 'import', 'in',
  'instanceof', 'int', 'interface', 'is', 'lambda', 'let', 'match', 'mod', 'module', 'mut',
  'namespace', 'new', 'not', 'or', 'package', 'pass', 'private', 'protected', 'pub', 'public',
  'raise', 'return', 'self', 'static', 'struct', 'super', 'switch', 'this', 'throw', 'throws',
  'trait', 'try', 'type', 'typeof', 'union', 'unless', 'until', 'use', 'var', 'void', 'when',
  'where', 'while', 'with', 'yield',
]);
const LITERALS = new Set(['true', 'false', 'null', 'none', 'nil', 'undefined', 'None', 'True', 'False', 'NaN', 'Infinity']);

const HASH_LANG = /^(py|python|rb|ruby|sh|bash|zsh|yaml|yml|toml|ini|env|r|pl|perl|makefile|dockerfile|conf|cfg)$/;
const DASH_LANG = /^(sql|lua|hs|haskell|elm)$/;
const MARKUP_EXT = new Set(['html', 'htm', 'xml', 'svg', 'xhtml', 'vue', 'svelte']);

function commentPattern(lang: string): string {
  if (HASH_LANG.test(lang)) return '#[^\\n]*';
  if (DASH_LANG.test(lang)) return '--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
  return '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
}

function tokenizeGeneric(code: string, lang: string): Tok[] {
  const re = new RegExp(
    `(${commentPattern(lang)})|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(\\b\\d[\\w.]*\\b)|([A-Za-z_$][\\w$]*)`,
    'g',
  );
  const out: Tok[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push({ c: null, s: code.slice(last, m.index) });
    if (m[1] != null) out.push({ c: 'com', s: m[1] });
    else if (m[2] != null) out.push({ c: 'str', s: m[2] });
    else if (m[3] != null) out.push({ c: 'num', s: m[3] });
    else if (m[4] != null) out.push({ c: LITERALS.has(m[4]) ? 'lit' : KEYWORDS.has(m[4]) ? 'kw' : null, s: m[4] });
    last = re.lastIndex;
  }
  if (last < code.length) out.push({ c: null, s: code.slice(last) });
  return out;
}

function tokenizeJson(code: string): Tok[] {
  const re = /("(?:\\.|[^"\\])*"(?=\s*:))|("(?:\\.|[^"\\])*")|(\b(?:true|false|null)\b)|(-?\b\d[\d.eE+-]*\b)/g;
  const out: Tok[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push({ c: null, s: code.slice(last, m.index) });
    if (m[1] != null) out.push({ c: 'key', s: m[1] });
    else if (m[2] != null) out.push({ c: 'str', s: m[2] });
    else if (m[3] != null) out.push({ c: 'lit', s: m[3] });
    else if (m[4] != null) out.push({ c: 'num', s: m[4] });
    last = re.lastIndex;
  }
  if (last < code.length) out.push({ c: null, s: code.slice(last) });
  return out;
}

function tokenizeAttrs(attrs: string, out: Tok[]): void {
  const re = /([A-Za-z_:][\w:.-]*)|("(?:[^"]*)"|'(?:[^']*)')/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs))) {
    if (m.index > last) out.push({ c: null, s: attrs.slice(last, m.index) });
    if (m[1] != null) out.push({ c: 'attr', s: m[1] });
    else if (m[2] != null) out.push({ c: 'str', s: m[2] });
    last = re.lastIndex;
  }
  if (last < attrs.length) out.push({ c: null, s: attrs.slice(last) });
}

function tokenizeMarkup(code: string): Tok[] {
  const re = /(<!--[\s\S]*?-->)|(<\/?)([A-Za-z][\w-]*)([^>]*?)(\/?>)/g;
  const out: Tok[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push({ c: null, s: code.slice(last, m.index) });
    if (m[1] != null) {
      out.push({ c: 'com', s: m[1] });
    } else {
      out.push({ c: 'punc', s: m[2] });
      out.push({ c: 'tag', s: m[3] });
      if (m[4]) tokenizeAttrs(m[4], out);
      out.push({ c: 'punc', s: m[5] });
    }
    last = re.lastIndex;
  }
  if (last < code.length) out.push({ c: null, s: code.slice(last) });
  return out;
}

function tokenize(code: string, lang: string): Tok[] {
  try {
    if (lang === 'json') return tokenizeJson(code);
    if (MARKUP_EXT.has(lang)) return tokenizeMarkup(code);
    return tokenizeGeneric(code, lang);
  } catch {
    return [{ c: null, s: code }];
  }
}

/** ext like ".ts" / ".json" / ".html" (or a bare lang) -> normalized lang key. */
function normalizeLang(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase();
}

export function CanvasCode({ content, ext }: { content: string; ext: string }) {
  const lang = normalizeLang(ext);
  const toks = useMemo(() => tokenize(content, lang), [content, lang]);
  return (
    <pre className="dojo3-canvas__code dojo3-canvas__code--hl">
      <code>
        {toks.map((t, i) =>
          t.c ? (
            <span key={i} className={`tok-${t.c}`}>{t.s}</span>
          ) : (
            <Fragment key={i}>{t.s}</Fragment>
          ),
        )}
      </code>
    </pre>
  );
}
