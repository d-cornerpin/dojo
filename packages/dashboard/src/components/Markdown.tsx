import { useState } from 'react';

/**
 * Lightweight markdown renderer for chat messages.
 * Supports: fenced code blocks, inline code, bold, italic, and plain text.
 * No external dependencies.
 */
export const Markdown = ({ content }: { content: string }) => {
  const elements = parseMarkdown(content);
  return <div className="text-sm leading-relaxed break-words">{elements}</div>;
};

// ── Parser ──

function parseMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

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

// ── Inline Markdown (bold, italic, inline code) ──

function InlineMarkdown({ text }: { text: string }): React.ReactNode {
  // Process inline patterns: `code`, **bold**, *italic*
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Inline code: `...`
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`/);
    if (codeMatch) {
      if (codeMatch[1]) parts.push(processEmphasis(codeMatch[1], key++));
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

    // No more inline code — process emphasis on the rest
    parts.push(processEmphasis(remaining, key++));
    break;
  }

  return <>{parts}</>;
}

function processEmphasis(text: string, baseKey: number): React.ReactNode {
  // **bold** and *italic*
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = baseKey * 1000;

  while (remaining.length > 0) {
    // Bold: **...**
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*/);
    if (boldMatch) {
      if (boldMatch[1]) parts.push(boldMatch[1]);
      parts.push(
        <strong key={key++} className="font-semibold text-white">
          {boldMatch[2]}
        </strong>,
      );
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic: *...*
    const italicMatch = remaining.match(/^(.*?)\*(.+?)\*/);
    if (italicMatch) {
      if (italicMatch[1]) parts.push(italicMatch[1]);
      parts.push(
        <em key={key++} className="italic">
          {italicMatch[2]}
        </em>,
      );
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    parts.push(remaining);
    break;
  }

  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : <span key={baseKey}>{parts}</span>;
}
