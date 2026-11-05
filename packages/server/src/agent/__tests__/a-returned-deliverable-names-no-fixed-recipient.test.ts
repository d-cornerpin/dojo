// v3.5 field fix 3, audit round (#2 remainder). Channel identity is sacred: reply on the channel the
// message came from (owner, 2026-11-04: "obviously if a user types a message on the dashboard, they
// get a response on the dashboard"). The note the main agent got when a helper returned a deliverable
// hard-named the OWNER as its recipient ("send <owner> an iMessage with the gist"), whoever the work
// was for and wherever it was asked. It now states the fact and leaves the recipient to the record of
// who asked, on the channel they asked on.
import { describe, it, expect } from 'vitest';
import { deliverableArrivedNote } from '../a2a-transport.js';

describe('a returned deliverable names no fixed recipient', () => {
  it('states that the deliverable came back, with no owner name and no iMessage instruction', () => {
    const note = deliverableArrivedNote('Helper Bot');
    expect(note).toContain('Helper Bot');
    expect(note).toMatch(/deliverable/);
    expect(note).not.toMatch(/iMessage/);
    expect(note).toMatch(/channel they asked on/);
  });
});
