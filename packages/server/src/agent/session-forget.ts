
// Every session_started_at writer calls this; clears are dynamic imports, best-effort, and must stay narrow.
export async function forgetSessionScratch(agentId: string): Promise<void> {
  try {
    const { clearSessionLoadedTools } = await import('../tools/tool-docs.js');
    clearSessionLoadedTools(agentId);
  } catch { /* best-effort, never the reason a reset fails */ }
}
