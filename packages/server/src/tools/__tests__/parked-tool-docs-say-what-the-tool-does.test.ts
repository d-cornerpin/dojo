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
    expect(desc('gmail_label')).toContain('To change many at once, pass message_ids (any number) and/or thread_ids (whole conversations) in ONE call');
    expect(desc('gmail_label')).toContain('A call with no add_labels and no remove_labels changes nothing and is refused.');
    expect(desc('gmail_search')).toContain('pass it back as page_token (same query) to get the next page; keep paging until no next_page_token is printed.');
  });

  it('v3.5 field fix 3 W18: gmail_label says a batch archive takes each message\'s whole conversation, as the tool does', () => {
    const def = toolDefinitionsByName().get('gmail_label')!;
    const d = def.description;
    expect(d).toContain('This holds for message_ids too: each message named is archived with its whole conversation.');
    expect(d).toContain('Pass this_message_only=true to archive only the messages themselves.');
    expect(d).not.toMatch(/no widening/);
    const props = (def.input_schema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.message_ids.description).toBe('Several message IDs in one call. Archiving takes each one\'s whole conversation unless this_message_only=true; any other change is made to each message on its own.');
    expect(props.this_message_only.description).toBe('Archive only the message or messages named, not their conversations');
  });
});
