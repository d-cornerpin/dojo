// Settings > Voice: the sentence shown when the server refuses to store a control's value.
// The message clears when the next save succeeds or after a few seconds.

import { useState, useEffect, useRef, useCallback } from 'react';

const NAMES: Record<string, string> = {
  engine: 'Voice engine', voice: 'Voice', speed: 'Playback speed', cloud_voice: 'Cloud voice',
  cloud_desc: 'Cloud voice description', cloud_speed: 'Cloud playback speed', vad: 'Listening sensitivity',
  barge: 'Voice interrupt', sfx: 'Sound effects', wake: 'Wake word', stt: 'Speech recognition model',
};
const SHOW_MS = 6000;

export const useVoiceSaveError = () => {
  const [saveError, setSaveError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /** Record the outcome of a save; returns true when it was stored. */
  const noteSave = useCallback((uiKey: string, res: { ok: boolean; error?: string }): boolean => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (res.ok) { setSaveError(null); return true; }
    setSaveError(`${NAMES[uiKey] ?? 'That setting'} was not saved: ${res.error ?? 'the server refused it'}`);
    timer.current = setTimeout(() => setSaveError(null), SHOW_MS);
    return false;
  }, []);

  return { saveError, noteSave };
};
