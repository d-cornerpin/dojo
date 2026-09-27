// ════════════════════════════════════════════════════════════════════════════
// THE OWNER WAS SHOWN `<redacted-credential:c1>` AND TOLD NOTHING BY IT.
//
// ── THE DEFECT ──
// When an agent's reply would have carried a credential the platform is holding,
// the engine substitutes a placeholder — `<redacted-credential:c1>`, or the bare
// `<redacted-credential>` for a value with no in-process handle. That is exactly
// right on the wire: the round-8 incident is the owner asking for his gate code
// and the value being stored, replayed and re-typed by the model. What was NOT
// right is what the chat then DREW: the literal token, angle brackets and all,
// rendered as body text. The owner reads gibberish where a value should be and
// nothing tells him the value exists, is safe, or where to look.
//
// ── WHY A RULE HERE AND A CHIP THERE ──
// A component runner arrived on 2026-09-26; the rules that are DECISIONS still belong
// in a pure module the server suite can drive. So the DECISION — is this span a placeholder, and
// which handle does it name — lives in this pure module where the server's suite
// can drive it, and `components/Markdown.tsx` does nothing but draw what it is
// told. The precedent is `lib/dates.ts` + `server/src/__tests__/dashboard-dates.test.ts`.
//
// ── THE PATTERN IS A SECOND COPY, AND IT IS HELD BY A CENSUS ──
// The authority is `server/src/credentials/secret-values.ts`, whose own
// `PLACEHOLDER_RE` is private to the leak guard — deliberately, and it is not
// worth widening a security module's surface to share a regex. So this is a
// second copy, and the drift is caught rather than trusted: the server suite
// drives the REAL redactor's output through this splitter and fails if the two
// ever stop agreeing (`a-hidden-credential-reads-as-a-chip.test.ts`).
//
// ── WHAT IS DELIBERATELY NOT TOUCHED ──
// `CREDENTIAL_STALE_PLACEHOLDER` — "<credential not in context — call
// credential_get to fetch it again>" — is left exactly as it is. It is already a
// self-describing English sentence and its own header states that naming the
// tool is the point, so substituting it would remove information rather than add
// any. It is agent-facing text that reads as a sentence, not as a token.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Both forms the engine writes, mirroring `secret-values.ts`'s private
 * `PLACEHOLDER_RE`: tagged (`:c1`, an in-process handle) and bare (a declared
 * secret field, or a row written before the tagged form existed).
 *
 * The tag alphabet is `[a-z0-9]+` and NOT `\w` on purpose — it has to refuse
 * what the engine would never write, or an ordinary sentence mentioning
 * `<redacted-credential:SOMETHING>` would be drawn as a real chip.
 */
export const CREDENTIAL_PLACEHOLDER_SOURCE = '<redacted-credential(?::([a-z0-9]+))?>';

/** Anchored at a leading run of non-placeholder text, for the inline renderer's
 *  candidate scan: `[1]` is the text before, `[2]` the handle (or undefined). */
export function credentialPlaceholderLeadingRe(): RegExp {
  return new RegExp(`^(.*?)${CREDENTIAL_PLACEHOLDER_SOURCE}`, 's');
}

/** One span of a message: ordinary text, or a credential the platform is holding. */
export type CredentialSegment =
  | { kind: 'text'; text: string }
  | { kind: 'credential'; tag: string | null };

/** True when this text carries at least one placeholder the renderer must replace. */
export function hasCredentialPlaceholder(text: string): boolean {
  return new RegExp(CREDENTIAL_PLACEHOLDER_SOURCE).test(text);
}

/**
 * Split a string into drawable spans. Text runs are preserved byte-for-byte —
 * including empty-string gaps being DROPPED rather than emitted — so a caller
 * can concatenate the `text` segments and get the original minus the
 * placeholders, and nothing else has been rewritten on the way past.
 */
export function splitCredentialPlaceholders(text: string): CredentialSegment[] {
  const re = new RegExp(CREDENTIAL_PLACEHOLDER_SOURCE, 'g');
  const out: CredentialSegment[] = [];
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    out.push({ kind: 'credential', tag: m[1] ?? null });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * THE WORDS ON THE CHIP.
 *
 * Plain language, no tool names: the owner is not an API caller, and the one
 * thing he needs to know is that a real value is there and the platform is
 * holding it rather than having lost it.
 */
export const CREDENTIAL_CHIP_LABEL = 'credential hidden';

/**
 * WHERE THE VALUE ACTUALLY IS, and it is NOT the Vault.
 *
 * The BACKLOG line that asked for this chip says "view in Vault tab", which is
 * the ticket's shorthand — the Vault is long-term MEMORY, and a credential is
 * not in it. The owner's credentials are on the Memory page's own **Credentials**
 * tab (`Memory.tsx`'s `MainTab`, rendered by `CredentialsPanel`), so that is what
 * the chip names. Sending someone to the wrong tab to look for a secret is worse
 * than saying nothing.
 *
 * Named rather than LINKED because that tab is local component state with no
 * query-param deep link; inventing one is a separate change, not part of
 * replacing a broken string.
 */
export const CREDENTIAL_CHIP_HINT = 'Stored safely — see Memory → Credentials';

/** The tooltip: the hint, plus which handle this span named when it had one. */
export function credentialChipTitle(tag: string | null): string {
  return tag ? `${CREDENTIAL_CHIP_HINT} (${tag})` : CREDENTIAL_CHIP_HINT;
}
