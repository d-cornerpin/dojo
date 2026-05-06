import { describe, it, expect } from 'vitest';
import type { ToolCall } from '@dojo/shared';
import { ackInjector, DEFAULT_ACK_TEXT } from '../classifiers/ack.js';

function tc(name: string): ToolCall {
  return { id: `id_${name}`, name, arguments: {} };
}

describe('ackInjector', () => {
  const base = {
    isFirstResponseInTurn: true,
    responseText: '',
    plannedTools: [],
    triggeredByIMessage: false,
    isInterAgentTrigger: false,
    isPrimaryAgent: true,
  };

  it('returns null when not first response in turn', () => {
    const r = ackInjector({ ...base, isFirstResponseInTurn: false, plannedTools: [tc('file_write')] });
    expect(r.ackText).toBeNull();
    expect(r.reason).toContain('mid-tool-loop');
  });

  it('returns null for sub-agents (no user chat)', () => {
    const r = ackInjector({ ...base, isPrimaryAgent: false, plannedTools: [tc('file_write')] });
    expect(r.ackText).toBeNull();
    expect(r.reason).toContain('sub-agent');
  });

  it('returns null for inter-agent triggers', () => {
    const r = ackInjector({ ...base, isInterAgentTrigger: true, plannedTools: [tc('file_write')] });
    expect(r.ackText).toBeNull();
    expect(r.reason).toContain('inter-agent');
  });

  it('returns null when no tools are planned (text IS the ack)', () => {
    const r = ackInjector({ ...base, plannedTools: [] });
    expect(r.ackText).toBeNull();
    expect(r.reason).toContain('no tools');
  });

  it('returns null when agent already produced acknowledgment text', () => {
    const r = ackInjector({
      ...base,
      responseText: 'On it, checking the calendar now.',
      plannedTools: [tc('calendar_search')],
    });
    expect(r.ackText).toBeNull();
    expect(r.reason).toContain('already produced');
  });

  it('returns null when only self-acknowledging tools', () => {
    const r = ackInjector({ ...base, plannedTools: [tc('image_create')] });
    expect(r.ackText).toBeNull();
    expect(r.reason).toContain('self-acknowledging');
  });

  it('returns null when only show_to_user', () => {
    const r = ackInjector({ ...base, plannedTools: [tc('show_to_user')] });
    expect(r.ackText).toBeNull();
  });

  it('INJECTS ack when first response, primary agent, tools planned, no text', () => {
    const r = ackInjector({
      ...base,
      plannedTools: [tc('file_write'), tc('exec')],
    });
    expect(r.ackText).toBe(DEFAULT_ACK_TEXT);
  });

  it('INJECTS ack even when iMessage-triggered (engine ack still goes to dashboard)', () => {
    // Per Q7: do not push engine ack via iMessage. The classifier returns
    // the ack text regardless; the loop layer is responsible for routing
    // it to dashboard only and skipping iMessage delivery.
    const r = ackInjector({
      ...base,
      triggeredByIMessage: true,
      plannedTools: [tc('file_write')],
    });
    expect(r.ackText).toBe(DEFAULT_ACK_TEXT);
  });

  it('does not inject when planned batch mixes self-ack and other (still has substantive work)', () => {
    // Mixed batch: some self-ack tools + a real tool. The real tool means
    // we DO need an ack to set user expectation.
    const r = ackInjector({
      ...base,
      plannedTools: [tc('image_create'), tc('file_write')],
    });
    expect(r.ackText).toBe(DEFAULT_ACK_TEXT);
  });
});
