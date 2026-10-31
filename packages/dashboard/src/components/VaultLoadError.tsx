/** The vault list could not be loaded: say so, with a way to ask again. */
export const VaultLoadError = ({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <div className="note--warn" role="alert">
    Could not load vault entries: {message}{' '}
    <button type="button" className="btn btn--sm" onClick={onRetry}>Retry</button>
  </div>
);
