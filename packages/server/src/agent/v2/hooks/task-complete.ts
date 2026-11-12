// No-op seam. Do not re-add a dump: the AGENT NOTICE, task row, and agent bus already carry the ask.
export async function onTaskComplete(
  taskId: string | null | undefined,
  completingAgentId: string,
): Promise<void> {
  void taskId;
  void completingAgentId;
  return;
}
