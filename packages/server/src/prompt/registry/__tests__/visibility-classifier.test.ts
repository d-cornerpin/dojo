// V5 lock — the chat-visibility taxonomy (@dojo/shared visibility.ts) as
// committed tests. Pins (a) the tool display-class drift guard over the real
// tool inventory (tools/categories.ts), (b) the message-level hide/show
// classifier, and (c) the channel parsers, all against the REAL marker shapes
// observed on the dev server. See DOJO-CHAT-VISIBILITY-PLAN.md V5 + §3/§3a.
import { describe, it, expect } from 'vitest';
import {
  classifyTool,
  classifyMessageForDisplay,
  parseInboundChannel,
  parseOutboundRouting,
  stripInboundChannelMarker,
} from '@dojo/shared';
import { TOOL_CATEGORIES } from '../../../tools/categories.js';

type Role = 'user' | 'assistant' | 'tool' | 'system';
const VALID_CLASSES = new Set(['effectful-action', 'retrieval', 'bookkeeping', 'delivery']);

describe('classifyTool — tool display class', () => {
  it('every tool in TOOL_CATEGORIES classifies to a valid class (drift guard)', () => {
    const names = TOOL_CATEGORIES.flatMap((c) => c.tools);
    expect(names.length).toBeGreaterThan(100);
    for (const name of names) {
      const cls = classifyTool(name);
      expect(VALID_CLASSES.has(cls), `tool ${name} classified as ${cls}`).toBe(true);
    }
  });

  it('classifies the known examples (regression guard for the heuristic)', () => {
    // effectful actions (badge in regular)
    expect(classifyTool('image_create')).toBe('effectful-action');
    expect(classifyTool('imessage_send')).toBe('effectful-action');
    expect(classifyTool('file_write')).toBe('effectful-action');
    expect(classifyTool('calendar_create')).toBe('effectful-action');
    // retrieval (subtle badge; data stays wordy)
    expect(classifyTool('web_search')).toBe('retrieval');
    expect(classifyTool('file_read')).toBe('retrieval');
    expect(classifyTool('slides_get_style')).toBe('retrieval'); // read verb wins over the "style" mutation token
    expect(classifyTool('gmail_search')).toBe('retrieval');
    // bookkeeping + coordination (hidden in regular)
    expect(classifyTool('vault_remember')).toBe('bookkeeping');
    expect(classifyTool('tracker_update_status')).toBe('bookkeeping');
    expect(classifyTool('send_to_agent')).toBe('bookkeeping');
    expect(classifyTool('spawn_agent')).toBe('bookkeeping');
    expect(classifyTool('transcribe_audio')).toBe('bookkeeping');
    // delivery primitive
    expect(classifyTool('show_to_user')).toBe('delivery');
  });
});

describe('classifyMessageForDisplay — hide/show', () => {
  const hidden = (role: Role, content: string) =>
    classifyMessageForDisplay({ role, content }).tier !== 'user-visible';

  it('hides coordination / engine events (user role)', () => {
    expect(hidden('user', '[SOURCE: TRACKER TASK ASSIGNMENT - new task]')).toBe(true);
    expect(hidden('user', '[SOURCE: AGENT HEALTH ALERT - automated]')).toBe(true);
    expect(hidden('user', '[SOURCE: ENGINE - completion]')).toBe(true);
    expect(hidden('user', '[SOURCE: ORPHANED COMPLETION - automated]')).toBe(true);
    expect(hidden('user', '[A2A:QUESTION thread:x from:y] hi')).toBe(true);
    expect(hidden('user', '[System: something]')).toBe(true);
  });

  it('shows real inbound channels + normal text (user role)', () => {
    expect(hidden('user', '[SOURCE: IMESSAGE FROM Alex] hi')).toBe(false);
    expect(hidden('user', '[SOURCE: PHONE CALL FROM Alex] hi')).toBe(false);
    expect(hidden('user', '[SOURCE: SMS FROM +15551234567] hi')).toBe(false);
    expect(hidden('user', '[SOURCE: TEAMS MESSAGE FROM Alice] hi')).toBe(false);
    expect(hidden('user', '[SOURCE: GMAIL NOTIFICATION - acct] hi')).toBe(false);
    expect(hidden('user', 'what is 17 times 4?')).toBe(false);
  });

  it('hides engine assistant fallbacks but shows real apologies', () => {
    expect(hidden('assistant', 'I got stuck on that one')).toBe(true);
    expect(hidden('assistant', "I'm sorry — I'm having trouble reaching the model")).toBe(true);
    expect(hidden('assistant', 'Understood, I have reviewed the continuity brief')).toBe(true);
    expect(hidden('assistant', 'Understood, I have reviewed my background context')).toBe(true);
    expect(hidden('assistant', "I'm sorry to hear that, let me help")).toBe(false);
    expect(hidden('assistant', 'Here is your answer')).toBe(false);
  });

  it('tool results are agent-only; the no-reply marker is never shown', () => {
    expect(classifyMessageForDisplay({ role: 'tool', content: '[]' }).tier).toBe('agent-only');
    expect(
      classifyMessageForDisplay({
        role: 'system',
        content: '[Agent ended turn without replying — conversation closed]',
      }).tier,
    ).toBe('never-shown');
  });
});

describe('channel parsers — real marker shapes', () => {
  it('parseInboundChannel covers all five channels + rejects non-channels', () => {
    expect(parseInboundChannel('[SOURCE: IMESSAGE FROM Alex (x) - The main user.] hi')?.channel).toBe('imessage');
    expect(parseInboundChannel('[SOURCE: PHONE CALL FROM (unknown)]\n\nhi')).toMatchObject({ channel: 'phone', sender: null });
    expect(parseInboundChannel('[SOURCE: SMS FROM +15551234567] hi')).toMatchObject({ channel: 'sms', sender: '+15551234567' });
    expect(parseInboundChannel('[SOURCE: TEAMS MESSAGE FROM Alice Smith] hi')).toMatchObject({ channel: 'teams', sender: 'Alice Smith' });
    expect(parseInboundChannel('[SOURCE: GMAIL NOTIFICATION - user@example.com (user)] hi')?.channel).toBe('email');
    expect(parseInboundChannel('[SOURCE: AGENT MESSAGE FROM TESTUSER (agent ID: x)]')).toBeNull();
    expect(parseInboundChannel('just a normal message')).toBeNull();
  });

  it('parseOutboundRouting handles real outbound markers including phone', () => {
    expect(parseOutboundRouting('[Reply routed via iMessage to Alex]')).toMatchObject({ channel: 'imessage', recipient: 'Alex' });
    expect(parseOutboundRouting('[Reply routed via phone call to Alex]')).toMatchObject({ channel: 'phone', recipient: 'Alex' });
    expect(parseOutboundRouting('[SENT VIA IMESSAGE to Alex]')).toMatchObject({ channel: 'imessage', recipient: 'Alex' });
    expect(parseOutboundRouting('not a marker')).toBeNull();
  });

  it('stripInboundChannelMarker removes the header + phone trailer', () => {
    expect(stripInboundChannelMarker('[SOURCE: IMESSAGE FROM Alex] hello there')).toBe('hello there');
    const phone = '[SOURCE: PHONE CALL FROM Alex]\n\nHey there\n\nCall SID: CA123\nTo: +1555\nDirection: inbound';
    expect(stripInboundChannelMarker(phone)).toBe('Hey there');
  });
});
