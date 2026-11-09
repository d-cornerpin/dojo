// Settings > Voice: a control's save-refusal sentence, shown through the dashboard's existing toast.

const NAMES: Record<string, string> = {
  engine: 'Voice engine', voice: 'Voice', speed: 'Playback speed', cloud_voice: 'Cloud voice',
  cloud_desc: 'Cloud voice description', cloud_speed: 'Cloud playback speed', vad: 'Listening sensitivity',
  barge: 'Voice interrupt', sfx: 'Sound effects', wake: 'Wake word', stt: 'Speech recognition model',
};

export const voiceSaveRefusal = (uiKey: string, error?: string): string =>
  `${NAMES[uiKey] ?? 'That setting'} was not saved: ${error ?? 'the server refused it'}`;
