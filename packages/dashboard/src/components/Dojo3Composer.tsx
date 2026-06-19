import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  type KeyboardEvent,
  type DragEvent,
  type ClipboardEvent,
  type ChangeEvent,
} from 'react';
import { createPortal } from 'react-dom';
import * as api from '../lib/api';
import type { AttachmentInfo } from '../lib/api';
import { useVoiceMode } from '../hooks/useVoiceMode';
import { VoiceFirstRunModal } from './VoiceFirstRunModal';
import { useDojoOrb } from './orb/OrbProvider';
import { useToast } from '../hooks/useToast';
import { usePresence } from './PresenceProvider';

const ACCEPTED_EXTENSIONS = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.json,.xml,.doc,.docx,.xls,.xlsx,.pptx,.js,.ts,.tsx,.jsx,.py,.html,.css,.sh,.yaml,.yml,.toml,.env,.sql,.rs,.go,.java,.rb,.php,.swift,.kt,.c,.cpp,.h,.mp3,.wav,.m4a,.aac,.ogg,.opus,.flac,.webm,.mp4,.mov,.mkv,.avi';
// 1 GB per file, 2 GB per message. Mirrors ChatInput's caps for early UI
// feedback before we start streaming the upload.
const MAX_FILE_SIZE = 1024 * 1024 * 1024;
const MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

interface PendingFile {
  file: File;
  previewUrl?: string;
}

interface Dojo3ComposerProps {
  agentId: string;
  onSend: (content: string, attachments?: AttachmentInfo[]) => void;
  isWorking?: boolean;
  onStop?: () => void;
  placeholder?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncateName(name: string): string {
  return name.length > 26 ? `${name.slice(0, 24)}…` : name;
}

const WAVE_BARS = 18;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Dojo3Composer({
  agentId,
  onSend,
  isWorking,
  onStop,
  placeholder,
}: Dojo3ComposerProps) {
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [mode, setMode] = useState<'text' | 'file'>('text');
  const [dragOver, setDragOver] = useState(false);

  const composerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const moteRafRef = useRef<number | null>(null);
  const moteNodeRef = useRef<HTMLDivElement | null>(null);

  const voice = useVoiceMode({ agentId });
  const dojoOrb = useDojoOrb();
  const { warning: toastWarning } = useToast();
  const { isAway, toggle: togglePresence } = usePresence();

  /* ---- voice session timing + wave ---- */
  const [stageEl, setStageEl] = useState<HTMLElement | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const voiceStartRef = useRef<number | null>(null);
  const waveRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const waveRafRef = useRef<number | null>(null);

  /* Resolve the stage element for the capsule portal once mounted. */
  useEffect(() => {
    setStageEl(composerRef.current?.closest('.dojo3-stage') as HTMLElement | null);
  }, []);

  /* Track when the session went live so the timer can count up. */
  useEffect(() => {
    if (voice.enabled) {
      if (voiceStartRef.current == null) voiceStartRef.current = performance.now();
    } else {
      voiceStartRef.current = null;
      setElapsed(0);
    }
  }, [voice.enabled]);

  /* RAF loop: timer + center-weighted waveform driven by audioLevel. */
  useEffect(() => {
    if (!voice.enabled) return;
    const reduced = prefersReducedMotion();
    const loop = () => {
      const t0 = voiceStartRef.current;
      if (t0 != null) setElapsed((performance.now() - t0) / 1000);
      const bars = waveRefs.current;
      const n = WAVE_BARS;
      const phase = performance.now() / 1000;
      for (let i = 0; i < n; i++) {
        const bar = bars[i];
        if (!bar) continue;
        const c = (i - (n - 1) / 2) / ((n - 1) / 2);
        const envC = Math.cos((c * Math.PI) / 2); // taller in the middle
        let live: number;
        if (voice.muted) {
          live = 0.1;
        } else if (reduced) {
          live = 0.4;
        } else {
          const lvl = Math.min(1, voice.audioLevel * 1.6);
          const shimmer =
            0.5 +
            0.5 * Math.abs(Math.sin(phase * 6.3 + i * 0.9) * 0.6 + Math.sin(phase * 11.7 + i * 1.7) * 0.4);
          live = 0.18 + 0.82 * lvl * shimmer;
        }
        bar.style.transform = `scaleY(${Math.max(0.08, envC * live)})`;
      }
      waveRafRef.current = requestAnimationFrame(loop);
    };
    waveRafRef.current = requestAnimationFrame(loop);
    return () => {
      if (waveRafRef.current != null) cancelAnimationFrame(waveRafRef.current);
      waveRafRef.current = null;
    };
  }, [voice.enabled, voice.muted, voice.audioLevel]);

  /* ---- orb <- voice ---- */
  /* The orb's state follows the voice session (listening while you speak,
     speaking while the agent talks, thinking while it processes); with no voice
     session it falls back to the agent's working flag. The composer owns this
     because it's the one place that has both signals (Dojo3Stage's old
     isWorking->state effect was moved here). */
  useEffect(() => {
    if (!voice.enabled) {
      dojoOrb.setState(isWorking ? 'thinking' : 'idle');
      return;
    }
    const s =
      voice.state === 'speaking' ? 'speaking'
      : voice.state === 'listening' || voice.state === 'capturing' ? 'listening'
      : voice.state === 'connecting' || voice.state === 'transcribing' || voice.state === 'waiting' ? 'thinking'
      : 'idle'; // idle / passive / error
    dojoOrb.setState(s);
  }, [voice.enabled, voice.state, isWorking, dojoOrb]);

  /* Live reactivity: while you're actually speaking, drive the orb's pulse from
     the real mic level instead of the canned envelope; otherwise release it. */
  useEffect(() => {
    const live = voice.enabled && (voice.state === 'listening' || voice.state === 'capturing');
    dojoOrb.setEnv(live ? voice.audioLevel : null);
  }, [voice.enabled, voice.state, voice.audioLevel, dojoOrb]);

  /* Surface voice failures (mic blocked, no mic, connection lost, ...) as a
     notification instead of a silent console error. The hook formats errors as
     "detail: message"; show just the human message. */
  const lastVoiceErr = useRef<string | null>(null);
  useEffect(() => {
    if (!voice.error) { lastVoiceErr.current = null; return; }
    if (voice.error === lastVoiceErr.current) return;
    lastVoiceErr.current = voice.error;
    toastWarning(voice.error.replace(/^[a-z_]+:\s*/, ''));
  }, [voice.error, toastWarning]);

  /* ---- file handling ---- */
  const addFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    setPendingFiles((prev) => {
      const newPending: PendingFile[] = [];
      let totalSize = prev.reduce((sum, pf) => sum + pf.file.size, 0);
      for (const file of fileArray) {
        if (file.size > MAX_FILE_SIZE) continue;
        totalSize += file.size;
        if (totalSize > MAX_TOTAL_SIZE) break;
        const pf: PendingFile = { file };
        if (IMAGE_TYPES.has(file.type)) pf.previewUrl = URL.createObjectURL(file);
        newPending.push(pf);
      }
      return [...prev, ...newPending];
    });
    // Files are staged — return to the text composer so the user can type a
    // message; the attachments show as tiny thumbnails next to the input.
    setMode('text');
    dojoOrb.setEmotion('success');
  }, [dojoOrb]);

  const removeFile = useCallback((index: number) => {
    setPendingFiles((prev) => {
      const removed = prev[index];
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  /* ---- auto-grow the message box ----
     The input word-wraps as a textarea; we grow its height to fit the text,
     capped at 2 lines on mobile and 4 on desktop (then it scrolls). Growth
     only kicks in once there's enough text to need a second line. */
  const autoGrowInput = useCallback(() => {
    const ta = inputRef.current;
    if (!ta) return;
    const cs = window.getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || 21;
    const maxLines = window.matchMedia('(max-width: 768px)').matches ? 2 : 8;
    const max = Math.round(lh * maxLines);
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
  }, []);

  /* Re-measure whenever the text changes (typing, paste, clear-on-send). */
  useLayoutEffect(() => { autoGrowInput(); }, [input, autoGrowInput]);

  /* Focus changes the box width on mobile (it widens), which reflows the wrap;
     re-measure after the width transition settles. */
  useEffect(() => {
    if (!focused) return;
    const id = window.setTimeout(autoGrowInput, 460);
    return () => window.clearTimeout(id);
  }, [focused, autoGrowInput]);

  /* Crossing the mobile/desktop breakpoint changes the line cap. */
  useEffect(() => {
    const onResize = () => autoGrowInput();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [autoGrowInput]);

  /* Cleanup preview URLs + animation frames on unmount. */
  useEffect(() => {
    return () => {
      pendingFiles.forEach((pf) => {
        if (pf.previewUrl) URL.revokeObjectURL(pf.previewUrl);
      });
      if (moteRafRef.current != null) cancelAnimationFrame(moteRafRef.current);
      if (moteNodeRef.current) moteNodeRef.current.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- the light mote: pill top-center up into the orb ---- */
  const launchMote = useCallback(() => {
    if (prefersReducedMotion()) {
      dojoOrb.pulse();
      return;
    }
    const stageNode = composerRef.current?.closest('.dojo3-stage') as HTMLElement | null;
    const pill = composerRef.current?.querySelector('.composer__body') as HTMLElement | null;
    const orbHit = stageNode?.querySelector('.dojo3-orb-hit') as HTMLElement | null;
    if (!stageNode || !pill || !orbHit) {
      dojoOrb.pulse();
      return;
    }
    const stageRect = stageNode.getBoundingClientRect();
    const pillRect = pill.getBoundingClientRect();
    const orbRect = orbHit.getBoundingClientRect();

    // coordinates relative to the (positioned) stage element
    const x0 = pillRect.left + pillRect.width / 2 - stageRect.left;
    const y0 = pillRect.top + 4 - stageRect.top;
    const x1 = orbRect.left + orbRect.width / 2 - stageRect.left;
    const y1 = orbRect.top + orbRect.height / 2 - stageRect.top;
    const cxm = x0 + (x1 - x0) * 0.5 + 60; // gentle arc to the right
    const cym = y0 + (y1 - y0) * 0.42; // above the midpoint

    const mote = document.createElement('div');
    mote.className = 'mote';
    stageNode.appendChild(mote);
    moteNodeRef.current = mote;

    const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / 650);
      const e = p * p * (3 - 2 * p); // smoothstep ease
      const x = (1 - e) * (1 - e) * x0 + 2 * (1 - e) * e * cxm + e * e * x1;
      const y = (1 - e) * (1 - e) * y0 + 2 * (1 - e) * e * cym + e * e * y1;
      mote.style.left = `${x - 5}px`;
      mote.style.top = `${y - 5}px`;
      mote.style.opacity = p > 0.85 ? String(1 - (p - 0.85) / 0.15) : '1';
      if (p < 1) {
        moteRafRef.current = requestAnimationFrame(step);
      } else {
        mote.remove();
        if (moteNodeRef.current === mote) moteNodeRef.current = null;
        moteRafRef.current = null;
        dojoOrb.pulse();
      }
    };
    moteRafRef.current = requestAnimationFrame(step);
  }, [dojoOrb]);

  /* ---- submit ---- */
  const handleSend = useCallback(async () => {
    const content = input.trim();
    if (!content && pendingFiles.length === 0) return;
    if (uploading) return;

    let attachments: AttachmentInfo[] | undefined;

    if (pendingFiles.length > 0) {
      setUploading(true);
      const result = await api.uploadFiles(agentId, pendingFiles.map((pf) => pf.file));
      setUploading(false);
      if (!result.ok) return;
      attachments = result.data;
      pendingFiles.forEach((pf) => {
        if (pf.previewUrl) URL.revokeObjectURL(pf.previewUrl);
      });
      setPendingFiles([]);
    }

    setInput('');
    setMode('text');
    launchMote();
    dojoOrb.setState('thinking');
    onSend(content || '(attached files)', attachments);
  }, [input, pendingFiles, uploading, agentId, launchMote, dojoOrb, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  /* ---- attach orbit ---- */
  const toggleAttach = () => {
    setMode((m) => (m === 'file' ? 'text' : 'file'));
  };

  const openFilePicker = () => fileInputRef.current?.click();

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      e.target.value = '';
    }
  };

  /* ---- drag and drop on the whole composer ---- */
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMode('file');
    setDragOver(true);
  };
  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };
  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  };

  /* ---- paste-to-attach (images) ---- */
  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      setMode('file');
      addFiles(imageFiles);
    }
  };

  /* ---- voice / stop orbit ---- */
  const handleVoiceClick = () => {
    if (!voice.enabled) {
      // Catch the insecure-context case up front (before the model-setup
      // flow): mic access needs HTTPS or localhost, so on a plain http:// LAN
      // address it's blocked. A friendly notification beats a console error.
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        toastWarning('Voice needs a secure connection. Open the dojo over HTTPS or on localhost — the mic is blocked on this http:// address.');
        return;
      }
      void voice.toggle();
    } else {
      void voice.toggleMute();
    }
  };

  const showStop = !!isWorking && !!onStop;

  const mm = Math.floor(elapsed / 60);
  const ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
  const timerLabel = `${mm}:${ss}`;

  const canSend = !uploading && (input.trim().length > 0 || pendingFiles.length > 0);

  return (
    <>
      <div
        ref={composerRef}
        className="composer"
        data-mode={mode}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* BODY: the message area — cross-fading text / file (drop-zone) layers */}
        <div className="composer__body">
          <div className="composer__layer composer__layer--text">
            {pendingFiles.length > 0 && (
              <div className="composer__thumbs" aria-label="Attached files">
                {pendingFiles.map((pf, i) => {
                  const ext = (pf.file.name.split('.').pop() ?? '').slice(0, 4).toUpperCase();
                  return (
                    <div
                      className="composer__thumb"
                      key={`thumb-${pf.file.name}-${i}`}
                      title={`${pf.file.name} (${formatFileSize(pf.file.size)})`}
                    >
                      {pf.previewUrl ? (
                        <img src={pf.previewUrl} alt={pf.file.name} />
                      ) : (
                        <span className="composer__thumb-doc">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                          <span className="composer__thumb-ext">{ext}</span>
                        </span>
                      )}
                      <button
                        type="button"
                        className="composer__thumb-x"
                        aria-label={`Remove ${pf.file.name}`}
                        onClick={() => removeFile(i)}
                        onPointerDown={(e) => e.preventDefault()}
                      >
                        {'×'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {/* Custom caret for the EMPTY field: iOS floats the native empty
                caret to the top of the input, so we hide it (CSS) and show this
                centered one. Vanishes the moment text exists; the native caret
                (correct with text) takes over. */}
            {focused && input.length === 0 && (
              <span className="composer__caret" aria-hidden="true" />
            )}
            <textarea
              ref={inputRef}
              id="composerInput"
              className="composer__input"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={uploading ? 'Uploading files…' : placeholder ?? 'Message the Dojo'}
              disabled={uploading}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="composer__layer composer__layer--file">
            <div
              className={`composer__drop ${dragOver ? 'is-over' : ''}`}
              role="button"
              tabIndex={0}
              onClick={openFilePicker}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openFilePicker();
                }
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg>
              <span>Drop files here or click to browse</span>
            </div>
            {pendingFiles.length > 0 && (
            <div className="composer__chips">
              {pendingFiles.map((pf, i) => (
                <span className="chip" key={`${pf.file.name}-${i}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                  <span>{truncateName(pf.file.name)}</span>
                  <span className="chip__size">{formatFileSize(pf.file.size)}</span>
                  <button
                    type="button"
                    className="chip__x"
                    aria-label={`Remove ${pf.file.name}`}
                    onClick={() => removeFile(i)}
                  >
                    {'×'}
                  </button>
                </span>
              ))}
            </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_EXTENSIONS}
              onChange={handleFileChange}
              hidden
            />
          </div>
        </div>

        {/* BAR: presence (left) + attach / voice / send-or-stop (right) */}
        <div className="composer__bar">
          <button
            type="button"
            className={`composer__presence ${isAway ? 'is-out' : ''}`}
            onClick={() => { void togglePresence(); }}
            onPointerDown={(e) => e.preventDefault()}
            aria-label={isAway ? 'Out of the dojo (replies via iMessage). Tap to come back in.' : 'In the dojo. Tap to step out.'}
            aria-pressed={isAway}
          >
            <span className="composer__presence-dot" aria-hidden="true" />
            <span className="composer__presence-text">{isAway ? 'Out · iMessage' : 'In the Dojo'}</span>
          </button>

          <div className="composer__actions">
            {/* ATTACH — toggles the in-box drop zone */}
            <button
              type="button"
              className="composer__btn"
              id="attachBtn"
              onClick={toggleAttach}
              aria-label={mode === 'file' ? 'Close attachments' : 'Attach files'}
              aria-pressed={mode === 'file'}
              onPointerDown={(e) => e.preventDefault()}
            >
              <svg className="ic ic--clip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48" /></svg>
              <svg className="ic ic--x" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>

            {/* VOICE */}
            <button
              type="button"
              className={`composer__btn ${voice.enabled && !voice.muted ? 'is-live' : ''} ${voice.muted ? 'is-muted' : ''}`}
              id="voiceBtn"
              onClick={handleVoiceClick}
              onPointerDown={(e) => e.preventDefault()}
              aria-label={!voice.enabled ? 'Start voice session' : voice.muted ? 'Unmute microphone' : 'Mute microphone'}
              aria-pressed={voice.enabled}
            >
              <svg className="ic ic--mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v1a7 7 0 0 0 14 0v-1" /><path d="M12 18v3" /></svg>
              <svg className="ic ic--mic-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6a3 3 0 0 1 6 0v4" /><path d="M15 11.6V12a3 3 0 0 1-5.1 2.1" /><path d="M5 10v1a7 7 0 0 0 11.3 5.5" /><path d="M18.6 13.4c.26-.75.4-1.56.4-2.4v-1" /><path d="M12 18v3" /><path d="M3 3l18 18" /></svg>
            </button>

            {/* SEND — becomes STOP while the agent is working */}
            {showStop ? (
              <button
                type="button"
                className="composer__btn composer__btn--stop"
                onClick={onStop}
                onPointerDown={(e) => e.preventDefault()}
                aria-label="Stop"
                title="Stop"
              >
                <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
              </button>
            ) : (
              <button
                type="button"
                className="composer__btn composer__btn--send"
                onClick={() => { void handleSend(); }}
                onPointerDown={(e) => e.preventDefault()}
                disabled={!canSend}
                aria-label="Send message"
                title="Send"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* VOICE CAPSULE — portaled into the stage so it docks under the orb */}
      {stageEl &&
        createPortal(
          <div
            className={`voice-capsule ${voice.enabled ? 'is-open' : ''} ${voice.muted ? 'is-muted' : ''}`}
            role="group"
            aria-label="Voice session"
          >
            <span className="voice-capsule__timer">{timerLabel}</span>
            <div className="voice-capsule__wave" aria-hidden="true">
              {Array.from({ length: WAVE_BARS }).map((_, i) => (
                <span
                  key={i}
                  ref={(el) => {
                    waveRefs.current[i] = el;
                  }}
                />
              ))}
            </div>
            <button
              type="button"
              className="voice-capsule__end"
              aria-label="End voice session"
              onClick={() => { void voice.toggle(); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>,
          stageEl,
        )}

      {/* First-run voice setup modal */}
      {voice.setupNeeded && (
        <VoiceFirstRunModal
          whisperModelId={voice.setupNeeded.whisperModelId}
          onComplete={() => { void voice.completeSetup(); }}
          onCancel={voice.cancelSetup}
        />
      )}
    </>
  );
}
