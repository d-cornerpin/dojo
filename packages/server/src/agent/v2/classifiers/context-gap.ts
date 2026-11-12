// Detects the context gaps the engine can SEE and returns an `[Engine hint]`
// (advice, lowest precedence) nudging the agent to ASK instead of guessing.
// No I/O: the prompt carries the general rule, this catches detectable conditions.

const ATTACHMENT_POINTER_RE = /\[(Image|PDF|Audio|Video|Office file|File) attached:/i;

// Strip the attachment pointer and its boilerplate: only the user's own words count.
function userTextMinusAttachments(raw: string): string {
  let s = raw;
  s = s.replace(/\[(Image|PDF|Audio|Video|Office file|File) attached:[^\]]*\]/gi, ' ');
  s = s.replace(/^\s*Path:.*$/gim, ' ');
  s = s.replace(/\bfileId:\s*\S+/gi, ' ');
  s = s.replace(/If your model supports (?:vision|PDF input)[^\n]*/gi, ' ');
  s = s.replace(/Use file_read with this path[^\n]*/gi, ' ');
  s = s.replace(/To (?:send|forward|transcribe|hear|use)[^\n]*/gi, ' ');
  s = s.replace(/Do not open image files[^\n]*/gi, ' ');
  s = s.replace(/The pdf_\*[^\n]*/gi, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

export function detectContextGap(rawUserContent: string | null | undefined): string | null {
  if (!rawUserContent) return null;

  if (ATTACHMENT_POINTER_RE.test(rawUserContent)) {
    const instruction = userTextMinusAttachments(rawUserContent);
    const words = instruction.split(/\s+/).filter((w) => w.length > 1);
    if (words.length < 2) {
      return (
        `[Engine hint: an attachment arrived with little or no instruction. ` +
        `If you can't tell what the person you are talking to wants done with it from context (an active task, a matching technique, or the recent conversation), ask them one specific question instead of guessing.]`
      );
    }
  }

  return null;
}
