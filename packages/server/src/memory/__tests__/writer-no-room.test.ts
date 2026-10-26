// ════════════════════════════════════════════════════════════════════════════════════════
// THE WRITER'S "NO ROOM" MARK — IN MEMORY ONLY, PER AGENT, IN TWO FLAVOURS.
//
// `writer-no-room.ts` keeps a per-agent map of "the small writer, as an agent's fallback, found
// no room in the memory free at that moment". The map has two flavours, and they must stay apart:
//   • KNOWN — the free memory was too small (`false`). A restart checks once more, and the mark
//     clears only on a real change: the agent's own model answering again, or a person writing
//     to the agent (`writerMayRunAgain`).
//   • UNKNOWN — the memory could not be READ at all (`true`, a failed `/api/ps` or `/api/show`):
//     the writer is passed over the same way, but Ollama answering again lets it be sized again,
//     so `freeMemoryMayBeReadable` forgets the unknown ones while the known ones stay.
//
// None of it was covered: no test referenced `noteWriterHadNoRoom`, `writerHadNoRoom`,
// `writerMayRunAgain` or `freeMemoryMayBeReadable`. The map is module state, shared across this
// file, so each case starts clean — `writerMayRunAgain()` with no argument clears every agent.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';

import { noteWriterHadNoRoom, writerHadNoRoom, writerMayRunAgain, freeMemoryMayBeReadable } from '../writer-no-room.js';

beforeEach(() => writerMayRunAgain());   // the map is module state: clear every agent before each case

describe('the writer\'s "no room" mark is per agent, in two flavours', () => {
  it('a note marks the one agent only; an unmarked agent still has room', () => {
    expect(writerHadNoRoom('a')).toBe(false);
    noteWriterHadNoRoom('a');
    expect(writerHadNoRoom('a')).toBe(true);
    expect(writerHadNoRoom('b')).toBe(false);
  });

  it('something changed: one agent is released, and "no agent named" releases every agent', () => {
    noteWriterHadNoRoom('a');
    noteWriterHadNoRoom('b');
    writerMayRunAgain('a');
    expect(writerHadNoRoom('a')).toBe(false);
    expect(writerHadNoRoom('b')).toBe(true);
    writerMayRunAgain();
    expect(writerHadNoRoom('b')).toBe(false);
  });

  it('Ollama answered: the unknown (unreadable) marks are forgotten, the known (too small) stay', () => {
    noteWriterHadNoRoom('known');
    noteWriterHadNoRoom('guess', true);
    freeMemoryMayBeReadable();
    expect(writerHadNoRoom('guess')).toBe(false);
    expect(writerHadNoRoom('known')).toBe(true);
  });

  it('a later note overwrites the flavour: a known mark written over an unknown one survives freeMemoryMayBeReadable', () => {
    noteWriterHadNoRoom('a', true);
    noteWriterHadNoRoom('a', false);
    freeMemoryMayBeReadable();
    expect(writerHadNoRoom('a')).toBe(true);
  });
});
