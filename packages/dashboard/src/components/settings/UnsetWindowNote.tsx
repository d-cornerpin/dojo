// Settings → a model row's note for a context window the provider never reported.
import type { Model } from '@dojo/shared';

/** The id of a model card's Context field, so the note above it can land the cursor there. */
export const contextInputId = (modelId: string): string => `model-context-${modelId}`;

// Text capabilities; a model with none recorded yet counts as text-capable (the probe has not run).
const TEXT_CAPABILITIES = new Set(['chat', 'text', 'code', 'tools', 'thinking', 'vision', 'analysis']);

export const UnsetWindowNote = ({ model }: { model: Model }) => {
  if (model.contextWindow) return null;
  if (model.capabilities.length > 0 && !model.capabilities.some((c) => TEXT_CAPABILITIES.has(c))) return null;
  return (
    <>
      {' | '}
      <button
        type="button"
        className="underline text-cp-amber hover:text-cp-amber/80"
        onClick={() => document.getElementById(contextInputId(model.id))?.focus()}
      >
        context not reported by the provider, set it
      </button>
      {model.assumedContextWindow
        ? ` (using ${Math.round(model.assumedContextWindow / 1000)}k until you set it)`
        : ''}
    </>
  );
};
