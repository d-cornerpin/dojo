// A voicemail from the owner's own number or from the approved callers list wakes the agent and says who left it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import * as w from '../../services/__tests__/mail-world.js';

vi.mock('../../db/connection.js', async () => (await import('../../services/__tests__/mail-world.js')).dbModule());
vi.mock('../../gateway/ws.js', async () => (await import('../../services/__tests__/mail-world.js')).wsModule());
vi.mock('../../agent/runtime.js', async () => (await import('../../services/__tests__/mail-world.js')).runtimeModule());
vi.mock('../auth.js', async (orig) => ({ ...(await orig<typeof import('../auth.js')>()), getTwilioCreds: () => ({ sid: 'AC1', token: 'tok-test' }) }));

import '../../db/migrations.js';

const { twilioRouter } = await import('../../gateway/routes/twilio.js');
const app = new Hono().route('/api/twilio', twilioRouter);
const WEBHOOK_URL = 'https://box.example.test/api/twilio/webhook/voicemail-transcription';
const form = { CallSid: 'CA-0', TranscriptionText: 'Please call me back about dinner', From: '+15550100000', To: '+15550100900' };

async function voicemail(form: Record<string, string>): Promise<number> {
  const data = WEBHOOK_URL + Object.keys(form).sort().map((k) => k + form[k]).join('');
  const signature = crypto.createHmac('sha1', 'tok-test').update(data).digest('base64');
  const res = await app.request('/api/twilio/webhook/voicemail-transcription', {
    method: 'POST',
    headers: { 'X-Twilio-Signature': signature, host: 'box.example.test', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  return res.status;
}

const row = () => w.world.db!.prepare("SELECT authorized, inbound_meta, content FROM messages WHERE agent_id = 'primary' AND channel = 'phone'").get() as { authorized: number; inbound_meta: string; content: string };

beforeEach(async () => {
  await w.freshWorld();
  const insert = (key: string, value: string) =>
    w.world.db!.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
  insert('imessage_approved_senders', JSON.stringify([{ address: '+15550100001', name: 'Owner', is_primary: true, sharing_level: 'open_book' }]));
  insert('twilio_voice_approved_callers', JSON.stringify([{ address: '+15550100003', name: 'Caller' }]));
});

describe('a voicemail from an approved caller', () => {
  it('wakes the agent and names a known caller', async () => {
    expect(await voicemail({ ...form, CallSid: 'CA-vm-1', From: '+15550100003' })).toBe(200);
    expect(w.wake).toHaveBeenCalledTimes(1);
    expect(row().authorized).toBe(0);
    expect(JSON.parse(row().inbound_meta).relation).toBe('known_contact');
    expect(row().content.startsWith('[SOURCE: VOICEMAIL FROM +15550100003]')).toBe(true);
  });

  it('from his own number it is him, unfenced', async () => {
    expect(await voicemail({ ...form, CallSid: 'CA-vm-2', From: '+15550100001' })).toBe(200);
    expect(w.wake).toHaveBeenCalledTimes(1);
    expect(JSON.parse(row().inbound_meta).relation).toBe('owner');
    expect(row().content).toContain('Please call me back about dinner');
    expect(row().content).not.toContain('[EXTERNAL');
  });
});
