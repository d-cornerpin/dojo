// ════════════════════════════════════════
// Web Search and Fetch Implementations
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getSearchApiKey } from '../config/loader.js';
import { checkPermission } from './permissions.js';

const logger = createLogger('web-tools');

// ── Global Brave Search Rate Limiter (1 req/sec for Free plan) ──

const SEARCH_MIN_INTERVAL_MS = 1100; // 1.1s to stay safely under 1 req/s
let lastSearchTime = 0;
const searchQueue: Array<{
  resolve: (value: string) => void;
  execute: () => Promise<string>;
}> = [];
let searchQueueProcessing = false;

async function processSearchQueue(): Promise<void> {
  if (searchQueueProcessing) return;
  searchQueueProcessing = true;

  while (searchQueue.length > 0) {
    const now = Date.now();
    const waitMs = Math.max(0, SEARCH_MIN_INTERVAL_MS - (now - lastSearchTime));

    if (waitMs > 0) {
      await new Promise(r => setTimeout(r, waitMs));
    }

    const item = searchQueue.shift();
    if (!item) break;

    lastSearchTime = Date.now();
    try {
      const result = await item.execute();
      item.resolve(result);
    } catch (err) {
      item.resolve(`Web search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  searchQueueProcessing = false;
}

function enqueueSearch(execute: () => Promise<string>): Promise<string> {
  return new Promise<string>((resolve) => {
    searchQueue.push({ resolve, execute });
    processSearchQueue();
  });
}

// ── Web Search (Brave Search API) ──

export async function webSearch(
  agentId: string,
  params: { query: string; count?: number },
): Promise<string> {
  const { query, count = 5 } = params;

  // Get API key from secrets
  const apiKey = getSearchApiKey();

  if (!apiKey) {
    return 'Web search not configured. Add a Brave Search API key in Settings > Platform.';
  }

  // Permission check
  const perm = checkPermission(agentId, { type: 'network', domain: 'api.search.brave.com' });
  if (!perm.allowed) {
    return `Permission denied: ${perm.reason}`;
  }

  const queuePosition = searchQueue.length;
  if (queuePosition > 0) {
    logger.info('Web search queued', { query, queuePosition }, agentId);
  }

  // All searches go through the rate-limited queue
  return enqueueSearch(async () => {
    const searchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`;

    logger.info('Web search executing', { query, count }, agentId);

    const response = await fetch(searchUrl, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      logger.error('Brave Search API error', {
        status: response.status,
        body: errorText.slice(0, 500),
      }, agentId);
      return `Web search failed (HTTP ${response.status}): ${errorText.slice(0, 200)}`;
    }

    const data = await response.json() as {
      web?: {
        results?: Array<{
          title: string;
          url: string;
          description: string;
        }>;
      };
    };

    const results = data.web?.results ?? [];
    if (results.length === 0) {
      return `No results found for: "${query}"`;
    }

    const formatted = results.map((r, i) => {
      return `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`;
    }).join('\n\n');

    return `Search results for "${query}":\n\n${formatted}`;
  });
}

// ── Web Fetch ──

function stripHtmlTags(html: string): string {
  // Remove script and style blocks entirely
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // Replace br and p tags with newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n\n');
  text = text.replace(/<li>/gi, '- ');
  text = text.replace(/<\/li>/gi, '\n');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');
  return text.trim();
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export async function webFetch(
  agentId: string,
  params: { url: string; maxTokens?: number },
): Promise<string> {
  const { url, maxTokens = 8000 } = params;

  // Permission check
  const domain = extractDomain(url);
  const perm = checkPermission(agentId, { type: 'network', domain });
  if (!perm.allowed) {
    return `Permission denied: ${perm.reason}`;
  }

  logger.info('Web fetch', { url, domain }, agentId);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'DOJO/1.0 (agent-fetch)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });

    if (!response.ok) {
      return `Fetch failed (HTTP ${response.status}): ${response.statusText}`;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();

    let text: string;
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      text = stripHtmlTags(body);
    } else {
      text = body;
    }

    // Truncate to maxTokens (rough: 1 token ~ 4 chars)
    const maxChars = maxTokens * 4;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + `\n\n... [TRUNCATED: content is ${text.length} characters, showing first ${maxChars}]`;
    }

    return `Fetched from ${url}:\n\n${text}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Web fetch failed', { error: msg, url }, agentId);
    return `Web fetch failed: ${msg}`;
  }
}
