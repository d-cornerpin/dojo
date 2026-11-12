// The one answer for where an OpenAI-compatible provider's API lives: a configured base URL may already
// end in `/v1` (as a local server prints), and appending `/v1` again gives `.../v1/v1/...` and a 404.

export function openAiCompatibleUrl(baseUrl: string | null | undefined, path: string): string {
  const root = (baseUrl ?? '').trim().replace(/\/+$/, '') || 'https://api.openai.com';
  const v1 = /\/v1$/i.test(root) ? root : `${root}/v1`;
  return `${v1}/${path.replace(/^\/+/, '')}`;
}
