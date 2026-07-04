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
      // F5 (harness finding): a 429 is the provider's rate/quota limit, an
      // environmental condition, not an agent error. Retrying just burns more
      // quota (observed: a research turn retried into three consecutive 429s).
      // Tell the agent plainly to proceed without more searches, and log WARN.
      if (response.status === 429) {
        logger.warn('Brave Search rate/quota limit hit (429)', {
          body: errorText.slice(0, 200),
        }, agentId);
        return (
          'Web search is rate/quota limited right now (HTTP 429). Do NOT retry web_search this turn. ' +
          'Proceed with the sources you already have, or use web_fetch on URLs you already know.'
        );
      }
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

    // Phase 3.5 (2026-05-04) — per-result snippet cap at 200 chars per
    // Part XVIII §A. Brave's `description` is the snippet; truncating it
    // here keeps even a 20-result query well under the 3K token cap.
    const SNIPPET_CHARS = 200;
    const formatted = results.map((r, i) => {
      const snippet =
        r.description.length > SNIPPET_CHARS
          ? r.description.slice(0, SNIPPET_CHARS) + '…'
          : r.description;
      return `${i + 1}. ${r.title}\n   ${r.url}\n   ${snippet}`;
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
  params: { url: string; prompt?: string; maxTokens?: number },
): Promise<string> {
  // Phase 3.5 (2026-05-04) — `prompt` is now required at the dispatcher
  // level. Keeping the optional signature here so legacy callers still
  // compile, but the documented contract is `{ url, prompt }`. When prompt
  // is absent we fall back to raw fetch (cap'd at maxTokens) only as a
  // safety net for legacy in-process callers; the agent-facing tool
  // schema enforces required.
  const { url, prompt, maxTokens = 8000 } = params;

  // Permission check
  const domain = extractDomain(url);
  const perm = checkPermission(agentId, { type: 'network', domain });
  if (!perm.allowed) {
    return `Permission denied: ${perm.reason}`;
  }

  logger.info('Web fetch', { url, domain, hasPrompt: !!prompt }, agentId);

  let text: string;
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
      // A non-2xx from an EXTERNAL url (404/410 gone, 403 gated, 5xx server
      // erroring, etc.) is an environmental condition about that page, not a
      // tool malfunction or an agent mistake, exactly like the web_search 429
      // path above. Retrying the same dead URL just wastes a turn. Return a
      // CLEAR, actionable NON-error result: the dispatcher flags is_error only
      // on the "Fetch failed"/"Permission denied" prefixes, so avoiding that
      // prefix keeps a handled HTTP failure from surfacing as a BLOCKING tool
      // error. Genuine tool-arg errors (missing prompt, invalid url) and
      // permission denials are still is_error at the dispatcher. (harness
      // finding, 2026-07-03: an external 404 during a research turn was
      // failing the run's NO_UNEXPECTED_TOOL_ERROR invariant.)
      logger.warn('Web fetch got a non-OK HTTP status', {
        url, status: response.status, statusText: response.statusText,
      }, agentId);
      return (
        `That URL returned HTTP ${response.status} (${response.statusText || 'no status text'}), so there is no page content to read. ` +
        `The link is likely moved, wrong, or temporarily down. Do NOT retry this exact URL; try a different source or URL instead.`
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();

    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      text = stripHtmlTags(body);
    } else {
      text = body;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A network-layer fetch failure (timeout / DNS / refused / TLS) to an EXTERNAL
    // url is environmental, and this branch already HANDLES it: it returns actionable
    // guidance to the agent (below), not an is_error. Log at WARN, matching the
    // sibling non-2xx branch. Logging at ERROR mislabels a handled external failure
    // as an agent-level error (it red-ed research turns on a transient remote timeout).
    logger.warn('Web fetch failed (handled, returned actionable guidance to the agent)', { error: msg, url }, agentId);
    // v2.3.19 — translate the raw Node fetch error into something
    // actionable. Pre-spec the agent got "Web fetch failed: fetch
    // failed" which is doubled-up and unhelpful — the doubled "fetch
    // failed" is the literal Node error message with no detail.
    const lower = msg.toLowerCase();
    let friendly: string;
    if (lower.includes('enotfound') || lower.includes('getaddrinfo')) {
      friendly = `Couldn't reach ${url} — the domain doesn't resolve. Check the URL for typos or confirm the site is live.`;
    } else if (lower.includes('econnrefused')) {
      friendly = `Couldn't reach ${url} — connection refused. The server may be down or blocking the request.`;
    } else if (lower.includes('etimedout') || lower.includes('timeout')) {
      friendly = `Couldn't reach ${url} — request timed out. The server is slow or unresponsive.`;
    } else if (lower.includes('certificate') || lower.includes('cert_') || lower.includes('ssl')) {
      friendly = `Couldn't reach ${url} — TLS/certificate problem. The site may have an invalid HTTPS certificate.`;
    } else if (msg === 'fetch failed' || lower === 'fetch failed') {
      // Generic Node fetch fallback when no `cause` was attached.
      friendly = `Couldn't reach ${url} — the request failed at the network layer. The domain may not exist or there may be no internet connection.`;
    } else {
      friendly = `Web fetch of ${url} failed: ${msg}`;
    }
    return friendly;
  }

  // Phase 3.5 (2026-05-04) — when a `prompt` is provided, call a cheap
  // model to extract the focused content matching the prompt instead of
  // returning the raw page. This is the structural fix for context bloat
  // on web_fetch — a 50K-token page becomes a ~1-2K targeted extract.
  // Falls back to raw fetch if the extractor model isn't available or
  // the call fails (callers always get *something* useful back).
  if (prompt && prompt.trim().length > 0) {
    try {
      const { selectModel } = await import('../router/selector.js');
      const { callModel } = await import('./model.js');
      // Use the agent's own model unless we can find a cheaper 'light'
      // tier model. Light tier is the right home for compress-the-page
      // calls — they're short prompts with bounded outputs.
      const lightModel = selectModel('light', agentId);
      const fetchModelId = lightModel?.modelId ?? null;
      if (fetchModelId) {
        // Cap input to prevent runaway costs on huge pages. ~50K chars
        // (~12K tokens) is plenty for a focused-extraction prompt; longer
        // pages are heuristically the wrong tool anyway (use search).
        const pageSnippet = text.length > 50_000 ? text.slice(0, 50_000) : text;
        const result = await callModel({
          agentId,
          modelId: fetchModelId,
          systemPrompt:
            'You are a focused web content extractor. Given a page and an extraction prompt, ' +
            'return ONLY the information requested. Be terse, direct, no preamble, no recap of ' +
            'the prompt. If the page does not contain the requested information, say so in one sentence.',
          messages: [
            {
              role: 'user',
              content: `Extraction prompt: ${prompt}\n\nPage URL: ${url}\n\nPage content:\n${pageSnippet}`,
            },
          ],
          tools: false,
          // F3 (harness finding): this is a best-effort utility call with a raw-fetch
          // fallback right below. A busy local extractor model was stalling real turns
          // for minutes against the provider's default 5-minute timeout, then logging
          // at ERROR even though the failure is fully handled here. Fail fast to the
          // fallback instead; 45s is generous for a bounded extraction.
          abortSignal: AbortSignal.timeout(45_000),
          bestEffort: true,
        });
        const extract = result.content?.trim();
        if (extract && extract.length > 0) {
          return `Fetched from ${url} (extracted via prompt):\n\n${extract}`;
        }
        logger.warn('web_fetch extractor returned empty content — falling back to raw', { url }, agentId);
      } else {
        logger.warn('web_fetch: no light-tier model available — falling back to raw fetch', { url }, agentId);
      }
    } catch (err) {
      logger.warn('web_fetch prompt extraction failed — falling back to raw', {
        url, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  // Raw fetch fallback (when no prompt, no light model, or extraction failed).
  const maxChars = maxTokens * 4;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + `\n\n... [TRUNCATED: content is ${text.length} characters, showing first ${maxChars}]`;
  }
  return `Fetched from ${url}:\n\n${text}`;
}
