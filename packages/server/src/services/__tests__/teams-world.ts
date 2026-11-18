// A scripted Teams for the Teams watcher tests: one chat whose messages a test sets, served the way Graph serves them
// (newest first), with the chat's newest message time on the chat list. Uses the Graph fake of `mail-world.ts`.
import * as w from './mail-world.js';

export interface TeamsMsg { id: string; email: string; text: string; at: string; files?: string[]; mine?: boolean }
export const chat = { type: 'oneOnOne' as 'oneOnOne' | 'group', messages: [] as TeamsMsg[] };
const MEMBERS = ['colleague@example.com', 'stranger@example.com'].map((email) => ({ userId: `u-${email}`, email }));

export function serveTeams(): void {
  chat.type = 'oneOnOne';
  chat.messages = [];
  w.msGraphRead.mockImplementation(async (url: string) => {
    if (url.startsWith('me?')) return { ok: true, data: { id: 'me-1' } };
    if (url.startsWith('me/chats')) {
      const newest = chat.messages.map((m) => m.at).sort().pop();
      return { ok: true, data: { value: [{ id: 'chat-1', topic: null, chatType: chat.type, lastUpdatedDateTime: '2026-01-01T00:00:00.000Z', ...(newest ? { lastMessagePreview: { createdDateTime: newest } } : {}) }] } };
    }
    if (url.startsWith('chats/chat-1/members')) return { ok: true, data: { value: MEMBERS } };
    if (url.startsWith('chats/chat-1/messages')) {
      return { ok: true, data: { value: [...chat.messages].reverse().map((m) => ({
        id: m.id, createdDateTime: m.at, from: { user: { id: m.mine ? 'me-1' : `u-${m.email}`, displayName: 'Someone' } },
        body: { content: m.text, contentType: 'text' }, messageType: 'message', attachments: (m.files ?? []).map((name) => ({ name })),
      })) } };
    }
    return { ok: false, error: 'unexpected Graph call' };
  });
}
