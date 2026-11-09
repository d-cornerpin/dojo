import { useState } from 'react';
import { LinkPreview } from './LinkPreview';
import {
  splitCredentialPlaceholders,
  credentialChipTitle,
  CREDENTIAL_CHIP_LABEL,
} from '../lib/credential-placeholder';
import { copyTextToClipboard } from '../lib/clipboard';

/** Chat markdown: fenced code, inline code, bold, italic, links with OG previews. No deps. */
export const Markdown = ({ content }: { content: string }) => {
  const elements = parseMarkdown(content);
  return <div className="text-sm leading-relaxed break-words">{elements}</div>;
};

// URL detection is split so clickable can be told from previewable.
// Clickable: http(s), ftp(s), sftp, smb, ssh, file (scheme://...) AND mailto:, tel:, sms:.
// Previewable: only http(s); other schemes have no OG metadata the preview endpoint can fetch.
const SCHEME_WITH_AUTHORITY = '(?:https?|ftps?|sftp|smb|ssh|file):\\/\\/[^\\s<>"\')\\]]+';
const SCHEME_NO_AUTHORITY = '(?:mailto|tel|sms):[^\\s<>"\')\\]]+';
const ANY_URL_RE = new RegExp(`${SCHEME_WITH_AUTHORITY}|${SCHEME_NO_AUTHORITY}`, 'g');
function isPreviewableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
// Cap previews per message: 5 cards, before chat becomes more cards than text.
// Deduped so the same URL doesn't render twice.
const MAX_PREVIEWS_PER_MESSAGE = 5;

// ── Parser ──

function parseMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  // URLs inside fenced blocks are example snippets, not links: only non-code text is scanned.
  const nonCodeText: string[] = [];

  while (i < lines.length) {
    // Fenced block: ```lang. `lang === 'source'` (optional /subtype, e.g. `source/transcript`)
    // routes to the word-wrapped SourceBlock; everything else is a normal CodeBlock.
    if (lines[i].startsWith('```')) {
      const lang = lines[i].slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```

      const langLower = lang.toLowerCase();
      const isSource = langLower === 'source' || langLower.startsWith('source/');
      if (isSource) {
        const subtype = langLower.startsWith('source/') ? lang.slice('source/'.length) : null;
        result.push(
          <SourceBlock
            key={key++}
            body={codeLines.join('\n')}
            label={subtype || 'source'}
          />,
        );
      } else {
        result.push(
          <CodeBlock key={key++} code={codeLines.join('\n')} language={lang} />,
        );
      }
    } else {
      // Regular line: collect consecutive non-code lines into a paragraph
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

  // Every previewable URL in non-code text gets a card, deduped and capped; fenced
  // code is excluded on purpose, those are example snippets, not links to follow.
  const seen = new Set<string>();
  const previewUrls: string[] = [];
  const haystack = nonCodeText.join('\n');
  for (const match of haystack.matchAll(ANY_URL_RE)) {
    const raw = match[0];
    // Split first if the capture holds a duplicated scheme, so the preview fetches the
    // FIRST URL alone rather than a concatenation that would 404.
    // Then strip trailing junk (punct, backticks, brackets, quotes) agents smear on.
    const { primary } = splitOnRepeatedScheme(raw);
    const cleaned = primary.replace(HREF_TRAIL_JUNK_RE, '');
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

export const CodeBlock = ({ code, language }: { code: string; language: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void copyTextToClipboard(code).then((ok) => {
      if (!ok) return;
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

// ── Source Block ──
// CodeBlock's shell (header + copy) with the body in the default sans font, word-wrapped:
// content to read, not code, copied as one unit. Agents trigger it with ```source ... ```.
const SourceBlock = ({ body, label }: { body: string; label?: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void copyTextToClipboard(body).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="my-2 rounded-lg bg-transparent border border-ui/[0.10] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-ui/[0.05] border-b border-ui/[0.10]">
        <span className="text-xs text-ui/40">{label || 'source'}</span>
        <button
          onClick={handleCopy}
          className="text-xs text-ui/40 hover:text-ui/70 transition-colors"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <div className="px-3 py-2 text-xs sm:text-sm text-ui/80 whitespace-pre-wrap break-words leading-relaxed">
        {body}
      </div>
    </div>
  );
};

// ── Inline Markdown (bold, italic, inline code, links) ──

export function InlineMarkdown({ text }: { text: string }): React.ReactNode {
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

    // No more inline code: process the rest
    parts.push(processInline(remaining, key++));
    break;
  }

  return <>{parts}</>;
}

// Trailing junk LLMs frequently smear onto a URL that never belongs in an href: sentence
// punctuation; backticks (a closing tick inside the href gets encoded by browsers as %60);
// quote marks; unopened closers ] } > ); a stray backslash from failed escaping.
const HREF_TRAIL_JUNK_RE = /[.,;:!?`"'’”\]\}>)\\]+$/;

// Agents sometimes emit the same URL twice with no space between them; the greedy regex
// would capture the concatenation as one 404 href. Truncate at the second scheme; the
// remainder re-processes as surrounding text, so the duplicate renders as its own link.
function splitOnRepeatedScheme(url: string): { primary: string; rest: string } {
  // Look for "http://" or "https://" AFTER position 8 (past the initial scheme).
  const re = /https?:\/\//g;
  const matches = Array.from(url.matchAll(re));
  if (matches.length <= 1) return { primary: url, rest: '' };
  const secondIdx = matches[1].index ?? -1;
  if (secondIdx <= 8) return { primary: url, rest: '' };
  return { primary: url.slice(0, secondIdx), rest: url.slice(secondIdx) };
}

// A clickable URL anchor: trailing junk splits off so "see https://x.com." links to the
// URL and shows the period as text; a doubled URL renders first as anchor, rest as plain text.
function renderUrl(url: string, key: number): React.ReactNode[] {
  const { primary, rest } = splitOnRepeatedScheme(url);
  let href = primary;
  let trailing = '';
  const trailMatch = href.match(HREF_TRAIL_JUNK_RE);
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
  if (rest) out.push(rest);
  return out;
}

// Render a markdown link [text](url) where visible text and href may differ; same junk rule.
// A credential the platform is holding, drawn where its value would have been. The engine
// substitutes the placeholder on the wire (see `secret-values.ts`); the DECISION of what is
// a placeholder lives in `lib/credential-placeholder.ts`, this component only draws. The
// token's literal text is deliberately absent here so the pattern can't drift from the engine's.
const CredentialChip = ({ tag }: { tag: string | null }) => (
  <span className="pill pill--draft" title={credentialChipTitle(tag)}>
    <i className="dot" />{CREDENTIAL_CHIP_LABEL}
  </span>
);

function renderMarkdownLink(text: string, url: string, key: number): React.ReactNode {
  let href = url.trim();
  const trailMatch = href.match(HREF_TRAIL_JUNK_RE);
  if (trailMatch) href = href.slice(0, href.length - trailMatch[0].length);
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer"
      className="text-cp-blue hover:underline break-all">
      {text}
    </a>
  );
}

// Emphasis, markdown links, angle links, and bare URLs. URLs win ties with bold/italic, and
// bold/italic content is processed recursively, so `**https://x.com**` stays clickable inside.
// A credential placeholder is a SUBSTITUTION, not a formatting token, so it splits out BEFORE
// the formatting pass: no formatting rule can reinterpret part of the span, and the decision
// of what IS a placeholder stays in one pure, suite-driven function, not another regex here.
function processInline(text: string, baseKey: number): React.ReactNode {
  const segments = splitCredentialPlaceholders(text);

  // FAST PATH ONLY, written in this direction deliberately: the segment walk is the DEFAULT,
  // so a broken or disabled guard fails toward drawing chips rather than toward leaking the
  // raw token back onto the page.
  if (segments.length === 1 && segments[0].kind === 'text') {
    return processInlineFormatting(text, baseKey);
  }

  return (
    <span key={baseKey}>
      {segments.map((s, i) => (s.kind === 'credential'
        ? <CredentialChip key={`c${baseKey}-${i}`} tag={s.tag} />
        : <span key={`t${baseKey}-${i}`}>{processInlineFormatting(s.text, baseKey * 100 + i)}</span>))}
    </span>
  );
}

function processInlineFormatting(text: string, baseKey: number): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = baseKey * 1000;

  // Pre-built regex for bare URLs (any scheme).
  const URL_RE = new RegExp(`^(.*?)(${SCHEME_WITH_AUTHORITY}|${SCHEME_NO_AUTHORITY})`);

  while (remaining.length > 0) {
    // Each token type matches; push order into `candidates` decides precedence on ties
    // (stable sort), so a URL at bold's index still wins and stays clickable inside the bold.
    const mdLinkMatch = remaining.match(
      // [text](url): text is anything but ], url is anything but ).
      /^(.*?)\[([^\]]+)\]\((https?:\/\/[^\s)]+|(?:ftps?|sftp|smb|ssh|file):\/\/[^\s)]+|(?:mailto|tel|sms):[^\s)]+)\)/,
    );
    const angleMatch = remaining.match(
      // <url>: a bare URL in angle brackets, LLMs use these to "protect" a link from formatting.
      new RegExp(`^(.*?)<(${SCHEME_WITH_AUTHORITY}|${SCHEME_NO_AUTHORITY})>`),
    );
    const urlMatch = remaining.match(URL_RE);
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*/);
    const italicMatch = remaining.match(/^(.*?)\*(.+?)\*/);

    const candidates: Array<{ type: string; index: number; match: RegExpMatchArray }> = [];
    // Ties resolve in push order: explicit link forms, then bare URL, then formatting.
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
