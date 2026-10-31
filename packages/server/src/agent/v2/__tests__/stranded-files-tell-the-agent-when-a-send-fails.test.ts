// The stranded-file text to the iMessage requester goes through the shared helper, so a failed
// send is told to the agent as well as to the owner.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(__dirname, '../steps/finalize/stranded-attachments.ts'), 'utf8');

describe('stranded-attachments file text', () => {
  it('uses textFilesToRequester and no longer calls the bridge send itself', () => {
    expect(src).toContain('textFilesToRequester(');
    expect(src).not.toContain('sendIMessageWithAttachment(');
  });
  it('still scrubs the caption before it leaves', () => {
    expect(src.indexOf('redactHandedCredentials(agentId, captionText)')).toBeLessThan(src.indexOf('textFilesToRequester('));
  });
});
