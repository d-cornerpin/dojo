// The server's own "this install failed" word (the `voice:model_install_error` frame). The screens
// that already listen for that frame hand it here, so a waiting install ends on the real signal
// instead of a clock (R25: no fixed give-up).
const failures = new Map<string, string>();
export const noteVoiceInstallFailure = (kind: string, modelId: string, reason: string): void => {
  failures.set(`${kind}/${modelId}`, reason);
};
export const takeVoiceInstallFailure = (kind: string, modelId: string): string | undefined => {
  const k = `${kind}/${modelId}`;
  const v = failures.get(k);
  failures.delete(k);
  return v;
};
export const clearVoiceInstallFailure = (kind: string, modelId: string): void => { failures.delete(`${kind}/${modelId}`); };
