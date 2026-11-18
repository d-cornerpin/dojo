// ════════════════════════════════════════════════════════════════════════════
// CANVAS & SHARED WORKSPACE: `canvas_render`, `canvas_read`, `open_browser`, `screen_broadcast`.
// `toDashboardPath` rewrites canvas URLs only: never a share link (a person needs its absolute host)
// and never an external `args.url`. The download URL bakes in a host that only fits the server's own
// machine, and the canvas renders inside the dashboard. The canvas-open cluster lives, one copy, in `../util.ts`.
// ════════════════════════════════════════════════════════════════════════════

import * as effectFs from '../../effects/fs.js';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../../../gateway/ws.js';
import { setCurrentCanvas } from '../../canvas-state.js';
import { viewCanvas } from '../../canvas-view.js';
import { isEmbeddable, captureSiteScreenshot } from '../../site-snapshot.js';
import { queueScreenChip } from '../../pending-attachments.js';
import { resolvePath, sharePathGuard } from '../../path-guards.js';
import { auditLog, permissionDeniedMessage, registerSharedFile, toDashboardPath, queueCanvasDocAttachment } from '../util.js';
import { isScreenShareEnabled } from '../../../screen-share/manager.js';
import type { ToolHandlerMap } from '../handler.js';
import { homeDir } from '../../../home.js';

export const canvasHandlers: ToolHandlerMap = {
  async "canvas_render"({ agentId, args }) {
    let content = '';
    let isError = false;
    const html = typeof args.html === 'string' ? args.html : undefined;
    let url = typeof args.url === 'string' ? args.url : undefined;
    const rawPath = typeof args.path === 'string' ? args.path : undefined;
    let canvasPath: string | undefined;
    // `path`: register the on-disk file so the canvas can fetch it, and remember it so edits auto-refresh.
    if (rawPath) {
      // THE GUARD ITS SIBLINGS RUN: `registerSharedFile` mints the same unauthenticated URL
      // `share_file` mints, so the share surface's sensitive tier is asked too.
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
      // Same-origin path via toDashboardPath so the canvas resolves over localhost, a LAN IP or the tunnel.
      url = toDashboardPath(registered);
    }
    if (!html && !url) {
      content = 'Error: canvas_render requires one of `path` (a file on disk), `html` (markup to render), or `url` (a page/file to load).';
      isError = true;
      return { content, isError };
    }
    // `url` is a web address or a dashboard path; a file on this Mac goes through `path` and its checks.
    if (url && !canvasPath && !/^https?:\/\//i.test(url) && !/^\/(?!\/)/.test(url)) {
      return { content: 'Error: canvas_render takes a web address (http:// or https://) in `url`. To show a file on this Mac, pass it as `path` instead.', isError: true };
    }
    // Our own download URLs serve Content-Disposition: attachment, which makes the canvas iframe
    // download instead of render; flip them to inline. External URLs are left alone.
    if (url && /\/api\/upload\/download\/[^?#]+/.test(url) && !/[?&]inline=1\b/.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'inline=1';
    }
    const title = typeof args.title === 'string' ? args.title : undefined;
    broadcast({ type: 'dock:open', agentId, data: { kind: 'canvas', html, url, title, path: canvasPath } });
    setCurrentCanvas(agentId, { kind: 'canvas', html, url, path: canvasPath, title });
    if (canvasPath) queueCanvasDocAttachment(agentId, canvasPath, url ?? null);
    content = `Canvas opened in the user's right dock${title ? ` ("${title}")` : ''}. The user can now see it.${canvasPath ? ' Edits you make to this file (file_write/file_patch/file_append) will refresh the canvas automatically.' : ''} Call canvas_read if you need to look at it yourself.`;
    return { content, isError };
  },

  async "screen_broadcast"({ agentId, args }) {
    let content = '';
    const isError = false;
    if (!isScreenShareEnabled()) {
      content = "Screen sharing is OFF (it's disabled by default). It's a one-time setup done on this Mac. Offer to walk the user through it, then tell them these steps:\n\n" +
        "1. Open Settings → Integrations → Screen Sharing and click Enable. A macOS admin-password prompt will appear ON THIS MAC, approve it. (macOS may also ask to approve Screen Sharing in System Settings → Privacy & Security; approve that too.)\n" +
        "2. Set a screen-sharing password they'll remember: open System Settings → General → Sharing, click the (i) next to Screen Sharing → Computer Settings, check \"VNC viewers may control screen with password\", and set a password.\n" +
        "3. That's it. When you open the screen for them, they'll type that password to connect, and click \"Take control\" to use the mouse and keyboard.\n\n" +
        "Note: this one-time setup has to be done while at this Mac (the prompts appear on it). If they can see the screen later but can't control it, have them make sure macOS \"Remote Management\" is turned off (it can limit connections to view-only) and just \"Screen Sharing\" is on. Once they've enabled it, call screen_broadcast again.";
      return { content, isError };
    }
    const screenTitle = typeof args.title === 'string' ? args.title : undefined;
    // A live screen share has no persisted per-agent slot: it is a transient view, not a canvas.
    // Still stamp agentId so the dashboard's per-agent filter opens it only for this agent's viewer.
    broadcast({ type: 'dock:open', agentId, data: { kind: 'screen', title: screenTitle } });
    queueScreenChip(agentId);
    content = "A LIVE view of this Mac's screen is now open in the user's canvas. This is NOT a file, document, or attachment, it is your actual screen, streaming in real time. When you reply, say something like \"I've put my screen up for you\" or \"my screen is open, go ahead and take control to click what you need.\" Do NOT call it files/a document, and do NOT say things like \"here are the files.\"\n\nThe user enters the screen-sharing (VNC) password to start it (their second factor) and clicks \"Take control\" to use the mouse and keyboard. This all happens on the user's end, you will NOT get any confirmation here that it connected, and you cannot see the screen yourself this way. Do NOT call screen_broadcast again (it's already open) and do NOT use screen_screenshot to 'check', just tell the user it's open and wait for them to say what they see or need.";
    return { content, isError };
  },

  async "open_browser"({ agentId, args }) {
    let content = '';
    const isError = false;
    const targetUrl = args.url as string;
    const title = typeof args.title === 'string' ? args.title : undefined;
    // Hybrid: many sites refuse iframe embedding (X-Frame-Options / CSP frame-ancestors); try a live
    // iframe when allowed, else a full-page screenshot so something always shows.
    const embeddable = await isEmbeddable(targetUrl, agentId);
    if (embeddable) {
      broadcast({ type: 'dock:open', agentId, data: { kind: 'iframe', url: targetUrl, title } });
      setCurrentCanvas(agentId, { kind: 'iframe', url: targetUrl, title });
      content = `Opened ${targetUrl} in the user's right dock.`;
      return { content, isError };
    }
    try {
      const png = await captureSiteScreenshot(targetUrl, agentId);
      const shotsDir = path.join(homeDir(), '.dojo', 'data', 'canvas-shots');
      effectFs.mkdirSync(shotsDir, { recursive: true });
      const pngPath = path.join(shotsDir, `${uuidv4()}.png`);
      effectFs.writeFileSync(pngPath, png);
      let pngUrl = registerSharedFile(agentId, pngPath);
      if (!pngUrl) throw new Error('could not serve the screenshot file');
      // Same-origin so the <img> resolves over localhost, a LAN IP or the tunnel.
      pngUrl = toDashboardPath(pngUrl);
      pngUrl += (pngUrl.includes('?') ? '&' : '?') + 'inline=1';
      broadcast({ type: 'dock:open', agentId, data: { kind: 'screenshot', url: pngUrl, sourceUrl: targetUrl, title } });
      setCurrentCanvas(agentId, { kind: 'screenshot', url: pngUrl, sourceUrl: targetUrl, title });
      content = `Note for you (relay this to the user): ${targetUrl} blocks being embedded in the dock (X-Frame-Options / CSP frame-ancestors), so a live, interactive view inside the canvas is not possible. Instead the tool captured a full-page screenshot and opened it in the user's right dock. That screenshot is a STATIC snapshot (links and buttons in it are not clickable), but the dock has an "Open in new window" button that opens the real, interactive site in a new browser tab. Tell the user it is a snapshot because the site can't be embedded, and that they can click "Open in new window" to use the live site.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'dock:open', agentId, data: { kind: 'iframe', url: targetUrl, title } });
      setCurrentCanvas(agentId, { kind: 'iframe', url: targetUrl, title });
      content = `Note for you (relay this to the user): ${targetUrl} blocks being embedded in the dock, and the screenshot fallback also failed (${msg}). The dock may show little or nothing. Tell the user the site can't be embedded and offer to open it directly in their browser instead.`;
    }
    return { content, isError };
  },

  async "canvas_read"({ agentId, args }) {
    let content = '';
    let isError = false;
    // canvas_read reads ONLY the current canvas: no path/url/html targets; open it first.
    content = await viewCanvas(agentId, { prompt: args.prompt });
    isError = content.startsWith('Error');
    return { content, isError };
  },

};
