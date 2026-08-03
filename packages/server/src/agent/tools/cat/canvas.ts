// ════════════════════════════════════════════════════════════════════════════
// CANVAS & SHARED WORKSPACE (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// `canvas_render` (put a file or URL on the user's canvas), `canvas_read` (read
// back what is on it), `open_browser` (an embeddable site, else a screenshot)
// and `screen_broadcast`.
//
// RELOCATION, NOT REWRITE. Two details are load bearing and are byte-faithful:
//
// 1. **`toDashboardPath` is applied to every canvas URL and NOT to a share
//    link.** `getDownloadUrl` bakes in an absolute host (the tunnel, else
//    localhost:3001), which is only correct on the server's own machine — a
//    dashboard loaded from a LAN IP or the tunnel would 404 the asset. The
//    canvas renders INSIDE the dashboard, so it gets the bare path.
// 2. **An external `args.url` is passed through untouched.** Only a URL this
//    platform minted is rewritten; rewriting a third-party URL would break it.
//
// The canvas-open cluster these bodies call (`queueCanvasDocAttachment`,
// `registerSharedFile`, `toDashboardPath`) lives in `agent/tools/util.ts`, one
// copy, shared with the fs verbs and the office block.
// ════════════════════════════════════════════════════════════════════════════

import * as effectFs from '../../effects/fs.js';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../../../gateway/ws.js';
import { setCurrentCanvas, viewCanvas } from '../../canvas-view.js';
import { isEmbeddable, captureSiteScreenshot } from '../../site-snapshot.js';
import { queueScreenChip } from '../../pending-attachments.js';
import { resolvePath, sharePathGuard } from '../../path-guards.js';
import { auditLog, permissionDeniedMessage, registerSharedFile, toDashboardPath, queueCanvasDocAttachment } from '../util.js';
import { isScreenShareEnabled } from '../../../screen-share/manager.js';
import type { ToolHandlerMap } from '../handler.js';

export const canvasHandlers: ToolHandlerMap = {
  async "canvas_render"({ agentId, args }) {
    let content = '';
    let isError = false;
    const html = typeof args.html === 'string' ? args.html : undefined;
    let url = typeof args.url === 'string' ? args.url : undefined;
    const rawPath = typeof args.path === 'string' ? args.path : undefined;
    let canvasPath: string | undefined;
    // `path`: register the on-disk file so the canvas can fetch it (and
    // remember the path so later edits to it auto-refresh the canvas).
    if (rawPath) {
      // PHASE-5 T8 Step 7 — THE GUARD ITS SIBLINGS RUN. `registerSharedFile`
      // below mints the SAME unauthenticated download URL `share_file` mints,
      // so the same question has to be asked first: the sensitive tier of the
      // merged deny list, then the agent's own file_read permission. This was
      // the one member of the publish family that never asked it; the family's
      // completeness is now held by
      // `agent/tools/__tests__/publish-path-guards.test.ts` so a future member
      // cannot be added without one. Owner-authorised 2026-08-03.
      const canvasGuard = await sharePathGuard(agentId, 'canvas_render', rawPath);
      if (!canvasGuard.allowed) {
        auditLog(agentId, 'canvas_render', canvasGuard.absPath, 'denied', canvasGuard.reason);
        content = canvasGuard.blockedMessage ?? permissionDeniedMessage(canvasGuard.reason, agentId);
        isError = true;
        return { content, isError, errorCode: 'PERMISSION_DENIED' };
      }
      canvasPath = resolvePath(rawPath);
      const registered = registerSharedFile(agentId, canvasPath);
      if (!registered) {
        content = `Error: canvas_render could not read the file at ${canvasPath}. Make sure it exists (write it with file_write first).`;
        isError = true;
        return { content, isError };
      }
      // Same-origin path so the canvas resolves over localhost, a LAN IP,
      // or the tunnel (see toDashboardPath). External `args.url` values are
      // left untouched; only our own download URL is rewritten here.
      url = toDashboardPath(registered);
    }
    if (!html && !url) {
      content = 'Error: canvas_render requires one of `path` (a file on disk), `html` (markup to render), or `url` (a page/file to load).';
      isError = true;
      return { content, isError };
    }
    // A file_write download URL serves Content-Disposition: attachment by
    // default, which makes the canvas iframe download the file instead of
    // rendering it. Flip our own download URLs to inline so the content
    // renders in the canvas. (Leaves external URLs untouched.)
    if (url && /\/api\/upload\/download\/[^?#]+/.test(url) && !/[?&]inline=1\b/.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'inline=1';
    }
    const title = typeof args.title === 'string' ? args.title : undefined;
    broadcast({ type: 'dock:open', agentId, data: { kind: 'canvas', html, url, title, path: canvasPath } });
    setCurrentCanvas(agentId, { kind: 'canvas', html, url, path: canvasPath, title });
    // Drop an "Open in canvas" chip on this reply for file-backed canvases.
    if (canvasPath) queueCanvasDocAttachment(agentId, canvasPath, url ?? null);
    content = `Canvas opened in the user's right dock${title ? ` ("${title}")` : ''}. The user can now see it.${canvasPath ? ' Edits you make to this file (file_write/file_patch/file_append) will refresh the canvas automatically.' : ''} Call canvas_read if you need to look at it yourself.`;
    return { content, isError };
  },

  async "screen_broadcast"({ agentId, args }) {
    let content = '';
    const isError = false;
    if (!isScreenShareEnabled()) {
      content = "Screen sharing is OFF (it's disabled by default). It's a one-time setup done on this Mac. Offer to walk the user through it, then tell them these steps:\n\n" +
        "1. Open Settings > Integrations > Screen Sharing and click Enable. A macOS admin-password prompt will appear ON THIS MAC, approve it. (macOS may also ask to approve Screen Sharing in System Settings > Privacy & Security; approve that too.)\n" +
        "2. Set a screen-sharing password they'll remember: open System Settings > General > Sharing, click the (i) next to Screen Sharing > Computer Settings, check \"VNC viewers may control screen with password\", and set a password.\n" +
        "3. That's it. When you open the screen for them, they'll type that password to connect, and click \"Take control\" to use the mouse and keyboard.\n\n" +
        "Note: this one-time setup has to be done while at this Mac (the prompts appear on it). If they can see the screen later but can't control it, have them make sure macOS \"Remote Management\" is turned off (it can limit connections to view-only) and just \"Screen Sharing\" is on. Once they've enabled it, call screen_broadcast again.";
      return { content, isError };
    }
    const screenTitle = typeof args.title === 'string' ? args.title : undefined;
    // A live screen share has NO persisted per-agent slot (it's a transient
    // real-time view, not a canvas). Still stamp agentId so the dashboard's
    // per-agent filter opens it only for whoever is viewing this agent.
    broadcast({ type: 'dock:open', agentId, data: { kind: 'screen', title: screenTitle } });
    // Drop an "Open screen" chip on this reply so the user can re-open the
    // viewer after closing the canvas.
    queueScreenChip(agentId);
    content = "A LIVE view of this Mac's screen is now open in the user's canvas. This is NOT a file, document, or attachment, it is your actual screen, streaming in real time. When you reply, say something like \"I've put my screen up for you\" or \"my screen is open, go ahead and take control to click what you need.\" Do NOT call it files/a document, and do NOT say things like \"here are the files.\"\n\nThe user enters the screen-sharing (VNC) password to start it (their second factor) and clicks \"Take control\" to use the mouse and keyboard. This all happens on the user's end, you will NOT get any confirmation here that it connected, and you cannot see the screen yourself this way. Do NOT call screen_broadcast again (it's already open) and do NOT use screen_screenshot to 'check', just tell the user it's open and wait for them to say what they see or need.";
    return { content, isError };
  },

  async "open_browser"({ agentId, args }) {
    let content = '';
    const isError = false;
    const targetUrl = args.url as string;
    const title = typeof args.title === 'string' ? args.title : undefined;
    // Hybrid: many sites refuse iframe embedding (X-Frame-Options / CSP
    // frame-ancestors). Try a live iframe when allowed; otherwise render a
    // full-page screenshot server-side so SOMETHING always shows.
    const embeddable = await isEmbeddable(targetUrl);
    if (embeddable) {
      broadcast({ type: 'dock:open', agentId, data: { kind: 'iframe', url: targetUrl, title } });
      setCurrentCanvas(agentId, { kind: 'iframe', url: targetUrl, title });
      content = `Opened ${targetUrl} in the user's right dock.`;
      return { content, isError };
    }
    try {
      const png = await captureSiteScreenshot(targetUrl);
      const shotsDir = path.join(os.homedir(), '.dojo', 'data', 'canvas-shots');
      effectFs.mkdirSync(shotsDir, { recursive: true });
      const pngPath = path.join(shotsDir, `${uuidv4()}.png`);
      effectFs.writeFileSync(pngPath, png);
      let pngUrl = registerSharedFile(agentId, pngPath);
      if (!pngUrl) throw new Error('could not serve the screenshot file');
      // Render same-origin so the <img> resolves over localhost, a LAN IP,
      // or the tunnel, not just on the server's own machine.
      pngUrl = toDashboardPath(pngUrl);
      pngUrl += (pngUrl.includes('?') ? '&' : '?') + 'inline=1';
      broadcast({ type: 'dock:open', agentId, data: { kind: 'screenshot', url: pngUrl, sourceUrl: targetUrl, title } });
      setCurrentCanvas(agentId, { kind: 'screenshot', url: pngUrl, sourceUrl: targetUrl, title });
      content = `Note for you (relay this to the user): ${targetUrl} blocks being embedded in the dock (X-Frame-Options / CSP frame-ancestors), so a live, interactive view inside the canvas is not possible. Instead the tool captured a full-page screenshot and opened it in the user's right dock. That screenshot is a STATIC snapshot (links and buttons in it are not clickable), but the dock has an "Open in new window" button that opens the real, interactive site in a new browser tab. Tell the user it is a snapshot because the site can't be embedded, and that they can click "Open in new window" to use the live site.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Last resort: still hand the iframe over (may render partially).
      broadcast({ type: 'dock:open', agentId, data: { kind: 'iframe', url: targetUrl, title } });
      setCurrentCanvas(agentId, { kind: 'iframe', url: targetUrl, title });
      content = `Note for you (relay this to the user): ${targetUrl} blocks being embedded in the dock, and the screenshot fallback also failed (${msg}). The dock may show little or nothing. Tell the user the site can't be embedded and offer to open it directly in their browser instead.`;
    }
    return { content, isError };
  },

  async "canvas_read"({ agentId, args }) {
    let content = '';
    let isError = false;
    // C27: canvas_read reads ONLY the current canvas; the path/url/html
    // targets were dropped (open it first with canvas_render/open_browser).
    content = await viewCanvas(agentId, { prompt: args.prompt });
    isError = content.startsWith('Error');
    return { content, isError };
  },

};
