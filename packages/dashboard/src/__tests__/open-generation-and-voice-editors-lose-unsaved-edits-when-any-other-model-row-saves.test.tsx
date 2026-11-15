// Settings > Models: a half-typed Generation parameters / Voices editor survives a reload
// that brings back the same saved content as brand-new objects.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  return stub;
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const t = fakeToast();
  return { useToast: () => t.value, ToastProvider: ({ children }: { children: ReactElement }) => children };
});

import { VoiceCatalogEditor, GenerationParamsEditor } from '../components/settings/ModelRows';

const base = { id: 'm1', name: 'm1', apiModelId: 'm1', providerId: 'p', capabilities: ['chat'], isEnabled: true } as const;
const voices = () => [{ id: 'a', description: 'x', gender: 'male' }];
const params = () => ({ duration: { accepted: true, values: [5, 10], default: 5, wireField: 'd', wireType: 'number' } });

describe('open editors keep unsaved edits', () => {
  it('the voices editor keeps a typed id when an equal new model object arrives', () => {
    const model = { ...base, voiceCatalog: voices() } as never;
    const { rerender } = render(<VoiceCatalogEditor model={model} onSaved={() => {}} />);
    fireEvent.click(screen.getByText(/Voices/));
    fireEvent.change(screen.getByDisplayValue('a'), { target: { value: 'typed-id' } });
    rerender(<VoiceCatalogEditor model={{ ...base, voiceCatalog: voices() } as never} onSaved={() => {}} />);
    expect(screen.getByDisplayValue('typed-id')).toBeTruthy();
  });

  it('the generation parameters editor keeps a typed value when an equal new model object arrives', () => {
    const model = { ...base, generationParams: params() } as never;
    const { rerender } = render(<GenerationParamsEditor model={model} onSaved={() => {}} />);
    fireEvent.click(screen.getByText(/Generation parameters/));
    fireEvent.change(screen.getByDisplayValue('5, 10'), { target: { value: '5, 10, 15' } });
    rerender(<GenerationParamsEditor model={{ ...base, generationParams: params() } as never} onSaved={() => {}} />);
    expect(screen.getByDisplayValue('5, 10, 15')).toBeTruthy();
  });
});
