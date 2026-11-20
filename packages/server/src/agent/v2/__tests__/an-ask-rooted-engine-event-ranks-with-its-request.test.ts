// An engine event rooted in a person's request ranks with that request: after the owner when it is his, after the
// people waiting when it is a contact's; an event about nothing ranks behind a helper's result.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage, insertEngineEvent } from '../../../memory/message-store.js';
import { nextOwed } from '../owed.js';
import { freshReplyDb, AGENT, PERSON } from './helpers/reply-sender.js';

const owner = (id: string): void => void insertMessage({
  id, agentId: AGENT, role: 'user', content: 'pull the quarterly numbers', lane: 'owner', channel: 'dashboard',
  senderId: 'owner', authorized: true, inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
} as never);
const contact = (id: string): void => void insertMessage({
  id, agentId: AGENT, role: 'user', content: 'is the plumber booked?', lane: 'owner', channel: 'imessage',
  senderId: PERSON, authorized: true, inboundMeta: JSON.stringify({ channel: 'imessage', relation: 'known_contact', senderId: PERSON }),
} as never);
const event = (rootId: string | null): void => void insertEngineEvent({
  agentId: AGENT, content: 'a piece of the request came back', originIntent: 'tracker',
  work: rootId ? { taskId: null, runId: null, rootKind: 'ask', rootId } : null,
});
const order = (): string[] => nextOwed(AGENT).map((i) => `${i.kind}:${i.rank}`);

beforeEach(() => { freshReplyDb(runMigrations); });

describe('an ask-rooted engine event ranks with its request', () => {
  it('an event rooted in the owner\'s request comes right after the owner, before a contact', () => {
    owner('m-owner');
    contact('m-contact');
    event('m-owner');
    expect(order()).toEqual(['person:1', 'person:2', 'clock:3']);
  });

  it('an event rooted in a contact\'s request ranks after the people waiting', () => {
    contact('m-contact');
    event('m-contact');
    expect(order()).toEqual(['person:2', 'clock:4']);
  });

  it('an event about no request ranks behind a helper\'s result', () => {
    event(null);
    insertMessage({
      agentId: AGENT, role: 'user', lane: 'a2a', sourceAgentId: 'agent-helper', a2aThreadId: 'thr-1',
      a2aIntent: 'DELIVERABLE', a2aRequiresResponse: true, content: '[A2A:DELIVERABLE thread:thr-1 from:Helper] done',
    });
    expect(order()).toEqual(['agentResult:5', 'clock:6']);
  });
});
