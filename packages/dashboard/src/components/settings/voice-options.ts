// Settings > Voice: the listening-sensitivity options, speech-model labels and the byte formatter (moved out of VoiceTab unchanged).

export const VAD_OPTIONS: Array<{ id: 'quick' | 'normal' | 'patient'; label: string; hint: string }> = [
  { id: 'quick',   label: 'Quick',   hint: 'Jumps in fast, best for quick back-and-forth' },
  { id: 'normal',  label: 'Normal',  hint: 'Balanced, waits a beat for you to finish a thought' },
  { id: 'patient', label: 'Patient', hint: 'Waits longest, best for slow, thoughtful speech' },
];

export const STT_LABELS: Record<string, string> = {
  'moonshine-base':  'Moonshine base · English only · fastest, no native deps (default)',
  'base.en':         'Whisper Base · English only · fast, lower quality',
  'small.en':        'Whisper Small · English only',
  'medium.en':       'Whisper Medium · English only',
  'large-v3-turbo':  'Whisper Large v3 Turbo · multilingual',
};

export function formatBytes(b: number): string {
  if (!b) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(0)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** A key that moves a slider; the setting saves when one is released, as it does when the mouse or a finger lets go. */
export const movesSlider = (key: string): boolean => /^(Arrow|Page)/.test(key) || key === 'Home' || key === 'End';
