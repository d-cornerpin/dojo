// The server's own "this install failed" word (the `voice:model_install_error` frame). Screens
// that hear that frame hand it here, so a waiting install ends on the real signal, never a clock.
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
export const VOICE_INSTALL_RESTARTED = 'The connection to Dojo was lost during the download, and when it came back the model was not installed. Start the download again.';
