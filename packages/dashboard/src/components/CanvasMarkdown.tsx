import { Fragment } from 'react';
import { InlineMarkdown, CodeBlock } from './Markdown';

/*
 * Block-level Markdown renderer for the canvas.
 *
 * The chat <Markdown> is deliberately lightweight — inline only (bold, italic,
 * code, links) — because chat messages rarely use document structure. A canvas
 * document does: headings, lists, blockquotes, tables, rules, fenced code. This
 * renderer parses those block structures and delegates inline formatting back
 * to the shared InlineMarkdown, so both surfaces agree on inline behavior. No
 * external markdown dependency.
 */

const HR_RE = /^\s*([-*_])\1{2,}\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

export function CanvasMarkdown({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — skip (block separators are handled per-block).
    if (line.trim() === '') { i++; continue; }

    // Fenced code block.
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i++; }
      if (i < lines.length) i++; // closing fence
      out.push(<CodeBlock key={key++} code={code.join('\n')} language={lang} />);
      continue;
    }

    // Horizontal rule.
    if (HR_RE.test(line)) { out.push(<hr key={key++} />); i++; continue; }

    // Heading.
    const h = line.match(HEADING_RE);
    if (h) {
      const level = h[1].length;
      const Tag = (`h${level}`) as keyof JSX.IntrinsicElements;
      out.push(<Tag key={key++}><InlineMarkdown text={h[2]} /></Tag>);
      i++;
      continue;
    }

    // Table: a row line immediately followed by a separator line.
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2; // header + separator
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      out.push(
        <table key={key++}>
          <thead>
            <tr>{header.map((c, ci) => <th key={ci}><InlineMarkdown text={c} /></th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci}><InlineMarkdown text={c} /></td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // Blockquote (consecutive `>` lines).
    if (QUOTE_RE.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        quote.push(lines[i].match(QUOTE_RE)![1]);
        i++;
      }
      out.push(
        <blockquote key={key++}>
          {quote.map((q, qi) => (
            <Fragment key={qi}>{qi > 0 && <br />}<InlineMarkdown text={q} /></Fragment>
          ))}
        </blockquote>,
      );
      continue;
    }

    // List (unordered or ordered) — consecutive matching item lines.
    const isUl = UL_RE.test(line);
    const isOl = OL_RE.test(line);
    if (isUl || isOl) {
      const re = isUl ? UL_RE : OL_RE;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(lines[i].match(re)![2]);
        i++;
      }
      const ListTag = isUl ? 'ul' : 'ol';
      out.push(
        <ListTag key={key++}>
          {items.map((it, ii) => <li key={ii}><InlineMarkdown text={it} /></li>)}
        </ListTag>,
      );
      continue;
    }

    // Paragraph — gather consecutive plain lines until a blank or a block start.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !HR_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i]) &&
      !TABLE_ROW_RE.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(
      <p key={key++}>
        {para.map((pl, pi) => (
          <Fragment key={pi}>{pi > 0 && <br />}<InlineMarkdown text={pl} /></Fragment>
        ))}
      </p>,
    );
  }

  return <>{out}</>;
}
