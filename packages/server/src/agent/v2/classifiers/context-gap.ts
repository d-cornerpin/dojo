// ════════════════════════════════════════
// Context-gap detector (remediation 2026-06-15, the "ask when stuck" design).
//
// Replaces the dropped deep caption-reorder (#5). Rather than have the engine
// INFER intent from a bare unlabeled photo, the engine detects the gaps it can
// reliably SEE and nudges the agent to ASK the user. This is the floor-safe
// half of "ask when you don't have enough context": the prompt carries the
// general judgment rule, and this catches the specific detectable conditions
// so we don't rely on a weak model noticing it's under-informed.
//
// v1 detects the clearest case: an attachment arrived with no text
// instruction. The nudge is an `[Engine hint]` (advice, lowest precedence) so
// it never overrides a real instruction, an active task, or a matching
// technique — the agent uses judgment on top. Add new detectable gaps here as
// distinct checks (missing required arg, dangling referent, disconnected
// integration the task needs).
// ════════════════════════════════════════

const ATTACHMENT_POINTER_RE = /\[(Image|PDF|Audio|Video|Office file|File) attached:/i;

// Strip the attachment pointer block and its boilerplate so we can see how
// much actual instruction the user typed alongside the attachment.
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

/**
 * Returns an advisory ask-the-user hint if the engine can see the agent lacks
 * enough to proceed, else null. Pure function: no I/O, easy to unit-test.
 */
export function detectContextGap(rawUserContent: string | null | undefined): string | null {
  if (!rawUserContent) return null;

  // Gap 1: attachment with no (or trivially short) text instruction. The user
  // sent a file but didn't say what to do with it.
  if (ATTACHMENT_POINTER_RE.test(rawUserContent)) {
    const instruction = userTextMinusAttachments(rawUserContent);
    const words = instruction.split(/\s+/).filter((w) => w.length > 1);
    if (words.length < 2) {
      return (
        `[Engine hint: an attachment arrived with little or no instruction. ` +
        `If you can't tell what the user wants done with it from context (an active task, a matching technique, or the recent conversation), ask them one specific question instead of guessing.]`
      );
    }
  }

  return null;
}
