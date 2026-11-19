// Web search (Brave) and web fetch for agents.

import { createLogger } from '../logger.js';
import { openAgentCall, STOPPED_BY_USER } from './abortable-call.js';
import { stripHtmlTags } from './html-text.js';
import { outsideSpan } from '../tools/external-content.js';
import { getSearchApiKey } from '../config/loader.js';
import { checkPermission } from './permissions.js';
import { SEARCH_HOST } from '@dojo/shared';
// web_fetch is bounded in two phases: the server gets 15s to answer, then the body read gets its own
// deadline sized from the declared content-length, between the base and the ceiling.
const WEB_FETCH_HEADERS_TIMEOUT_MS = 15_000;
const WEB_FETCH_BODY_BASE_TIMEOUT_MS = 20_000;
const WEB_FETCH_BODY_CEILING_MS = 2 * 60_000;

import { assertPublicHttpTarget, NetGuardError } from './net-guard.js';
import { isPrimaryAgent } from '../config/platform.js';
import { phasedTransferDeadline } from '../services/transfer-deadline.js';

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
    return 'Web search not configured. Add a Brave Search API key in Settings → Dojo → Web Search Provider.';
  }

  // Permission check
  const perm = checkPermission(agentId, { type: 'network', domain: SEARCH_HOST });
  if (!perm.allowed) {
    return `Permission denied: ${perm.reason}`;
  }

  const queuePosition = searchQueue.length;
  if (queuePosition > 0) {
    logger.info('Web search queued', { query, queuePosition }, agentId);
  }

  // The slot opens inside the queue, so a call still waiting behind the rate limiter is not reported as
  // running work. `turn` scope, with the 15s clock composed.
  return enqueueSearch(async () => {
    const slot = openAgentCall(agentId, 'turn', AbortSignal.timeout(15000));
    try {
      if (slot.refused) return STOPPED_BY_USER;
      const searchUrl = `https://${SEARCH_HOST}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`;

    logger.info('Web search executing', { query, count }, agentId);

    const response = await fetch(searchUrl, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: slot.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      // A 429 is the provider's rate or quota limit, not an agent error, and retrying only burns more quota:
      // tell the agent to proceed without more searches, and log at WARN.
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

    // Brave's `description` is the snippet; capping it at 200 chars keeps a 20-result query small.
    const SNIPPET_CHARS = 200;
    const formatted = results.map((r, i) => {
      const snippet =
        r.description.length > SNIPPET_CHARS
          ? r.description.slice(0, SNIPPET_CHARS) + '…'
          : r.description;
      return `${i + 1}. ${r.title}\n   ${r.url}\n   ${snippet}`;
    }).join('\n\n');

    return `Search results for "${query}":\n\n${outsideSpan(formatted)}`;   // only the results are outside text
    } catch (err) {
      // The discriminator is this call's OWN controller, never the message: a composed clock
      // rejects with the same `AbortError` a stop does.
      if (slot.cutByStop()) return STOPPED_BY_USER;
      throw err;
    } finally {
      slot.release();
    }
  });
}

// ── Web Fetch ──

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
  // The web_fetch tool requires `prompt` (agent/tools/cat/web.ts refuses without it); without one this
  // returns the raw page capped at maxTokens.
  const { url, prompt, maxTokens = 8000 } = params;

  // Permission check
  const domain = extractDomain(url);
  const perm = checkPermission(agentId, { type: 'network', domain });
  if (!perm.allowed) {
    return `Permission denied: ${perm.reason}`;
  }

  logger.info('Web fetch', { url, domain, hasPrompt: !!prompt }, agentId);

  // One slot for the whole redirect loop, so a stop on one hop is not survived by the next, with the
  // phased deadline composed: 15s for headers, then a body deadline from the declared content-length.
  const deadline = phasedTransferDeadline({
    headersMs: WEB_FETCH_HEADERS_TIMEOUT_MS,
    bodyBaseMs: WEB_FETCH_BODY_BASE_TIMEOUT_MS,
    bodyCeilingMs: WEB_FETCH_BODY_CEILING_MS,
  });
  const slot = openAgentCall(agentId, 'turn', deadline.signal);
  if (slot.refused) { deadline.done(); slot.release(); return STOPPED_BY_USER; }

  let text: string;
  try {
    // Follow redirects manually and re-check network permission on every hop, so an allowlisted host (or an
    // open redirect on it) cannot bounce a domain-restricted agent to a non-allowlisted origin.
    let response: Response = null as unknown as Response;
    let currentUrl = url;
    for (let hop = 0; hop < 5; hop++) {
      const hopDomain = extractDomain(currentUrl);
      const hopPerm = checkPermission(agentId, { type: 'network', domain: hopDomain });
      if (!hopPerm.allowed) {
        return `Permission denied: ${hopPerm.reason}`;
      }
      // SSRF guard on every hop, inside the loop, so an open redirect cannot bounce us onto loopback, LAN or
      // metadata addresses. A rejection is a NetGuardError, handled in the catch below.
      if (!isPrimaryAgent(agentId)) await assertPublicHttpTarget(currentUrl);   // the main agent may reach local addresses
      response = await fetch(currentUrl, {
        headers: {
          'User-Agent': 'DOJO/1.0 (agent-fetch)',
          // The trailing `*/*;q=0.1` is load-bearing: without it strict JSON APIs answer 415. At q=0.1 HTML
          // still wins negotiation for ordinary pages, so stripHtmlTags keeps getting HTML.
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1',
        },
        signal: slot.signal,
        redirect: 'manual',
      });
      const loc = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (loc) {
        currentUrl = new URL(loc, currentUrl).href;
        continue;
      }
      break;
    }

    if (!response.ok) {
      // A non-2xx from an external url is a fact about that page, not a tool error. Return actionable
      // guidance without the "Fetch failed"/"Permission denied" prefixes, which web.ts flags as is_error.
      logger.warn('Web fetch got a non-OK HTTP status', {
        url, status: response.status, statusText: response.statusText,
      }, agentId);
      return (
        `That URL returned HTTP ${response.status} (${response.statusText || 'no status text'}), so there is no page content to read. ` +
        `The link is likely moved, wrong, or temporarily down. Do NOT retry this exact URL; try a different source or URL instead.`
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    // Headers are in and redirects resolved: the body gets time sized from this page's declared length.
    deadline.armBody(Number(response.headers.get('content-length') ?? '0') || null);
    const body = await response.text();

    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      text = stripHtmlTags(body);
    } else {
      text = body;
    }
  // Released at the end of the transport, not of the function: the extraction call below registers its
  // own slot through `callModel`.
  } catch (err) {
    if (err instanceof NetGuardError) {
      logger.warn('Web fetch refused by the network guard', { url, address: err.address, reason: err.message }, agentId);
      return `Permission denied: ${err.message}`;
    }
    const msg = err instanceof Error ? err.message : String(err);
    // Checked first: the ladder below would turn the user's stop (an AbortError) into a server timeout.
    if (slot.cutByStop()) { slot.release(); return STOPPED_BY_USER; }
    // A network-layer failure to an external url is environmental and handled here with actionable
    // guidance, so it logs at WARN like the non-2xx branch, not ERROR.
    logger.warn('Web fetch failed (handled, returned actionable guidance to the agent)', { error: msg, url }, agentId);
    // Translate the raw Node error (often just "fetch failed") into something the agent can act on.
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
  } finally {
    // Disarm the phased deadline wherever the slot is released, so neither timer outlives the fetch.
    deadline.done();
    slot.release();
  }

  // With a prompt, a light-tier model extracts what the prompt asks for instead of returning the raw page.
  // Its 45s bound fails fast to the raw page; on any fallback the result says the prompt was not applied.
  let extractionSkipped: string | null = null;
  if (prompt && prompt.trim().length > 0) {
    try {
      const { selectModel } = await import('../router/selector.js');
      const { callModel } = await import('./model.js');
      // Extraction runs on the light-tier model: short prompts with bounded outputs.
      const lightModel = selectModel('light', agentId);
      const fetchModelId = lightModel?.modelId ?? null;
      if (fetchModelId) {
        // Cap input at ~50K chars (~12K tokens) to bound cost on huge pages.
        const pageSnippet = text.length > 50_000 ? text.slice(0, 50_000) : text;
        const readNote = pageSnippet.length < text.length ? ` from the first 50000 of ${text.length} characters; the rest was not read` : '';
        const result = await callModel({
          agentId,
          modelId: fetchModelId,
          // A fetched page distilled for the agent to read: an engine artifact, not a turn.
          purpose: 'page_summary',
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
          // Best-effort with the raw-page fallback below: fail fast instead of waiting out the provider's
          // 5-minute default behind a busy local model.
          abortSignal: AbortSignal.timeout(45_000),
          bestEffort: true,
        });
        const extract = result.content?.trim();
        if (extract && extract.length > 0) {
          return `Fetched from ${url} (extracted via prompt${readNote}):\n\n${outsideSpan(extract)}`;
        }
        extractionSkipped = 'the extractor returned nothing, so the raw page is shown instead';
        logger.warn('web_fetch extractor returned empty content — falling back to raw', { url }, agentId);
      } else {
        extractionSkipped = 'no light-tier model was available to apply it, so the raw page is shown instead';
        logger.warn('web_fetch: no light-tier model available — falling back to raw fetch', { url }, agentId);
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // A timeout and a provider error land in the same place and must not read the same way:
      // the first means the extraction was ABANDONED while possibly healthy, which is the fact
      // the agent needs in order to decide whether to ask again.
      extractionSkipped = /abort|timed out|timeout/i.test(why)
        ? 'the extractor was still working at its 45s bound and was abandoned, so the raw page is shown instead'
        : 'the extractor failed, so the raw page is shown instead';
      logger.warn('web_fetch prompt extraction failed — falling back to raw', {
        url, error: why,
      }, agentId);
    }
  }

  // Raw fetch fallback (when no prompt, no light model, or extraction failed).
  const maxChars = maxTokens * 4;
  // Only the page is outside text; the truncation note, the NOTE and the header are the platform's.
  text = text.length > maxChars
    ? outsideSpan(text.slice(0, maxChars)) + `\n\n... [TRUNCATED: content is ${text.length} characters, showing first ${maxChars}]`
    : outsideSpan(text);
  // The note rides the result, so the agent learns its prompt was not applied.
  return extractionSkipped
    ? `Fetched from ${url} (NOTE: your extraction prompt was NOT applied — ${extractionSkipped}):\n\n${text}`
    : `Fetched from ${url}:\n\n${text}`;
}
