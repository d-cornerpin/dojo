// ════════════════════════════════════════════════════════════════════════════════════
// M41 — A MODEL WHOSE WINDOW IS NOT SET SAYS SO ON ITS ROW, AND NAMES THE FIGURE IN USE.
//
// A provider sync no longer invents a window for a model the provider says nothing about; the row
// is stored as "not set" (NULL). A silent NULL would be the old guess in a new coat, so the row
// says it plainly: "context not reported by the provider — set it", with the figure the engine
// budgets with until then, and the sentence is the way into the existing Model Limits editor
// (it lands the cursor in the Context field). No new screen.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Model } from '@dojo/shared';

vi.mock('../../../hooks/useToast', () => ({
  useToast: () => ({ success: () => {}, error: () => {} }),
  ToastProvider: ({ children }: { children: ReactElement }) => children,
}));

import { ModelRow } from '../ModelRows';

const model = (over: Partial<Model>): Model => ({
  id: 'm1', providerId: 'prov', name: 'Some Model', apiModelId: 'some-model', capabilities: ['chat'],
  contextWindow: null, maxOutputTokens: null, inputCostPerM: 0.14, outputCostPerM: 0.28,
  pricingUnit: 'token', costPerUnit: null, costPerMegapixel: null, priceUnknown: false,
  isEnabled: true, thinkingEnabled: true, numCtxOverride: null, numCtxRecommended: null,
  generationParams: null, voiceCatalog: null, createdAt: '', updatedAt: '',
  ...over,
} as Model);

const draw = (m: Model) => render(
  <ModelRow model={m} providerType="openai-compatible" isPrimaryModel={false} onToggle={() => {}} onPricingChange={() => {}} />,
);

describe('M41 — the model row says when the window is not set', () => {
  it('a NULL window reads "context not reported by the provider — set it" and names the figure in use', () => {
    draw(model({ contextWindow: null, assumedContextWindow: 200_000 }));
    expect(screen.getByText(/context not reported by the provider/i)).toBeTruthy();
    expect(screen.getByText(/using 200k until you set it/i)).toBeTruthy();
  });

  it('the sentence opens the existing Model Limits editor: the Context field takes focus', () => {
    draw(model({ contextWindow: null, assumedContextWindow: 200_000 }));
    fireEvent.click(screen.getByRole('button', { name: /context not reported by the provider/i }));
    expect(document.activeElement).toBe(screen.getByLabelText(/^Context$/));
  });

  it('a stored window shows as before, with no "not reported" line', () => {
    draw(model({ contextWindow: 262_144, assumedContextWindow: null }));
    expect(screen.getByText(/262k context/)).toBeTruthy();
    expect(screen.queryByText(/not reported by the provider/i)).toBeNull();
  });

  it('a NULL window with no figure from the server still says it is not set, and invents no number', () => {
    draw(model({ contextWindow: null }));
    expect(screen.getByText(/context not reported by the provider/i)).toBeTruthy();
    expect(screen.queryByText(/using .*k until/i)).toBeNull();
  });
});
