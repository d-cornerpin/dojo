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
});
