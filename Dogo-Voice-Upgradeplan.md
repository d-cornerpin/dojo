# DOJO Voice Mode — Upgrade Plan

End-to-end implementation plan for adding a real-time voice conversation interface to the DOJO. Self-hosted stack (no API keys, no data leaves the Mac Mini). Step-by-step, written to be executed in order.

## ⚠️ EXECUTION RULES — READ FIRST

**This build is LOCAL DEV ONLY until the user has tested.**

- ✅ Edit files in the working tree, install npm packages, run/restart the dev server at `localhost:3001`, smoke-test with the `dev-test-tools/bin/` harness.
- ❌ **DO NOT `git commit`.**
- ❌ **DO NOT `git push`.**
- ❌ **DO NOT `gh release create`.**
- ❌ **DO NOT bump version numbers in any `package.json`.**
- ❌ **DO NOT run `npm run build:package` for distribution.**

The user will explicitly say "ship it" / "push and release" only AFTER they have tested voice mode hands-on in the dev server. Until then, everything stays uncommitted. This is the same protocol used for prior risky changes (v2.5.46 close-out enforcement, etc.).

## Goal

A "voice mode" toggle button next to the existing chat-window buttons (Wordy / Reset). When toggled on, the user can have a fluid spoken conversation with their primary agent (default: Kevin). The system continuously listens, detects when the user has finished speaking, transcribes locally, sends the prompt through the existing chat pipeline, and reads the streamed response back via local TTS. Barge-in supported (user can interrupt while the agent is speaking).

## Stack

| Component | Choice | License | Runs |
|---|---|---|---|
| STT | whisper.cpp + `large-v3-turbo` (quantized) | MIT | Mac Mini, Metal-accelerated |
| VAD / endpointing | `@ricky0123/vad-web` (silero-vad in browser via ONNX) | MIT | Browser |
| TTS | `kokoro-js` (Kokoro-82M, StyleTTS2-derived) | Apache 2.0 | Mac Mini, CPU |
| Transport | Existing WebSocket gateway (binary frames for audio) | — | — |

No new ports, no third-party services. Everything stays on the box.

## Architecture

```
┌─────────────── BROWSER ───────────────┐         ┌────────────── SERVER ──────────────┐
│                                       │         │                                    │
│  Mic ─► MediaStream ─► AudioWorklet   │         │  WebSocket gateway                 │
│                       │               │         │  ├─ /voice/stt (audio in)          │
│                       ▼               │ Audio  ─┤  │   ↓                             │
│  silero VAD ──► detect speech start/end │ frames │  │   whisper.cpp (subprocess)     │
│       │                                │ ─────► │  │   ↓ text                       │
│       └─► on end: send buffered PCM    │        │  │   api.sendMessage (existing)   │
│                                        │        │  └─ /voice/tts (audio out)         │
│  AudioBufferSourceNode queue ◄─────────┤ Audio  │      ↑ PCM chunks                  │
│       ↑                                │ frames │      kokoro-js synthesizeStream    │
│       │ on barge-in: cancel queue      │ ◄───── │      ↑ text chunks                 │
│                                        │        │      chat:chunk subscription       │
└────────────────────────────────────────┘        └────────────────────────────────────┘
```

Voice mode is a thin layer over the existing chat pipeline. STT replaces typing; TTS replaces reading. Everything else (assembler, model call, streaming, tool calls, tracker, etc.) is untouched.

---

## Phase 1 — Backend infrastructure

### 1.1 whisper.cpp binary

- [ ] Add `deploy/voice/build-whisper.sh` that clones whisper.cpp, builds with Metal (`make WHISPER_METAL=1`), and copies the `main` and `stream` binaries into `deploy/voice/bin/whisper-cli` and `whisper-stream`.
- [ ] Update `deploy/build-package.sh` to include `deploy/voice/bin/*` in the package.
- [ ] Update `deploy/install.sh` to copy these binaries to `~/.dojo/voice/bin/` on install. Chmod +x. Validate they execute (`whisper-cli --help`).
- [ ] Document the build dependency (Xcode CLT) in install.sh preflight check.

### 1.2 Model downloader service

New file: `packages/server/src/voice/model-manager.ts`

- [ ] `ensureWhisperModel(size)` — checks `~/.dojo/voice/models/whisper-{size}.bin`, downloads from huggingface.co/ggerganov/whisper.cpp if missing. Streams progress via a new WS event `voice:model_download` (`{ model, bytesDownloaded, bytesTotal }`).
- [ ] `ensureKokoroModel()` — same pattern for the Kokoro ONNX model (`~/.dojo/voice/models/kokoro-v1.onnx`).
- [ ] `listInstalledModels()` — returns sizes on disk for the Settings tab.
- [ ] `deleteModel(kind, size)` — for the "re-download" button.

### 1.3 STT service (Whisper wrapper)

New file: `packages/server/src/voice/stt-service.ts`

- [ ] On boot, spawn whisper.cpp in "server mode" (`whisper-cli --server` if available, else spawn per-request) with the user's chosen model. Keep warm.
- [ ] `transcribePCM(pcmBuffer): Promise<string>` — sends the audio buffer to the running whisper process, returns the transcribed text. Streaming partials are optional polish (Phase 5).
- [ ] Handle whisper process crashes — auto-restart with exponential backoff.

### 1.4 TTS service (Kokoro wrapper)

New file: `packages/server/src/voice/tts-service.ts`

- [ ] `npm install kokoro-js` in `packages/server`.
- [ ] On boot, load the Kokoro model into memory once (lazy — only when first voice session opens).
- [ ] `synthesizeStream(textStream, voice): AsyncIterable<Buffer>` — wraps Kokoro's `TextSplitterStream`. Yields PCM/WAV chunks per sentence.
- [ ] `cancelStream(streamId)` — for barge-in.

### 1.5 Voice WebSocket endpoints

Extend `packages/server/src/gateway/ws.ts`:

- [ ] Define new event types: `voice:stt_start`, `voice:stt_partial`, `voice:stt_final`, `voice:tts_chunk`, `voice:tts_end`, `voice:model_download`, `voice:barge_in`.
- [ ] Add a binary frame path for incoming audio (browser → server) and outgoing audio (server → browser). Keep JSON envelope for control messages.
- [ ] New session model: `voiceSessions: Map<agentId, VoiceSession>` tracks active conversations, the inflight STT job, and the inflight TTS stream so we can cancel them on barge-in.

### 1.6 Wire voice STT result into existing chat pipeline

- [ ] When `voice:stt_final` fires, call the existing `api.sendMessage` (`POST /chat/:agentId/messages`) internally — no special path needed. The transcribed text enters the chat pipeline exactly as a typed message would.
- [ ] Tag the message with a `source: 'voice'` field so the dashboard can render a small mic icon on voice-originated messages (cosmetic).

### 1.7 Wire chat:chunk events into TTS

- [ ] When a voice session is active for an agent, the server subscribes its own `chat:chunk` broadcast for that agent.
- [ ] Pipe the text chunks into `synthesizeStream`. Stream the PCM output back to the client as `voice:tts_chunk` binary frames.
- [ ] On `chat:chunk` `done: true`, emit `voice:tts_end`.

---

## Phase 2 — Frontend voice client

### 2.1 Voice client module

New file: `packages/dashboard/src/lib/voice/voice-client.ts`

- [ ] `npm install @ricky0123/vad-web` in `packages/dashboard`. Configure Vite to bundle the `.onnx` and `ort-wasm-*.wasm` assets via `vite-plugin-static-copy` (or `?url` imports).
- [ ] `class VoiceClient` with state machine: `IDLE → LISTENING → CAPTURING → TRANSCRIBING → WAITING_FOR_AGENT → SPEAKING → (back to LISTENING)`.
- [ ] Methods: `start()`, `stop()`, `toggle()`, `cancelPlayback()` (barge-in).
- [ ] Events emitted: `state-change`, `partial-transcript`, `final-transcript`, `tts-start`, `tts-end`, `error`.
- [ ] Internally manages:
  - `MicVAD.new({ onSpeechStart, onSpeechEnd })`
  - WebSocket connection to `/voice` endpoints
  - `AudioBufferSourceNode` queue for TTS playback

### 2.2 Audio capture + upload

- [ ] On `onSpeechStart`: transition to CAPTURING. Buffer PCM frames locally (AudioWorklet downsamples to 16kHz mono Int16, which is what Whisper expects).
- [ ] On `onSpeechEnd`: emit `voice:stt_start` over WS, then stream the buffered PCM as binary frames, then `voice:stt_final` signal (could be implicit via stream close).
- [ ] Transition to TRANSCRIBING. On `voice:stt_final` from server: transition to WAITING_FOR_AGENT.

### 2.3 TTS playback queue

- [ ] Subscribe to `voice:tts_chunk` binary frames.
- [ ] Decode each chunk as an `AudioBuffer` (Kokoro returns 24kHz mono PCM).
- [ ] Queue using chained `AudioBufferSourceNode`s — each `node.onended` triggers the next.
- [ ] On `voice:tts_end`: transition back to LISTENING.

### 2.4 Barge-in handling

- [ ] When `MicVAD.onSpeechStart` fires while state is `SPEAKING`:
  1. Immediately call `audioContext.currentTime`-based stop on the active source node.
  2. Empty the local queue of pending buffers.
  3. Emit `voice:barge_in` to the server.
  4. Server: cancel the TTS stream (kokoro `cancelStream`), and optionally cancel the inflight LLM call via the existing `stopAgent` mechanism so we don't burn tokens on a response the user is overriding.
  5. Transition to CAPTURING (user is now speaking; we'll send their new utterance on `onSpeechEnd`).

### 2.5 React hook

New file: `packages/dashboard/src/hooks/useVoiceMode.ts`

- [ ] Wraps `VoiceClient`. Returns `{ enabled, state, error, toggle, currentTranscript, currentTTSText }`.
- [ ] Persists "enabled" to localStorage so voice mode survives reload (if the user wants).
- [ ] Cleans up on unmount.

---

## Phase 3 — UI

### 3.1 Voice mode toggle button (chat window)

Edit: `packages/dashboard/src/components/ChatInput.tsx` (~line 319, right after Wordy and Reset buttons)

- [ ] Add a new button using the same `w-9 h-9 rounded-full` pattern.
- [ ] Icon: microphone (lucide-react `Mic`) when off, `MicOff` when on, animated waveform when active.
- [ ] Color states:
  - OFF: `bg-ui/[0.08] text-ui/25`
  - LISTENING (ready): `bg-cp-teal/20 text-cp-teal` with subtle pulse
  - CAPTURING (user speaking): `bg-cp-teal/30 text-cp-teal` with stronger pulse
  - SPEAKING (Kevin talking): `bg-cp-coral/20 text-cp-coral`
- [ ] Tooltip reflects state.
- [ ] Wire `onClick` to `useVoiceMode().toggle()`.

### 3.2 Voice mode status banner (chat window)

- [ ] When voice mode is active, render a thin status bar below the chat input showing:
  - Current state ("Listening...", "Transcribing...", "Kevin is speaking...")
  - Live partial transcript while user is talking
  - Volume bars (small visualizer) so the user knows the mic is hearing them
- [ ] Single-line, dismissible. Same channel-pattern styling as other status pills.

### 3.3 Settings → Voice tab

Edit: `packages/dashboard/src/pages/Settings.tsx`

- [ ] Add a new "Voice" tab in the Settings sidebar. Icon: microphone.
- [ ] Tab contents:
  - **Voice for Kevin** — picker (~20 English presets + 9 other languages). Each option has a "preview" button that synthesizes a short sample. Default: `am_michael`.
  - **VAD sensitivity** — slider with three labeled stops: "Quick" (200ms silence) / "Normal" (500ms, default) / "Patient" (1000ms). Labeled with a hint about what each does.
  - **STT model** — dropdown: `base.en` (75MB, fast, lower quality) / `small.en` (240MB) / `medium.en` (1.5GB) / `large-v3-turbo` (800MB, default — best quality + reasonable speed).
  - **Playback speed** — slider 0.8x to 1.4x. Default 1.0x.
  - **Re-download models** — button per model (Whisper, Kokoro). Shows disk space used.
  - **Disk space used by voice** — small text at bottom showing total MB.

### 3.4 OOBE Voice setup page

Edit: `packages/dashboard/src/pages/Setup.tsx` (and wire into the wizard flow)

- [ ] Add a new step after the existing setup steps: "Voice mode (optional)".
- [ ] Page layout:
  - Title: "Talk to Kevin"
  - Subtitle: "Optional — set up voice mode so you can have spoken conversations with your primary agent."
  - **Step 1: Permission.** "We need microphone access." Click → browser mic permission prompt. Once granted, show a green check.
  - **Step 2: Download voice models.** Two progress bars (Whisper + Kokoro). "These run on your Mac. About 1GB total, downloads once." Skippable.
  - **Step 3: Pick a voice.** Same picker as Settings, with preview buttons.
  - **Step 4: Test it.** "Say 'Hello Kevin' and watch the indicator." Live transcript + Kevin's reply spoken back.
  - "Skip for now" button at the bottom — user can set it up later in Settings.

---

## Phase 4 — First-run download flow

### 4.1 Auto-download on first toggle

- [ ] When user toggles voice mode on for the first time and models aren't installed:
  - Show inline modal: "First-time setup — downloading voice models (~1GB)..."
  - Two progress bars driven by `voice:model_download` events.
  - "Run in background" button — modal collapses to a small status pill in the corner.
  - On complete: toast "Voice mode ready", proceed to LISTENING state.

### 4.2 Disk space awareness

- [ ] Reject download if free disk < 2GB. Show clear error.
- [ ] Settings → Voice shows current usage.

---

## Phase 5 — Polish

### 5.1 Streaming partial transcripts

- [ ] Implement whisper.cpp streaming mode (rolling-window inference every ~500ms while user speaks).
- [ ] Emit `voice:stt_partial` events with the running transcript.
- [ ] Show partial transcript live in the status banner as the user speaks.
- [ ] On `onSpeechEnd`, finalize with one last inference covering the tail.
- [ ] Reduces perceived STT latency from ~400ms to ~150ms.

### 5.2 LLM cancellation on barge-in

- [ ] When `voice:barge_in` fires, call the existing `stopAgent(agentId)` mechanism to abort the inflight model call.
- [ ] Saves tokens; prevents Kevin from finishing a thought the user is overriding.

### 5.3 Backchannels (low priority)

- [ ] Detect very short user utterances ("mm-hmm", "yeah", "ok") and don't send them as new prompts — just continue the conversation context.
- [ ] Pattern: if transcript is one or two words AND a tracker_get_response is currently in flight, treat as backchannel and don't preempt.

### 5.4 Voice-source visual marker on chat bubbles

- [ ] If a message has `source: 'voice'`, render a small mic icon on the user bubble so it's clear which messages came from voice vs typing.

### 5.5 Mobile compatibility note

- [ ] On iOS Safari, audio autoplay requires user gesture. The "toggle" click counts. Document this.
- [ ] Android Chrome works the same as desktop.

### 5.6 Wake word (explicitly NOT building)

- [ ] No wake word. Voice mode is an explicit toggle. If we ever want wake-word, that's a future phase (Picovoice Porcupine free tier or similar).

---

## Phase 6 — Testing checklist

Before push/release:

- [ ] End-to-end conversation: toggle on, ask Kevin a trivial question, hear the reply, ask a follow-up. Verify state transitions in DevTools.
- [ ] Barge-in: ask a question that triggers a long response, interrupt mid-stream. Verify Kevin stops talking immediately and your new utterance is captured.
- [ ] Multi-turn: 5-message back-and-forth, verify no stuck states.
- [ ] Model download UX: install on a fresh machine (or delete `~/.dojo/voice/models/`), toggle voice on, verify download progress UI.
- [ ] Settings: change voice, change VAD sensitivity, change STT model, restart server, verify it sticks.
- [ ] Disk-space rejection: simulate low disk, verify error UX.
- [ ] Reset: voice mode active, user resets session, verify clean handoff (TTS cancels, state returns to LISTENING after the reset message).
- [ ] Network drop: WS disconnect mid-conversation, verify reconnect and state recovery.
- [ ] Long utterance: 30+ second monologue, verify it transcribes correctly and doesn't time out.
- [ ] Quiet room: VAD doesn't false-positive on ambient noise.
- [ ] Noisy room: VAD still works on background music / typing.

---

## Acceptance criteria (when this ships)

- User can toggle voice mode from the chat window. State transitions are visible.
- After first-time model download, conversation feels fluid — <1.5s from "I stop talking" to "Kevin starts talking" on the M1 Mac Mini.
- Barge-in works: user can interrupt Kevin mid-sentence, Kevin stops immediately, user's new utterance becomes the next prompt.
- All settings persist across server restarts.
- No API keys required. No data leaves the Mac Mini.
- OOBE flow guides new users through setup; existing users can skip via Settings.
- Voice mode survives session resets, agent restarts, and WS reconnects gracefully.

---

## File-level change summary

**New files:**
- `deploy/voice/build-whisper.sh`
- `packages/server/src/voice/model-manager.ts`
- `packages/server/src/voice/stt-service.ts`
- `packages/server/src/voice/tts-service.ts`
- `packages/dashboard/src/lib/voice/voice-client.ts`
- `packages/dashboard/src/hooks/useVoiceMode.ts`

**Modified files:**
- `packages/server/src/gateway/ws.ts` — new voice event types + binary frame handling
- `packages/server/package.json` — add `kokoro-js`
- `packages/dashboard/package.json` — add `@ricky0123/vad-web`
- `packages/dashboard/vite.config.ts` — bundle silero ONNX + ort-wasm assets
- `packages/dashboard/src/components/ChatInput.tsx` — voice toggle button + status banner
- `packages/dashboard/src/pages/Settings.tsx` — Voice tab
- `packages/dashboard/src/pages/Setup.tsx` — OOBE voice setup page
- `deploy/build-package.sh` — include voice binaries
- `deploy/install.sh` — install voice binaries, preflight Xcode CLT

**DB/schema:** no changes. Voice config stored in existing `config` table (key prefix `voice.*`) or in agent.config JSON.

---

## Rollout strategy

1. Ship Phase 1 + 2 + 3.1 (backend + client + toggle button only). Internal test on dev for a few days.
2. Add Phase 3.3 (Settings tab) and Phase 4 (download flow). Ship as v2.5.x.
3. Add Phase 3.4 (OOBE page) once Phase 1-3 are stable on prod.
4. Phase 5 polish ships incrementally as needed.

**Total estimated effort:** ~3-5 sessions of focused work. Phase 1 + 2 is the heavy lift; Phase 3-5 are mostly wiring and UX.

---

## Open questions to revisit during build

- Whisper "server mode" — confirm whisper.cpp's latest server binary supports keeping a model loaded and accepting audio over stdin/socket. If not, fall back to per-request spawn (adds ~500ms latency, may still be fine).
- Kokoro voice previews — do we ship a pre-generated WAV per voice, or generate on demand? Pre-generated is faster UX, ~10MB of extra package size.
- VAD calibration — silero defaults work for most rooms, but very quiet rooms may need a lower energy threshold. Decide whether to expose this or auto-calibrate.
- Cross-tab voice mode — if user opens two dashboard tabs, should voice mode be exclusive? Probably yes; emit an error if voice is already active in another tab.

---

## Reference Appendix (technical specifics needed during build)

### Current dev environment state (confirmed 2026-05-18)

- Dev machine: MacBook Pro Apple M3 Max → Metal acceleration supported for whisper.cpp.
- `whisper`, `whisper-cli` are **NOT** installed on dev. Need to install via `brew install whisper-cpp` or build from source.
- ~102Gi free disk — plenty for models.
- The dashboard has NO existing audio / mic / WebAudio code — clean slate.

### Exact integration points in codebase

These were verified by an Explore agent — re-verify if line numbers have drifted:

**1. Toolbar location:** `packages/dashboard/src/components/ChatInput.tsx` ~line 319, right after the existing Wordy Mode toggle and New Session reset button. Existing buttons use this pattern (copy it):
```jsx
<button
  type="button"
  onPointerDown={(e) => e.preventDefault()}
  onClick={handler}
  title="..."
  className={`shrink-0 flex items-center justify-center w-9 h-9 rounded-full transition-all ${
    active
      ? 'bg-cp-purple/20 text-cp-purple'
      : 'bg-ui/[0.08] text-ui/25 hover:text-ui/55'
  }`}
>
  {/* SVG icon */}
</button>
```

**2. Send-message API:** `packages/dashboard/src/lib/api.ts` lines ~335-344:
```typescript
export const sendMessage = async (
  agentId: string, content: string, attachments?: AttachmentInfo[],
): Promise<ApiResponse<SendMessageResponse>> => {
  return request<SendMessageResponse>(`/chat/${agentId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, attachments: attachments?.length ? attachments : undefined }),
  });
};
```
Voice → transcribed text → call this exact function. No new endpoint needed.

**3. WebSocket subscribe hook:** `packages/dashboard/src/hooks/useWebSocket.ts` ~lines 192-210. Pattern:
```typescript
const { subscribe } = useWebSocket();
useEffect(() => {
  const unsub = subscribe('eventName', (event: WsEvent) => { /* handle */ });
  return unsub; // cleanup on unmount
}, [subscribe]);
```

**4. Streaming response event:** `chat:chunk` events arrive with shape `{ agentId, messageId, content: string, done: boolean }`. The text chunks are deltas (append, don't replace). Subscribe at Chat.tsx ~line 532-596 is the canonical example. For TTS, subscribe to the same event and pipe `content` into the TTS stream as it arrives.

**5. Server WS gateway:** `packages/server/src/gateway/ws.ts`. Existing event types are listed there; add the new `voice:*` types alongside.

**6. Existing send/preempt mechanism for barge-in:** `packages/server/src/agent/runtime.ts` has `preemptAgentForUrgentMessage(agentId)` (called by chat route on new user msg) and a `stopAgent(agentId)` mechanism somewhere (search for `stoppedAgents.add`). Use one of these to abort the inflight model call on barge-in.

### Library specifics

**STT — whisper.cpp:**
- Repo: `https://github.com/ggerganov/whisper.cpp`
- Build for Apple Silicon: `make WHISPER_METAL=1`
- Models live at `https://huggingface.co/ggerganov/whisper.cpp/tree/main`
- Recommended model: `ggml-large-v3-turbo-q5_0.bin` (~570MB, best quality/speed balance on M-series). Fallback: `ggml-base.en.bin` (~75MB) for slower machines.
- Audio format Whisper expects: **16kHz mono Int16 PCM**. AudioWorklet on the client must downsample from the browser's typical 48kHz.
- Streaming binary: `./stream -m models/ggml-...bin -t 4` reads PCM from stdin and emits transcribed text on stdout. Probably not what we want for our use case — we'll use the regular CLI with a buffered audio file per utterance for simplicity, and revisit streaming as a Phase 5 optimization.
- Per-utterance call: `./whisper-cli -m models/ggml-...bin -f /tmp/utterance.wav --output-json` returns JSON.

**TTS — Kokoro:**
- npm package: `kokoro-js` (latest as of 2026)
- Apache 2.0, ~330MB model
- Voice presets follow the format `{lang}{gender}_{name}` where lang is `a`=American English, `b`=British English, `e`=Spanish, `f`=French, `h`=Hindi, `i`=Italian, `j`=Japanese, `p`=Portuguese, `z`=Mandarin. gender is `f` or `m`.
- Common English voices: `am_michael`, `am_adam`, `am_eric`, `am_liam`, `am_onyx`, `am_puck`, `af_bella`, `af_nicole`, `af_aoede`, `af_sky`, `af_sarah`, `bm_george`, `bm_lewis`, `bm_fable`, `bf_emma`, `bf_isabella`, `bf_alice`, `bf_lily`. Confirm available presets at runtime via `KokoroTTS.list_voices()` or similar.
- Output format: 24kHz mono Float32. Convert to AudioBuffer in the browser for playback.
- Streaming API: pass a `TextSplitterStream` (an `AsyncIterable<string>`) to `synthesizeStream`, get back an `AsyncIterable<AudioBuffer>` — yields one chunk per sentence as text arrives.

**VAD — @ricky0123/vad-web:**
- npm package: `@ricky0123/vad-web`
- MIT license
- Bundles silero VAD as ONNX model. Vite config needs to expose the `.onnx` + `ort-wasm-*.wasm` static assets so the browser can fetch them. Use `vite-plugin-static-copy` or `?url` imports.
- API: `MicVAD.new({ onSpeechStart, onSpeechEnd: (audio) => {...} })`. The `onSpeechEnd` callback receives a `Float32Array` of the captured audio at 16kHz mono — perfect for forwarding to Whisper after a simple Int16 conversion.
- Speech-end threshold defaults: silence detection at ~500ms by default. Configurable via constructor options like `redemptionFrames`, `minSpeechFrames`, `positiveSpeechThreshold`, `negativeSpeechThreshold`.

### Audio format pipeline summary

```
Browser mic (typically 48kHz f32) → AudioWorklet downsample → 16kHz mono Int16
  → silero VAD endpointing → on speech end, pack as WAV (or send as raw PCM with header)
  → WebSocket binary frame → server
  → write to temp file → whisper-cli inference → JSON output
  → text → api.sendMessage internally → chat:chunk events fire as usual
  → server subscribes its own chat:chunk → pipe to kokoro synthesizeStream
  → 24kHz f32 audio chunks → WebSocket binary back to browser
  → decodeAudioData → queue as AudioBufferSourceNode chain → play
  → on user voice start (silero): cancel chain (barge-in), cancel server-side TTS+LLM
```

### What I'd do FIRST after compaction

If continuing this build from a fresh context, in order:

1. Read this file end to end.
2. `ls ~/.dojo/voice/` — see if any prior work exists.
3. Check `packages/server/package.json` and `packages/dashboard/package.json` for `kokoro-js` and `@ricky0123/vad-web` — install only if missing.
4. `which whisper-cli` — if missing, `brew install whisper-cpp`.
5. Start with Phase 1.2 (model-manager.ts) as the first new file; it has no dependencies.
6. Then Phase 1.4 (tts-service.ts) — get a "synthesize 'hello world'" round-trip working server-side before any UI.
7. Then Phase 1.3 (stt-service.ts) — get "transcribe a wav file" working server-side.
8. Then Phase 1.5 + 1.6 + 1.7 (WebSocket wiring).
9. Then Phase 2 (client).
10. Then Phase 3 (UI).

Smoke-test after each phase with the dev-test-tools harness (`dev-test-tools/bin/send`, `inspect`, `tail`) — these were used extensively for testing v2.5.46 and the pattern works.

### Build is local-only until tested — reminder

User explicitly said multiple times: **no git commits, no pushes, no releases, no version bumps** until they've tested on the local dev server. See the "⚠️ EXECUTION RULES" section at the top of this file. Touch `packages/server/src/index.ts` to trigger tsx watch reload after server changes; restart dashboard dev separately if vite doesn't auto-reload. The dev server at `localhost:3001` is the test target.

After each phase or significant milestone, **stop and tell the user what's testable**, then wait for them to test. Don't barrel through all phases without checkpoints.

