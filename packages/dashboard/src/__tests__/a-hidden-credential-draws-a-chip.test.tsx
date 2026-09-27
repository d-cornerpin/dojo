// ════════════════════════════════════════════════════════════════════════════
// THE CHIP IS DRAWN, AND THE TOKEN NEVER REACHES THE PAGE
// (BACKLOG-CAMPAIGN lane 4 item 2, residual MIGRATED OUT OF PROSE).
//
// The engine is right to substitute: `secret-values.ts` replaces a held value
// with a redacted-credential placeholder rather than letting the secret ride in
// chat. What was wrong was what the dashboard DREW — the literal token, angle
// brackets and all, as body text, so the owner read gibberish exactly where a
// value should be. Lane 4 fixed it with a chip and held the DECISION
// (`lib/credential-placeholder.ts`) from the server's suite, then recorded this
// residual:
//
//   | "Forcing the fast path unconditionally still survives, and will until
//   | `packages/dashboard` has a test runner — **BACKLOG line 54, already open**."
//
// `Markdown.tsx`'s `processInline` guards only the PLAIN-TEXT fast path, on
// purpose, so a broken guard fails toward drawing chips rather than toward
// leaking the token. What no source-text clause can prove is that the branch is
// REACHED. This file reaches it, and it is the mutant lane 4 named: force the
// fast path unconditionally and the first clause below goes red.
//
// ── THE FIXTURE PROVES ITSELF ──
// The placeholder's shape belongs to the engine. A test that typed a token which
// had since changed shape would render plain text, draw no chip, and still pass
// its "no token on screen" half — so the fixture is run through the SHIPPED
// recognizer first. A stale fixture fails there, loudly, instead of quietly
// testing nothing.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import {
  hasCredentialPlaceholder, splitCredentialPlaceholders,
  CREDENTIAL_CHIP_LABEL, credentialChipTitle,
} from '../lib/credential-placeholder';
import { Markdown } from '../components/Markdown';

const TAGGED = '<redacted-credential:c1>';
const BARE = '<redacted-credential>';

describe('a credential the platform is holding draws a chip', () => {
  it('has a fixture the shipped recognizer still recognizes', () => {
    expect(hasCredentialPlaceholder(TAGGED), 'the tagged placeholder shape changed').toBe(true);
    expect(hasCredentialPlaceholder(BARE), 'the bare placeholder shape changed').toBe(true);
    expect(splitCredentialPlaceholders(`a ${TAGGED} b`).map((s) => s.kind))
      .toEqual(['text', 'credential', 'text']);
  });

  it('draws the chip where the value would have been, and never the token', () => {
    const { container } = render(<Markdown content={`The key is ${TAGGED} — use it.`} />);

    expect(container.textContent).toContain(CREDENTIAL_CHIP_LABEL);
    expect(container.textContent, 'the raw token reached the page').not.toContain('redacted-credential');
    // The surrounding prose survives the split.
    expect(container.textContent).toContain('The key is');
    expect(container.textContent).toContain('— use it.');
  });

  it('names where the value lives, on the chip itself', () => {
    const { container } = render(<Markdown content={`key: ${TAGGED}`} />);
    const chip = container.querySelector('.pill');
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute('title')).toBe(credentialChipTitle('c1'));
  });

  it('draws it for the untagged form too', () => {
    const { container } = render(<Markdown content={`key: ${BARE}`} />);
    expect(container.textContent).toContain(CREDENTIAL_CHIP_LABEL);
    expect(container.textContent).not.toContain('redacted-credential');
    expect(container.querySelector('.pill')!.getAttribute('title')).toBe(credentialChipTitle(null));
  });

  it('draws one chip per placeholder when a line carries several', () => {
    const { container } = render(<Markdown content={`${TAGGED} and ${BARE} and ${TAGGED}`} />);
    expect(container.querySelectorAll('.pill').length).toBe(3);
    expect(container.textContent).not.toContain('redacted-credential');
  });

  it('leaves ordinary markdown alone — the fast path is still the fast path', () => {
    // ⚠ MEASURED WHILE WRITING THIS FILE, AND WORTH KNOWING: rendering a link mounts
    // `components/LinkPreview.tsx`, which calls the GLOBAL `fetch` directly instead of
    // going through `lib/api` — so it is the one component in this package with no door
    // a test can mock. The network tripwire caught it on the first run. This clause opts
    // into an explicit OFFLINE fetch (which is what `LinkPreview`'s own `.catch` is
    // written for) rather than weakening the tripwire for everyone.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline: stubbed for this clause')));
    const { container } = render(<Markdown content={'**bold** and a [link](https://example.invalid/p)'} />);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.invalid/p');
    expect(container.querySelectorAll('.pill').length).toBe(0);
  });
});
