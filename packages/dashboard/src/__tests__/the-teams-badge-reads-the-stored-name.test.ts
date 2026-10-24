// v3.5 K33 fix round 4 (ruling 2). A Teams sender picks their own display name, so the model-facing
// notice carries it only INSIDE the fence and names the sender outside it by address. The owner's
// badge still says who wrote: the watcher stores the display name in the message record
// (`inbound_meta.senderName`), and the badge reads it there, falling back to the SOURCE line's label
// for any other channel or an older row.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseInboundChannel } from '@dojo/shared';
import { inboundBadge, inboundSenderName } from '../lib/channel-display';

describe('K33 — the Teams badge reads the stored name', () => {
  it('a Teams row badges its stored display name, not the address on the SOURCE line', () => {
    const inbound = parseInboundChannel('[SOURCE: TEAMS MESSAGE FROM c@example.test]\n\nThis is an incoming Microsoft Teams message')!;
    const meta = JSON.stringify({ channel: 'teams', sender: 'c@example.test', senderName: 'A colleague', chatId: 'chat-1' });
    expect(inboundBadge(inbound.channel, inboundSenderName(meta, inbound.sender)).label).toBe('from A colleague via Teams');
  });

  it('an older row, another channel, or an unreadable record keeps the parsed label', () => {
    const old = parseInboundChannel('[SOURCE: TEAMS MESSAGE FROM A colleague (c@example.test)] hi')!;
    expect(inboundSenderName(null, old.sender)).toBe('A colleague');
    expect(inboundSenderName(JSON.stringify({ channel: 'imessage', sender: '+15550100300' }), 'A contact')).toBe('A contact');
    expect(inboundSenderName('{not json', 'A contact')).toBe('A contact');
  });

  it('the chat page carries the record on every load path and the badge uses it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'pages/Chat.tsx'), 'utf8');
    expect(src).toMatch(/inboundBadge\(inbound\.channel, inboundSenderName\(msg\.inboundMeta, inbound\.sender\)\)/);
    expect(src.match(/inboundMeta: m\.inboundMeta \?\? null,/g)?.length, 'first load and load-more').toBe(2);
    expect(src).toMatch(/inboundMeta: e\.message\.inboundMeta \?\? null,/);
  });
});
