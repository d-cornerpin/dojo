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

// URL regex — matches http/https URLs
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

// ── Parser ──

function parseMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  // Collect all standalone URLs for preview cards (rendered after text)
  const previewUrls: string[] = [];

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

      // Find URLs that are on their own line (standalone) for preview cards
      for (const line of paraLines) {
        const trimmed = line.trim();
        if (trimmed.match(/^https?:\/\/[^\s]+$/) && !trimmed.includes(' ')) {
          previewUrls.push(trimmed);
        }
      }

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

  // Render link preview cards for standalone URLs
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
    <div className="my-2 rounded-lg bg-transparent border white/[0.08] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.04] border-b white/[0.08]">
        <span className="text-xs white/40 font-mono">{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="text-xs white/40 hover:white/70 transition-colors"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="px-3 py-2 text-xs font-mono white/70 overflow-x-auto whitespace-pre">
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
          className="px-1.5 py-0.5 bg-transparent border white/[0.08] rounded text-xs font-mono text-blue-300"
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

// Process emphasis (bold, italic) and URLs within text
function processInline(text: string, baseKey: number): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = baseKey * 1000;

  while (remaining.length > 0) {
    // Find the next URL, bold, or italic — whichever comes first
    const urlMatch = remaining.match(/^(.*?)(https?:\/\/[^\s<>"')\]]+)/);
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*/);
    const italicMatch = remaining.match(/^(.*?)\*(.+?)\*/);

    // Find which match starts earliest
    const candidates: Array<{ type: string; index: number; match: RegExpMatchArray }> = [];
    if (urlMatch) candidates.push({ type: 'url', index: urlMatch[1].length, match: urlMatch });
    if (boldMatch) candidates.push({ type: 'bold', index: boldMatch[1].length, match: boldMatch });
    if (italicMatch) candidates.push({ type: 'italic', index: italicMatch[1].length, match: italicMatch });

    if (candidates.length === 0) {
      parts.push(remaining);
      break;
    }

    // Pick the earliest match
    candidates.sort((a, b) => a.index - b.index);
    const winner = candidates[0];

    if (winner.type === 'url') {
      const m = winner.match;
      if (m[1]) parts.push(m[1]);
      const url = m[2];
      parts.push(
        <a key={key++} href={url} target="_blank" rel="noopener noreferrer"
          className="text-blue-400 hover:underline break-all">
          {url}
        </a>,
      );
      remaining = remaining.slice(m[0].length);
    } else if (winner.type === 'bold') {
      const m = winner.match;
      if (m[1]) parts.push(m[1]);
      parts.push(
        <strong key={key++} className="font-semibold text-white">
          {m[2]}
        </strong>,
      );
      remaining = remaining.slice(m[0].length);
    } else if (winner.type === 'italic') {
      const m = winner.match;
      if (m[1]) parts.push(m[1]);
      parts.push(
        <em key={key++} className="italic">
          {m[2]}
        </em>,
      );
      remaining = remaining.slice(m[0].length);
    }
  }

  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : <span key={baseKey}>{parts}</span>;
}
