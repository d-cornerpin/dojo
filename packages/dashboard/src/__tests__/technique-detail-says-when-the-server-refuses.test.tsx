// ════════════════════════════════════════════════════════════════════════════
// THE TECHNIQUE DETAIL PAGE SAYS SO WHEN THE SERVER REFUSES.
//
// ── THE DEFECT ──
// `pages/TechniqueDetail.tsx` talks to the server through a local `api()` helper
// that hands back the door’s `{ ok, data | error }` envelope. Three sites read
// the envelope and then threw `ok` away:
//
//   `handleDelete` navigated to /techniques after EVERY delete answer, so a
//   refused delete looked exactly like a completed one.
//
//   `handlePublishToggle` dropped the PUT/POST result and reloaded, so a refused
//   publish just snapped the state pill back to what it was, in silence.
//
//   `load` kept nothing from a failure, and the page renders a null technique as
//   “Technique not found.” — so a dead server and a genuinely missing technique
//   were the SAME lie about the technique not existing.
//
// The door answers failure as a VALUE (`lib/door.ts`), so every case below is a
// render question: what does the page draw when the envelope says no.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The permissive factory the other page tests use — every exported FUNCTION
// answers `{ ok: true, data: [] }`, every exported constant stays real — and
// each test then answers the one door it is about.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  return stub;
});

import * as api from '../lib/api';
import { TechniqueDetail } from '../pages/TechniqueDetail';

const ID = 't1';

const technique = {
  id: ID,
  name: 'Sample technique',
  description: null,
  state: 'draft',
  authorAgentName: null,
  tags: [],
  enabled: true,
  version: 3,
  usageCount: 2,
  lastUsedAt: null,
  buildProjectId: null,
  createdAt: '2026-01-01 00:00:00',
  updatedAt: '2026-01-05 00:00:00',
  publishedAt: null,
  instructions: null,
  files: [],
};

const loadedOk = { ok: true, data: technique };

/** The door answers per `METHOD path`; anything unlisted answers `{ok:true,data:[]}`. */
const doorAnswers = (routes: Record<string, unknown>): void => {
  vi.mocked(api.request).mockImplementation(async (path: string, options?: RequestInit) => {
    const method = (options?.method ?? 'GET').toUpperCase();
    return (routes[`${method} ${path}`] ?? { ok: true, data: [] }) as never;
  });
};

/** The page on the route `App.tsx` gives it, beside the list route — so a
 *  navigation is visible as “All techniques” appearing. */
const renderPage = () => render(
  <MemoryRouter initialEntries={[`/techniques/${ID}`]}>
    <Routes>
      <Route path="/techniques/:id" element={<TechniqueDetail />} />
      <Route path="/techniques" element={<p>All techniques</p>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.stubGlobal('confirm', () => true);
});
afterEach(() => { vi.clearAllMocks(); });

describe('a delete the server refuses', () => {
  it('⚠ stays on the page and shows the server’s reason', async () => {
    doorAnswers({
      [`GET /techniques/${ID}`]: loadedOk,
      [`DELETE /techniques/${ID}`]: { ok: false, error: 'in use' },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect((await screen.findByText(/in use/)).textContent).toContain('in use');
    expect(screen.getByText('Sample technique'), 'the page is still here').toBeTruthy();
    expect(screen.queryByText('All techniques'), 'no navigation on a refused delete')
      .toBeNull();
  });
});

describe('a delete the server allows', () => {
  it('⚠ leaves for the list', async () => {
    doorAnswers({
      [`GET /techniques/${ID}`]: loadedOk,
      [`DELETE /techniques/${ID}`]: { ok: true, data: { deleted: true } },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('All techniques')).toBeTruthy();
  });
});

describe('a publish the server refuses', () => {
  it('⚠ shows the server’s reason instead of snapping back silently', async () => {
    doorAnswers({
      [`GET /techniques/${ID}`]: loadedOk,
      [`POST /techniques/${ID}/publish`]: { ok: false, error: 'needs a reviewer' },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    expect(await screen.findByText(/needs a reviewer/)).toBeTruthy();
    expect(screen.getByText('Sample technique'), 'the page is still here').toBeTruthy();
  });
});

describe('a load that fails for any other reason', () => {
  it('⚠ says it could not load and offers Retry, and does not claim the technique is missing', async () => {
    doorAnswers({ [`GET /techniques/${ID}`]: { ok: false, error: 'boom' } });
    renderPage();

    const banner = await screen.findByText(/Could not load this technique/);
    expect(banner.textContent).toContain('boom');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText(/Technique not found/), 'a dead server is not a missing technique')
      .toBeNull();
  });
});

describe('a load that answers not-found', () => {
  it('⚠ still says “Technique not found.”', async () => {
    doorAnswers({ [`GET /techniques/${ID}`]: { ok: false, error: `Technique "${ID}" not found.` } });
    renderPage();

    expect(await screen.findByText(/Technique not found/)).toBeTruthy();
    expect(screen.queryByText(/Could not load this technique/)).toBeNull();
  });
});
