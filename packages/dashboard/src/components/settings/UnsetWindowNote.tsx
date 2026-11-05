// M41: a model whose context window is not set (NULL) says so on its row, names the figure the
// engine budgets with until it is set, and the sentence is the way into the existing Model Limits
// editor on the same card (it puts the cursor in the Context field). No new screen. A provider sync
// no longer invents a window, so "not set" is a real state the row must not hide.
import type { Model } from '@dojo/shared';

/** The id of a model card's Context field, so the note above it can land the cursor there. */
export const contextInputId = (modelId: string): string => `model-context-${modelId}`;

// Capabilities of a model that reads and writes text, so a context window applies to it. A model whose
// capabilities are not known yet is treated as one (the probe has not run); image, video, audio, music,
// transcription and embedding models carry none of these and have no text context to report.
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
