import { useState } from 'react';
import { LinkPreview } from './LinkPreview';

/**
 * Lightweight markdown renderer for chat messages.
 * Supports: fenced code blocks, inline code, bold, italic, links with OG previews.
 * No external dependencies.
 */
export const Markdown = ({ content }: { content: string }) => {
  const elements = parseMarkdown(content);
  return <div className="text-sm leading-relaxed break-words">{elements}</div>;
};

// URL detection — split into two parts so we can decide what's clickable vs
// what's also previewable.
//
// Clickable: http(s), ftp(s), sftp, smb, ssh, file (scheme://...) AND
//            mailto:, tel:, sms: (scheme:no-slashes).
// Previewable: only http and https — other schemes don't have OG metadata
//              the og-preview endpoint can fetch.
const SCHEME_WITH_AUTHORITY = '(?:https?|ftps?|sftp|smb|ssh|file):\\/\\/[^\\s<>"\')\\]]+';
const SCHEME_NO_AUTHORITY = '(?:mailto|tel|sms):[^\\s<>"\')\\]]+';
const ANY_URL_RE = new RegExp(`${SCHEME_WITH_AUTHORITY}|${SCHEME_NO_AUTHORITY}`, 'g');
function isPreviewableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
// Cap previews per message — 5 cards is the soft ceiling before the chat
// becomes more cards than text. Dedupes so the same URL doesn't render twice.
const MAX_PREVIEWS_PER_MESSAGE = 5;

// ── Parser ──

function parseMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  // Track which lines are inside fenced code blocks. URLs inside ``` shouldn't
  // get preview cards even though the fenced block itself isn't being parsed
  // for URLs (the CodeBlock just renders raw text).
  const nonCodeText: string[] = [];

  while (i < lines.length) {
    // Fenced code block: ```lang\n...\n```
    if (lines[i].startsWith('```')) {
      const lang = lines[i].slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```

      result.push(
        <CodeBlock key={key++} code={codeLines.join('\n')} language={lang} />,
      );
    } else {
      // Regular line — collect consecutive non-code lines into a paragraph
      const paraLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith('```')) {
        paraLines.push(lines[i]);
        i++;
      }
      nonCodeText.push(paraLines.join('\n'));

      result.push(
        <span key={key++}>
          {paraLines.map((line, li) => (
            <span key={li}>
              {li > 0 && '\n'}
              <InlineMarkdown text={line} />
            </span>
          ))}
        </span>,
      );
    }
  }

  // Engine-driven preview: every previewable URL anywhere in the message
  // (inline or standalone) gets a card, deduped, capped. URLs inside fenced
  // code blocks are intentionally excluded — those are usually example
  // snippets, not real links the user is meant to follow.
  const seen = new Set<string>();
  const previewUrls: string[] = [];
  const haystack = nonCodeText.join('\n');
  for (const match of haystack.matchAll(ANY_URL_RE)) {
    const raw = match[0];
    // Trim trailing punctuation that isn't part of the URL (sentence enders).
    const cleaned = raw.replace(/[.,;:!?]+$/, '');
    if (!isPreviewableUrl(cleaned)) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    previewUrls.push(cleaned);
    if (previewUrls.length >= MAX_PREVIEWS_PER_MESSAGE) break;
  }
  for (const url of previewUrls) {
    result.push(<LinkPreview key={`preview-${key++}`} url={url} />);
  }

  return result;
}

// ── Fenced Code Block ──

const CodeBlock = ({ code, language }: { code: string; language: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="my-2 rounded-lg bg-transparent border border-ui/[0.10] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-ui/[0.05] border-b border-ui/[0.10]">
        <span className="text-xs text-ui/40 font-mono">{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="text-xs text-ui/40 hover:text-ui/70 transition-colors"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="px-3 py-2 text-xs font-mono text-ui/70 overflow-x-auto whitespace-pre">
        {code}
      </pre>
    </div>
  );
};

// ── Inline Markdown (bold, italic, inline code, links) ──

function InlineMarkdown({ text }: { text: string }): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Inline code: `...`
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`/);
    if (codeMatch) {
      if (codeMatch[1]) parts.push(processInline(codeMatch[1], key++));
      parts.push(
        <code
          key={key++}
          className="px-1.5 py-0.5 bg-transparent border border-ui/[0.10] rounded text-xs font-mono text-cp-blue-light"
        >
          {codeMatch[2]}
        </code>,
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // No more inline code — process the rest
    parts.push(processInline(remaining, key++));
    break;
  }

  return <>{parts}</>;
}

// Render a clickable URL anchor. Trailing sentence punctuation is split
// off so "see https://x.com." links to https://x.com and renders the
// period as plain text after.
function renderUrl(url: string, key: number): React.ReactNode[] {
  let href = url;
  let trailing = '';
  const trailMatch = href.match(/[.,;:!?]+$/);
  if (trailMatch) {
    trailing = trailMatch[0];
    href = href.slice(0, href.length - trailing.length);
  }
  const out: React.ReactNode[] = [
    <a key={key} href={href} target="_blank" rel="noopener noreferrer"
      className="text-cp-blue hover:underline break-all">
      {href}
    </a>,
  ];
  if (trailing) out.push(trailing);
  return out;
}

// Render an explicit markdown link [text](url) where the visible text and
// the href can differ. Same trailing-punct rule applied to the href.
function renderMarkdownLink(text: string, url: string, key: number): React.ReactNode {
  let href = url.trim();
  const trailMatch = href.match(/[.,;:!?]+$/);
  if (trailMatch) href = href.slice(0, href.length - trailMatch[0].length);
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer"
      className="text-cp-blue hover:underline break-all">
      {text}
    </a>
  );
}

// Process emphasis (bold, italic), markdown links, angle-bracket links, and
// bare URLs within text. URLs win over bold/italic when they overlap, so
// `**https://x.com**` renders as bold containing a clickable link instead
// of bold containing plain text. The bold/italic content is recursively
// processed for URLs to make this work.
function processInline(text: string, baseKey: number): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = baseKey * 1000;

  // Pre-built regex for bare URLs (any scheme).
  const URL_RE = new RegExp(`^(.*?)(${SCHEME_WITH_AUTHORITY}|${SCHEME_NO_AUTHORITY})`);

  while (remaining.length > 0) {
    // Find the next match of each token type. Order in `candidates`
    // determines precedence on ties (stable sort preserves push order).
    // URL goes first so a URL at the same index as bold/italic wins —
    // but we ALSO recursively process bold/italic content for URLs, so
    // `**https://x.com**` still renders the bold tag *with* a clickable
    // link inside.
    const mdLinkMatch = remaining.match(
      // [text](url) — text is anything but ], url is anything but ).
      /^(.*?)\[([^\]]+)\]\((https?:\/\/[^\s)]+|(?:ftps?|sftp|smb|ssh|file):\/\/[^\s)]+|(?:mailto|tel|sms):[^\s)]+)\)/,
    );
    const angleMatch = remaining.match(
      // <url> — bare URL wrapped in angle brackets, often emitted by LLMs
      // when they want to "protect" a link from formatting.
      new RegExp(`^(.*?)<(${SCHEME_WITH_AUTHORITY}|${SCHEME_NO_AUTHORITY})>`),
    );
    const urlMatch = remaining.match(URL_RE);
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*/);
    const italicMatch = remaining.match(/^(.*?)\*(.+?)\*/);

    const candidates: Array<{ type: string; index: number; match: RegExpMatchArray }> = [];
    // Order matters for ties: explicit link forms first, then bare URL,
    // then formatting wrappers.
    if (mdLinkMatch) candidates.push({ type: 'mdlink', index: mdLinkMatch[1].length, match: mdLinkMatch });
    if (angleMatch) candidates.push({ type: 'angle', index: angleMatch[1].length, match: angleMatch });
    if (urlMatch) candidates.push({ type: 'url', index: urlMatch[1].length, match: urlMatch });
    if (boldMatch) candidates.push({ type: 'bold', index: boldMatch[1].length, match: boldMatch });
    if (italicMatch) candidates.push({ type: 'italic', index: italicMatch[1].length, match: italicMatch });

    if (candidates.length === 0) {
      parts.push(remaining);
      break;
    }

    candidates.sort((a, b) => a.index - b.index);
    const winner = candidates[0];

    if (winner.type === 'mdlink') {
      const m = winner.match;
      if (m[1]) parts.push(m[1]);
      parts.push(renderMarkdownLink(m[2], m[3], key++));
      remaining = remaining.slice(m[0].length);
    } else if (winner.type === 'angle') {
      const m = winner.match;
      if (m[1]) parts.push(m[1]);
      parts.push(...renderUrl(m[2], key++));
      remaining = remaining.slice(m[0].length);
    } else if (winner.type === 'url') {
      const m = winner.match;
      if (m[1]) parts.push(m[1]);
      parts.push(...renderUrl(m[2], key++));
      remaining = remaining.slice(m[0].length);
    } else if (winner.type === 'bold') {
      const m = winner.match;
      if (m[1]) parts.push(m[1]);
      parts.push(
        <strong key={key++} className="font-semibold text-ui">
          {processInline(m[2], baseKey * 100 + key)}
        </strong>,
      );
      remaining = remaining.slice(m[0].length);
    } else if (winner.type === 'italic') {
      const m = winner.match;
      if (m[1]) parts.push(m[1]);
      parts.push(
        <em key={key++} className="italic">
          {processInline(m[2], baseKey * 100 + key)}
        </em>,
      );
      remaining = remaining.slice(m[0].length);
    }
  }

  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : <span key={baseKey}>{parts}</span>;
}
