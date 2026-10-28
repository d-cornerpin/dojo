import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// Each name is an export that nothing outside its own definition calls. Read the
// source as text and the `export` declaration must be gone. The ten service
// files sit beside this test; ws.ts lives one level up in gateway.
const pairs: Array<{ file: string; name: string }> = [
  { file: '../decision-window.ts', name: 'decisionWindowSettled' },
  { file: '../audio-gen-model.ts', name: 'getConfiguredAudioGenModelId' },
  { file: '../image-gen-model.ts', name: 'getConfiguredImageGenModelId' },
  { file: '../music-gen-model.ts', name: 'getConfiguredMusicGenModelId' },
  { file: '../video-gen-model.ts', name: 'getConfiguredVideoGenModelId' },
  { file: '../transcription-model.ts', name: 'getConfiguredTranscriptionModelId' },
  { file: '../../gateway/ws.ts', name: 'getConnectedClientCount' },
  { file: '../gmail-watcher.ts', name: 'isGmailWatcherRunning' },
  { file: '../outlook-watcher.ts', name: 'isOutlookWatcherRunning' },
  { file: '../teams-watcher.ts', name: 'isTeamsWatcherRunning' },
  { file: '../transcription.ts', name: 'LOCAL_TRANSCRIPTION_MODEL_ID' },
];

describe('no dead exports in services', () => {
  for (const { file, name } of pairs) {
    it(`${file} no longer exports ${name}`, () => {
      const text = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(text).not.toMatch(new RegExp('export\\s+(async\\s+)?(function|const)\\s+' + name + '\\b'));
    });
  }
});
