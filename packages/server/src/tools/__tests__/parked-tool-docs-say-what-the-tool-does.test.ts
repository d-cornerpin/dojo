// v3.5 text wave — tool descriptions parked by the code lanes, landed so each says what its tool now
// does (the schema fields already did; the description is what the model reads first).
import { describe, it, expect } from 'vitest';
import { toolDefinitionsByName } from '../../agent/tools/definitions.js';

const desc = (name: string): string => toolDefinitionsByName().get(name)!.description;

describe('parked tool descriptions', () => {
  it('t255: outlook_move_to_folder says archive takes the conversation, and how to move one message', () => {
    const d = desc('outlook_move_to_folder');
    expect(d).toContain('Moving to archive or deleteditems takes the message\'s conversation');
    expect(d).toContain('pass this_message_only=true for just one message');
    expect(d).toContain('unless you pass conversation_id');
    expect(d).not.toContain('The original email ID becomes invalid');
  });

  it('t251: gmail_label names the batch form and the empty-change refusal; gmail_search names paging', () => {
    expect(desc('gmail_label')).toContain('To change many at once, pass message_ids (any number; each message is changed on its own, with no widening to its conversation) and/or thread_ids (whole conversations) in ONE call');
    expect(desc('gmail_label')).toContain('A call with no add_labels and no remove_labels changes nothing and is refused.');
    expect(desc('gmail_search')).toContain('pass it back as page_token (same query) to get the next page; keep paging until no next_page_token is printed.');
  });
});
