// ════════════════════════════════════════════════════════════════════════════════════════
// THE MODEL EDITORS MUST SHOW WHAT IS STORED, NOT WHAT WAS TYPED.
//
// "Reset to defaults" asks the server to restore the seeded values and reloads the models,
// which hands the editors a NEW `model` prop. If the draft state keeps the owner's edits
// instead of re-seeding from that new prop, the form still shows the thrown-away values —
// and the next Save writes them back. Mounted for real; only the network door and the
// toast queue are replaced.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Model } from '@dojo/shared';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, updateModelVoiceCatalog: vi.fn(async () => ({ ok: true })) };
});
const toasts = vi.hoisted(() => ({ success: [] as string[], error: [] as string[] }));
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({
    success: (m: string) => { toasts.success.push(m); },
    error: (m: string) => { toasts.error.push(m); },
  }),
  ToastProvider: ({ children }: { children: ReactElement }) => children,
}));

import { GenerationParamsEditor, VoiceCatalogEditor } from '../components/settings/ModelRows';

const model = (props: Record<string, unknown>): Model =>
  ({ id: 'm1', ...props } as unknown as Model);

const seededVoice = () => [{ id: 'v1', description: 'seeded', gender: 'male' }];
const seededSpec = () => ({
  aspect_ratio: {
    accepted: true,
    values: ['16:9'],
    default: '16:9',
    wireField: 'aspect_ratio',
    wireType: 'string',
  },
});

beforeEach(() => {
  vi.stubGlobal('confirm', () => true);
  toasts.success.length = 0;
  toasts.error.length = 0;
});

describe('the model editors after a reload', () => {
  it('the voice catalog editor re-seeds the form from the reloaded catalog', () => {
    const { rerender } = render(
      <VoiceCatalogEditor model={model({ voiceCatalog: seededVoice() })} onSaved={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /voices \(1\)/i }));
    const description = () =>
      screen.getByPlaceholderText(/deep and authoritative/i) as HTMLInputElement;
    fireEvent.change(description(), { target: { value: 'my own voice' } });
    expect(description().value).toBe('my own voice');
    rerender(
      <VoiceCatalogEditor model={model({ voiceCatalog: seededVoice() })} onSaved={() => {}} />,
    );
    expect(description().value).toBe('seeded');
  });

  it('the generation params editor re-seeds the form from the reloaded spec', () => {
    const { rerender } = render(
      <GenerationParamsEditor model={model({ generationParams: seededSpec() })} onSaved={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /generation parameters/i }));
    const values = () =>
      screen.getByPlaceholderText(/comma-separated/i) as HTMLInputElement;
    fireEvent.change(values(), { target: { value: '1:1' } });
    expect(values().value).toBe('1:1');
    rerender(
      <GenerationParamsEditor model={model({ generationParams: seededSpec() })} onSaved={() => {}} />,
    );
    expect(values().value).toBe('16:9');
  });
});
