// FIELD FAILURE 2, AS A CLASS: owner ruling OR-UPKEEP-AUTOMATIC ("All of this needs to be done automatically"; Repair "never
// tells him to download or restart anything himself"). No text the server or the dashboard can show may send the owner to
// ollama.com, or tell him to download, quit or start Ollama again. The sweep reads every string, template and JSX text in the
// shipped source of both packages from the AST, so a comment that cites ollama.com as a source is not counted.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const PACKAGES = path.resolve(__dirname, '../../../..');
// ("download the latest version" of the Dojo itself, in the Update tab, is the Dojo's own update, not Ollama.)
const CHORE = /ollama\.com|download (?:the latest (?:ollama|from)|ollama)|quit (?:that |the )?ollama|start (?:ollama|that ollama|it) again|restart (?:ollama|it) yourself|brew upgrade ollama/i;
/** The registry's own refusal, which the Dojo recognises and keeps out of owner text (`ollama-version.ts isVersionRefusal`). */
const NOT_OWNER_TEXT = /^newer version of ollama$/i;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function texts(file: string): string[] {
  const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) out.push(n.text);
    else if (ts.isRegularExpressionLiteral(n)) return;
    n.forEachChild(visit);
  };
  visit(src);
  return out;
}

describe('no owner text asks him to fetch, quit or restart Ollama', () => {
  it('server and dashboard source: every hit is listed here (none)', () => {
    const hits = ['server/src', 'dashboard/src'].flatMap((d) => sources(path.join(PACKAGES, d)))
      .flatMap((f) => texts(f).filter((t) => CHORE.test(t) && !NOT_OWNER_TEXT.test(t)).map((t) => `${path.relative(PACKAGES, f)}: ${t.trim().slice(0, 120)}`));
    expect(hits).toEqual([]);
  });
});
