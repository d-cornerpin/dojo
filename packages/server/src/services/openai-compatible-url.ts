// ════════════════════════════════════════
// services/openai-compatible-url.ts — the one answer for where an
// OpenAI-compatible provider's API lives.
//
// A configured base URL may already end in `/v1` (it is what a local server
// prints; the chat path knows this — `resolveOpenAIBaseUrl` in agent/model.ts).
// Each media service used to append `/v1` by hand without that check, so such a
// provider got `…/v1/v1/…` and a 404 while chat on the same provider worked.
// ════════════════════════════════════════

export function openAiCompatibleUrl(baseUrl: string | null | undefined, path: string): string {
  const root = (baseUrl ?? '').trim().replace(/\/+$/, '') || 'https://api.openai.com';
  const v1 = /\/v1$/i.test(root) ? root : `${root}/v1`;
  return `${v1}/${path.replace(/^\/+/, '')}`;
}
