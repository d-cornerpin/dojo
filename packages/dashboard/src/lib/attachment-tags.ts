/** The model-only pointer blocks are always appended last, so strip from the first marker to the end. */
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
