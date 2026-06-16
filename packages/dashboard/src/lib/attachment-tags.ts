/**
 * Strip the engine-injected attachment pointer blocks from a user message's
 * content for display. The server (chat.ts buildContentWithAttachments) appends,
 * AFTER the user's typed text, a pointer block per attachment so the agent knows
 * the file's path / fileId / how to act on it:
 *
 *   here
 *
 *   [Image attached: photo.jpg (1259579 bytes), fileId: 6ffa...]
 *   Path: /Users/.../uploads/kevin/...jpg
 *   If your model supports vision, this image is shown to you ... attachment_id="...".
 *
 * That boilerplate is for the model, not the user — the chat renders the file
 * itself as an attachment chip. This removes the pointer blocks so the bubble
 * shows just what the user typed. Used by every chat UserBubble when wordy mode
 * is OFF; wordy mode shows the raw content (pointer blocks included) for
 * debugging. Categories: File, Office, Audio, Video, Image, PDF (+ legacy inline
 * file dumps). Since the blocks are always appended last, this strips from the
 * first pointer marker to the end.
 */
const ATTACHMENT_POINTER_RE =
  /\n+\[(?:File|Office file|Audio|Video|Image|PDF) attached:[\s\S]*$/;

const LEGACY_FILE_DUMP_RE = /\n=== File: .+? ===\n[\s\S]*?\n=== End File ===/g;

export function stripAttachmentTags(content: string): string {
  if (!content) return content;
  return content
    .replace(ATTACHMENT_POINTER_RE, '')
    .replace(LEGACY_FILE_DUMP_RE, '')
    .trim();
}
