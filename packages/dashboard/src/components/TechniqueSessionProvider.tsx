import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import type { Message, WsEvent, ChatToolCallEvent } from '@dojo/shared';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

/*
 * Technique-session fusion.
 *
 * David's vision: building or editing a technique should NOT bounce the user to
 * a separate dark page. Instead the persistent dojo3 chat BECOMES the trainer
 * (Ticky / Yoshi) conversation — it slides left — and the Technique Mat (the
 * form) docks on the right. This provider owns everything trainer-specific so
 * the persistent <Chat> only has to (a) target the trainer agent while a
 * session is active, (b) prepend build/edit context to the first outgoing
 * message, and (c) strip that context from the user's bubble. Default state is
 * inactive, so with no session the chat behaves exactly as before.
 *
 * What lived in the old TechniqueBuilder.tsx and now lives here: the Mat
 * (CanvasState), the build/edit/setup/refresh context injection, the
 * resume-vs-clear decision on entry, the canvas<->disk sync (save_technique /
 * update_technique tool calls + technique:updated), and Save Draft / Publish.
 */

export interface CanvasState {
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  instructions: string;
  files: Array<{ path: string; content?: string }>;
}

// ── Context injected as the first user message (kept verbatim from the old
//    TechniqueBuilder so trainer behavior is unchanged) ──

const BUILDER_CONTEXT = `I want to build a new technique for the dojo. Help me create it step by step.

When we have enough detail, use the save_technique tool to create it. I can see the technique canvas updating in real-time on my screen, so as you refine the technique, call save_technique to update the canvas.

Guide me through:
1. What should the technique be called? (a short slug name and a display name)
2. What does the technique do? (description)
3. What are the step-by-step instructions? (this becomes TECHNIQUE.md)
4. Any supporting files needed?
5. What tags should it have?

Let's start — what kind of technique would you like to create?`;

function getEditContext(name: string, description: string, instructions: string): string {
  const lineCount = instructions ? instructions.split('\n').length : 0;
  const charCount = instructions?.length ?? 0;
  return `I want to edit an existing technique in the dojo called "${name}".

Description (currently): ${description || '(none)'}

Current TECHNIQUE.md is loaded on disk (${charCount.toLocaleString()} chars, ${lineCount} lines). Read it the moment you need it:
  • technique_read(name="${name}", action="outline") — section list + line ranges, never truncates
  • technique_read(name="${name}", action="section", section_name="…") — read one section
  • technique_read(name="${name}", action="search", query="…") — grep across TECHNIQUE.md and supporting files

I can see the technique mat on my screen with the current content. When we're done, use update_technique to save the changes. What I'd like changed is below.`;
}

function getSetupContext(name: string, slug: string, directoryPath: string | null): string {
  const dirHint = directoryPath ? ` It lives in: \`${directoryPath}\`.` : '';
  return `I just imported a shared technique called "${name}" (slug: ${slug}) and it landed in needs_setup state.${dirHint}

Please help me finish setting it up:

1. Read \`IMPORT_MANIFEST.json\` and \`README.md\` in the technique directory using file_read so you understand what came in the package and what setup steps the original author documented.
2. Look at the manifest's \`placeholders\` list — each one is a {{NEEDS_FROM_USER:LABEL}} marker that the exporting Dojo redacted because it was a secret or per-install value. Ask me for each placeholder ONE AT A TIME, in plain language, using the hint from the manifest to explain what it is.
3. As I give you each value, call technique_set_placeholder({technique: "${slug}", label: "...", value: "..."}) to write it into the technique files.
4. After every placeholder is filled, call technique_finalize({technique: "${slug}"}) — that flips the technique out of needs_setup and into draft state so I can review it or publish it.

If the README mentions manual setup steps that AREN'T placeholders (e.g. granting an OAuth scope, installing a CLI), call them out so I know to handle them before finalizing.

Ready when you are — start by reading the manifest and the README.`;
}

// Unique sentinel separating injected build/edit context from the user's typed
// text. The chat strips everything up to and including it from the user bubble.
export const USER_PROMPT_MARKER_OPEN = '\n\n════════════════════════════════════════\nUSER MESSAGE BELOW (the rest above is build/edit context for you):\n════════════════════════════════════════\n\n';

/** Remove injected build/edit/setup/refresh context so the user bubble only
 *  shows what they typed. Safe to call on any message: returns content
 *  unchanged unless it carries the sentinel (or a legacy v2.5.17 header). */
export function stripBuilderContext(content: string): string {
  const markerIdx = content.indexOf(USER_PROMPT_MARKER_OPEN);
  if (markerIdx >= 0) {
    return content.slice(markerIdx + USER_PROMPT_MARKER_OPEN.length);
  }
  const startsWithBuilder = content.startsWith('I want to build a new technique for the dojo');
  const startsWithEdit = content.startsWith('I want to edit an existing technique in the dojo called');
  const startsWithRefresh = content.startsWith('[Technique state refresh');
  if (!startsWithBuilder && !startsWithEdit && !startsWithRefresh) return content;
  const sepIdx = content.lastIndexOf('\n\n---\n\n');
  if (sepIdx === -1) return content;
  return content.slice(sepIdx + '\n\n---\n\n'.length);
}

const EMPTY_CANVAS: CanvasState = {
  name: '', displayName: '', description: '', tags: [], instructions: '', files: [],
};

export interface OutgoingPlan {
  /** The full message to send to the trainer (context + marker + typed). */
  outgoing: string;
  /** Commit the context gate after a successful send. */
  commit: () => void;
  /** Roll the gate back after a failed send so a retry re-prepends context. */
  rollback: () => void;
}

export interface TechniqueSessionApi {
  active: boolean;
  /** True once the resume-vs-clear decision has resolved; the chat waits on
   *  this before loading the trainer conversation. */
  ready: boolean;
  trainerAgentId: string;
  trainerName: string;
  canvas: CanvasState;
  saving: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  handleCanvasChange: (updates: Partial<CanvasState>) => void;
  saveTechnique: (publish: boolean) => Promise<void>;
  prepareOutgoing: (typed: string) => OutgoingPlan;
  start: (mode: 'new' | 'edit', editId?: string) => void;
  end: () => void;
}

const FALLBACK: TechniqueSessionApi = {
  active: false, ready: false, trainerAgentId: 'trainer', trainerName: '',
  canvas: EMPTY_CANVAS, saving: false, error: null,
  setError: () => {}, handleCanvasChange: () => {}, saveTechnique: async () => {},
  prepareOutgoing: (typed) => ({ outgoing: typed, commit: () => {}, rollback: () => {} }),
  start: () => {}, end: () => {},
};

const TechniqueSessionContext = createContext<TechniqueSessionApi | null>(null);

function getToken(): string | null { return localStorage.getItem('dojo_token'); }
function getCsrf(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m ? m[1] : null;
}

export function TechniqueSessionProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { subscribe } = useWebSocket();

  const [trainerAgentId, setTrainerAgentId] = useState('trainer');
  const [trainerName, setTrainerName] = useState('');
  const [session, setSession] = useState<{ mode: 'new' | 'edit'; editId?: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [canvas, setCanvas] = useState<CanvasState>(EMPTY_CANVAS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdTechniqueId, setCreatedTechniqueId] = useState<string | null>(null);

  // Context-injection gate + stale-state tracking (mirrors the old builder).
  const contextSentRef = useRef(false);
  const techniqueStateRef = useRef<string | null>(null);
  const techniqueUpdatedAtRef = useRef<string | null>(null);
  const techniqueDirectoryPathRef = useRef<string | null>(null);
  const lastTrainerActivityAtRef = useRef<string | null>(null);
  // Bumped on every start() so an in-flight resume check for a stale session
  // is ignored once a newer session begins.
  const startTokenRef = useRef(0);

  const trainerAgentIdRef = useRef(trainerAgentId);
  trainerAgentIdRef.current = trainerAgentId;
  const createdTechniqueIdRef = useRef<string | null>(null);
  createdTechniqueIdRef.current = createdTechniqueId;
  // Set true the moment the trainer calls save_technique in a NEW session, so
  // the next technique:updated event can hand us the AUTHORITATIVE server id
  // (which may differ from our client-derived slug after de-dupe/normalize).
  const awaitingTechniqueIdRef = useRef(false);

  // Trainer identity from settings (loaded once).
  useEffect(() => {
    api.getSetting('trainer_agent_id').then((r) => {
      if (r.ok && r.data.value) setTrainerAgentId(r.data.value);
    });
    api.getSetting('trainer_agent_name').then((r) => {
      if (r.ok && r.data.value) setTrainerName(r.data.value);
    });
  }, []);

  const loadTechniqueFromDisk = useCallback(async (id: string) => {
    const token = getToken();
    const res = await fetch(`/api/techniques/${id}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    const data = await res.json().catch(() => null);
    if (data?.ok) {
      // Load each file's BODY (not just its path) so the file is editable on the
      // canvas and edits round-trip on save (saveTechnique only uploads files
      // that carry `content`). Path segments are URL-encoded so spaces / # / ?
      // in a filename don't break the request.
      const filePaths: string[] = (data.data.files ?? [])
        .filter((f: { isDirectory: boolean }) => !f.isDirectory)
        .map((f: { path: string }) => f.path);
      const files = await Promise.all(
        filePaths.map(async (p) => {
          try {
            const enc = p.split('/').map(encodeURIComponent).join('/');
            const fr = await fetch(`/api/techniques/${data.data.id}/files/${enc}`, {
              headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            });
            const fd = await fr.json().catch(() => null);
            return fd?.ok ? { path: p, content: fd.data.content as string } : { path: p };
          } catch {
            return { path: p };
          }
        }),
      );
      setCanvas({
        name: data.data.id,
        displayName: data.data.name,
        description: data.data.description ?? '',
        tags: data.data.tags ?? [],
        instructions: data.data.instructions ?? '',
        files,
      });
      if (typeof data.data.updatedAt === 'string') techniqueUpdatedAtRef.current = data.data.updatedAt;
      if (typeof data.data.state === 'string') techniqueStateRef.current = data.data.state;
      if (typeof data.data.directoryPath === 'string') techniqueDirectoryPathRef.current = data.data.directoryPath;
    }
  }, []);

  // Decide whether to resume the trainer's existing conversation (if it's about
  // THIS technique) or wipe it and start fresh. Sets `ready` when resolved so
  // the chat can load history.
  const resolveSession = useCallback(async (mode: 'new' | 'edit', token: number) => {
    const trainerId = trainerAgentIdRef.current;
    if (!trainerId) { if (token === startTokenRef.current) setReady(true); return; }

    const result = await api.getChatHistory(trainerId, 200);
    let conversationMatches = false;
    if (result.ok && result.data.length > 1) {
      const firstUserMsg = result.data.find((m: Message) => m.role === 'user');
      if (firstUserMsg) {
        if (mode === 'edit') {
          // Edit sessions always start a fresh thread. Resuming by fuzzy
          // name-match grabbed the wrong prior conversation for short/common
          // technique names. The technique's current state is loaded into the
          // canvas from disk and re-sent to the trainer via the edit-context
          // header on the first message, so a fresh thread loses nothing.
          conversationMatches = false;
        } else {
          conversationMatches = firstUserMsg.content.includes('build a new technique');
        }
      }
    }

    if (token !== startTokenRef.current) return; // superseded

    if (conversationMatches && result.ok) {
      // Resume: the trainer already saw the technique in this thread.
      contextSentRef.current = true;
      const latest = result.data[result.data.length - 1] as Message | undefined;
      lastTrainerActivityAtRef.current = latest?.createdAt ?? null;
    } else {
      // Fresh start: wipe the trainer session server-side.
      const tk = getToken();
      const csrf = getCsrf();
      await fetch('/api/techniques/clear-session', {
        method: 'POST',
        headers: {
          ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
      }).catch(() => { /* best effort */ });
      contextSentRef.current = false;
    }
    if (token === startTokenRef.current) setReady(true);
  }, []);

  // Keep a ref of canvas for resolveSession (avoids re-creating it per keystroke).
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;

  const start = useCallback((mode: 'new' | 'edit', editId?: string) => {
    const token = ++startTokenRef.current;
    contextSentRef.current = false;
    techniqueStateRef.current = null;
    techniqueUpdatedAtRef.current = null;
    techniqueDirectoryPathRef.current = null;
    lastTrainerActivityAtRef.current = null;
    setError(null);
    setReady(false);
    setCreatedTechniqueId(editId ?? null);
    setCanvas(EMPTY_CANVAS);
    setSession({ mode, editId });

    (async () => {
      if (mode === 'edit' && editId) {
        await loadTechniqueFromDisk(editId);
      }
      if (token !== startTokenRef.current) return;
      await resolveSession(mode, token);
    })();
  }, [loadTechniqueFromDisk, resolveSession]);

  const end = useCallback(() => {
    startTokenRef.current++;
    setSession(null);
    setReady(false);
    setCanvas(EMPTY_CANVAS);
    setError(null);
    setCreatedTechniqueId(null);
  }, []);

  const handleCanvasChange = useCallback((updates: Partial<CanvasState>) => {
    setCanvas((prev) => ({ ...prev, ...updates }));
  }, []);

  // Canvas <- trainer tool calls. Mirrors the old builder so the Mat reflects
  // what the trainer just wrote and a later Save doesn't clobber it.
  const handleToolCallForCanvas = useCallback((toolName: string, args: Record<string, unknown>) => {
    if (toolName === 'save_technique') {
      const techName = (args.name as string) || '';
      const slug = techName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      // Provisional id for immediate UI. The server may persist under a
      // different id; the technique:updated handler upgrades us to the real one.
      if (slug) setCreatedTechniqueId(slug);
      awaitingTechniqueIdRef.current = true;
      setCanvas((prev) => ({
        ...prev,
        name: techName || prev.name,
        displayName: (args.display_name as string) || (args.displayName as string) || prev.displayName,
        description: (args.description as string) || prev.description,
        instructions: (args.instructions as string) || prev.instructions,
        tags: Array.isArray(args.tags) ? (args.tags as string[]) : prev.tags,
        files: Array.isArray(args.files)
          ? (args.files as Array<{ path: string; content?: string }>)
          : prev.files,
      }));
    } else if (toolName === 'update_technique') {
      setCanvas((prev) => ({
        ...prev,
        instructions: typeof args.instructions === 'string' ? (args.instructions as string) : prev.instructions,
        files: Array.isArray(args.files)
          ? [
              ...prev.files.filter((p) => !(args.files as Array<{ path: string }>).some((nf) => nf.path === p.path)),
              ...(args.files as Array<{ path: string; content?: string }>),
            ]
          : prev.files,
      }));
    }
  }, []);

  // Trainer-driven canvas sync, active only during a session.
  useEffect(() => {
    if (!session) return;
    const unsubToolCall = subscribe('chat:tool_call', (event: WsEvent) => {
      const e = event as ChatToolCallEvent;
      if (e.agentId !== trainerAgentIdRef.current) return;
      handleToolCallForCanvas(e.tool, e.args);
    });
    const unsubTechUpdated = subscribe('technique:updated', (event: WsEvent) => {
      const e = event as { type: 'technique:updated'; data: { id: string } };
      const serverId = e.data?.id;
      if (!serverId) return;
      const currentId = createdTechniqueIdRef.current || session.editId;
      const exact = !!currentId && serverId === currentId;
      // In a NEW session right after save_technique, the first technique:updated
      // is ours even if the server id differs from our provisional slug — adopt
      // the authoritative id so Save updates the right technique (and we don't
      // PUT/POST a dead slug). Edit mode always has a real editId, so never adopt.
      const adopt = !exact && session.mode !== 'edit' && awaitingTechniqueIdRef.current;
      if (!exact && !adopt) return;
      awaitingTechniqueIdRef.current = false;
      if (adopt) {
        setCreatedTechniqueId(serverId);
        createdTechniqueIdRef.current = serverId;
      }
      loadTechniqueFromDisk(serverId)
        .then(() => { lastTrainerActivityAtRef.current = new Date().toISOString(); })
        .catch(() => { /* best effort */ });
    });
    return () => { unsubToolCall(); unsubTechUpdated(); };
  }, [session, subscribe, handleToolCallForCanvas, loadTechniqueFromDisk]);

  // Build the outgoing message, injecting build/edit/setup/refresh context on
  // the first (or post-edit) turn. Mirrors the old builder's handleSend.
  const prepareOutgoing = useCallback((typed: string): OutgoingPlan => {
    const sess = sessionRef.current;
    if (!sess) return { outgoing: typed, commit: () => {}, rollback: () => {} };
    const isEditMode = sess.mode === 'edit';
    const isFirstMessage = !contextSentRef.current;
    let outgoing = typed;
    let wasStale = false;

    if (isFirstMessage) {
      const isSetupMode = isEditMode && techniqueStateRef.current === 'needs_setup';
      const c = canvasRef.current;
      const contextMessage = isSetupMode
        ? getSetupContext(c.displayName, c.name, techniqueDirectoryPathRef.current)
        : isEditMode
          ? getEditContext(c.displayName, c.description, c.instructions)
          : BUILDER_CONTEXT;
      outgoing = `${contextMessage}${USER_PROMPT_MARKER_OPEN}${typed}`;
    } else if (
      isEditMode &&
      techniqueUpdatedAtRef.current &&
      lastTrainerActivityAtRef.current &&
      techniqueUpdatedAtRef.current > lastTrainerActivityAtRef.current
    ) {
      const c = canvasRef.current;
      const refresh =
        `[Technique state refresh — the technique has been edited since our last conversation. ` +
        `Treat THIS as the source of truth, not earlier messages in this thread.]\n\n` +
        getEditContext(c.displayName, c.description, c.instructions);
      outgoing = `${refresh}${USER_PROMPT_MARKER_OPEN}${typed}`;
      wasStale = true;
    }

    const commit = () => {
      if (isFirstMessage) contextSentRef.current = true;
      if (isFirstMessage || wasStale) {
        if (techniqueUpdatedAtRef.current) lastTrainerActivityAtRef.current = techniqueUpdatedAtRef.current;
      }
    };
    const rollback = () => { if (isFirstMessage) contextSentRef.current = false; };
    return { outgoing, commit, rollback };
  }, []);

  const sessionRef = useRef(session);
  sessionRef.current = session;

  const saveTechnique = useCallback(async (publish: boolean) => {
    const c = canvasRef.current;
    if (!c.displayName.trim()) return;
    setSaving(true);
    const slug = c.name.trim() || c.displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    try {
      const token = getToken();
      const csrf = getCsrf();
      const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      };
      const sess = sessionRef.current;
      const existingId = createdTechniqueIdRef.current || (sess?.mode === 'edit' ? sess.editId : null);
      if (existingId) {
        const filesToUpload = c.files.filter((f) => typeof f.content === 'string');
        for (const file of filesToUpload) {
          const enc = file.path.split('/').map(encodeURIComponent).join('/');
          const fr = await fetch(`/api/techniques/${existingId}/files/${enc}`, {
            method: 'PUT', headers, body: JSON.stringify({ content: file.content }),
          });
          if (!fr.ok) throw new Error(`Failed to save file "${file.path}"`);
        }
        if (c.instructions.trim()) {
          const ir = await fetch(`/api/techniques/${existingId}/instructions`, {
            method: 'PUT', headers,
            body: JSON.stringify({ content: c.instructions.trim(), changeSummary: 'Updated from Technique Trainer' }),
          });
          if (!ir.ok) throw new Error('Failed to save instructions');
        }
        const metaRes = await fetch(`/api/techniques/${existingId}`, {
          method: 'PUT', headers,
          body: JSON.stringify({
            displayName: c.displayName.trim(),
            description: c.description.trim(),
            tags: c.tags,
            ...(publish ? { state: 'published' } : {}),
          }),
        });
        const metaData = await metaRes.json().catch(() => null);
        if (!metaRes.ok || metaData?.ok === false) {
          throw new Error(metaData?.error || 'Failed to update technique metadata');
        }
        if (publish) {
          await fetch(`/api/techniques/${existingId}/publish`, { method: 'POST', headers });
        }
        navigate(`/techniques/${existingId}`);
      } else {
        const res = await fetch('/api/techniques', {
          method: 'POST', headers,
          body: JSON.stringify({
            name: slug,
            displayName: c.displayName.trim(),
            description: c.description.trim(),
            instructions: c.instructions.trim() || '# ' + c.displayName.trim(),
            tags: c.tags,
            files: c.files.length > 0 ? c.files : undefined,
            publish,
          }),
        });
        const data = await res.json();
        if (data.ok) navigate(`/techniques/${data.data.id}`);
        else setError(data.error || 'Failed to save technique');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save technique');
    } finally {
      setSaving(false);
    }
  }, [navigate]);

  const value = useMemo<TechniqueSessionApi>(() => ({
    active: session !== null,
    ready,
    trainerAgentId,
    trainerName,
    canvas,
    saving,
    error,
    setError,
    handleCanvasChange,
    saveTechnique,
    prepareOutgoing,
    start,
    end,
  }), [session, ready, trainerAgentId, trainerName, canvas, saving, error,
      handleCanvasChange, saveTechnique, prepareOutgoing, start, end]);

  return (
    <TechniqueSessionContext.Provider value={value}>{children}</TechniqueSessionContext.Provider>
  );
}

export function useTechniqueSession(): TechniqueSessionApi {
  return useContext(TechniqueSessionContext) ?? FALLBACK;
}
