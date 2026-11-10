
/** [a-z0-9]+ and not \w: the pattern refuses tags the engine never writes, so prose never draws as a chip. */
export const CREDENTIAL_PLACEHOLDER_SOURCE = '<redacted-credential(?::([a-z0-9]+))?>';

export type CredentialSegment =
  | { kind: 'text'; text: string }
  | { kind: 'credential'; tag: string | null };

/** Empty gaps are dropped, so concatenating the text spans returns the original minus the placeholders. */
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

export const CREDENTIAL_CHIP_LABEL = 'credential hidden';

/** Names Memory's Credentials tab, not the Vault (a credential isn't memory); named, not linked. */
export const CREDENTIAL_CHIP_HINT = 'Stored safely, see Memory → Credentials';

export function credentialChipTitle(tag: string | null): string {
  return tag ? `${CREDENTIAL_CHIP_HINT} (${tag})` : CREDENTIAL_CHIP_HINT;
}
