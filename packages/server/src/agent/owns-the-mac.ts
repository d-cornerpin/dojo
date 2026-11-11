import { isPrimaryAgent } from '../config/platform.js';

// Only the main agent gets full-Mac reach; key/password files and credential tables stay hidden from it too.
export function ownsTheMac(agentId: string | null | undefined): boolean {
  return !!agentId && isPrimaryAgent(agentId);
}
