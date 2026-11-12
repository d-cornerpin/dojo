// Every text an agent reads from the credential write doors, plus the is-this-a-change judgement; no DB
// access here, store.ts owns the writes. Refusals name what is protected and the exact call that succeeds.

import { openSecret } from './at-rest.js';

/** The row facts every door text is built from. */
export interface StoredRowFacts {
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by_agent_id: string | null;
  readonly description: string | null;
  readonly encrypted_credentials: Buffer;
  readonly iv: Buffer;
  readonly auth_tag: Buffer;
}

/** Write-door miss text: an update points to credential_add, a delete says nothing remains to do. */
export function missingRefusal(serviceName: string, verb: string): string {
  const next = verb === 'credential_update'
    ? `Nothing has been stored under that name yet, so there is no value to replace. If this is a ` +
      `credential the person you are talking to has just handed you, store it with ` +
      `credential_add(service_name="${serviceName}", credentials={…}) — no overwrite flag is needed ` +
      `for a name that is free. If you expected it to exist, call credential_list() to see the names ` +
      `that ARE stored; the name is case-sensitive.`
    : `Nothing is stored under that name, so there is nothing to remove and no further call is ` +
      `needed. If you expected it to exist, call credential_list() to see the names that ARE ` +
      `stored; the name is case-sensitive.`;
  return `No credential found for service "${serviceName}". ${next}`;
}

/** Read-door text for a row this master key cannot open; spells the recovery call, says a retry fails. */
export function undecryptableRefusal(serviceName: string): string {
  return (
    `Credential "${serviceName}" cannot be decrypted (the master key was likely rotated), so its ` +
    `stored value is unrecoverable. Ask the person you are talking to for a replacement value, then call ` +
    `credential_add(service_name="${serviceName}", credentials={…}, overwrite=true) to seal the new ` +
    `one under the same name. Do not retry this read — it will fail the same way every time.`
  );
}

/** Delete-door text; a pure replace is redirected to credential_update so the row keeps its provenance. */
export function deleteRefusal(serviceName: string, row: StoredRowFacts): string {
  const by = row.created_by_agent_id ? ` by ${row.created_by_agent_id}` : '';
  const changed = row.updated_at !== row.created_at ? `, last changed ${row.updated_at}` : '';
  return (
    `"${serviceName}" is a stored credential — created ${row.created_at}${by}${changed}. ` +
    `Deleting it is permanent: the value is gone, there is no recycle bin and no prior version. ` +
    `If the person you are talking to explicitly asked you to remove this credential, call ` +
    `credential_delete(service_name="${serviceName}", confirm=true) and the deletion will be recorded. ` +
    `If you are only replacing its value, do NOT delete it — call ` +
    `credential_update(service_name="${serviceName}", credentials={…}, overwrite=true) instead, which keeps ` +
    `the row's history of who created it and when. If you are unsure, ask the person you are talking to before removing anything.`
  );
}

/** Overwrite-door text: what exists first, then that it is unrecoverable, then the flag. */
export function overwriteRefusal(serviceName: string, row: StoredRowFacts, verb: string): string {
  const by = row.created_by_agent_id ? ` by ${row.created_by_agent_id}` : '';
  const changed = row.updated_at !== row.created_at ? `, last changed ${row.updated_at}` : '';
  return (
    `A credential is already stored under "${serviceName}" — created ${row.created_at}${by}${changed}. ` +
    `Replacing it destroys the stored value permanently; there is no prior version and no undo. ` +
    `If the person you are talking to has genuinely handed you a replacement for THIS credential, call ` +
    `${verb}(service_name="${serviceName}", credentials={…}, overwrite=true) and the overwrite will be ` +
    `recorded. If you are storing a DIFFERENT service's key, pick a service_name that is not taken — ` +
    `credential_list() shows which names are in use. ` +
    // The third case: re-sending a value already in this slot, where the right answer is to write nothing.
    `If you think the value already stored here is the same one you were about to write, do NOT ` +
    `write it again: call credential_get(service_name="${serviceName}") to confirm it is there. ` +
    `If you are unsure which of these this is, ask the person you are talking to before writing anything.`
  );
}

// A write whose payload equals the sealed value writes nothing (no re-seal, no updated_at bump, no
// destruction audit row) and the caller is told so. An unopenable row counts as changed so recovery proceeds.

/** Compared on canonical plaintext, never ciphertext (a random IV makes every seal differ). */
export function isUnchangedWrite(row: StoredRowFacts, credentials: Record<string, unknown>): boolean {
  let plaintext: string;
  try {
    plaintext = openSecret(row.encrypted_credentials, row.iv, row.auth_tag);
  } catch {
    return false;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(plaintext);
  } catch {
    return false;
  }
  return canonicalJson(stored) === canonicalJson(credentials);
}

/** Stable key order, so `{a,b}` and `{b,a}` are the one value they are. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>).sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** The note a no-op write applies, or null. Never clears the stored note: an omitted one arrives as null. */
export function noteToApply(incoming: string | null | undefined, existing: string | null): string | null {
  const note = typeof incoming === 'string' && incoming.trim() !== '' ? incoming : null;
  return note !== null && note !== existing ? note : null;
}

// Every write result ends with the next call (credential_get). Tool-result text only: no tool description
// changes, so the cached prompt prefix is untouched.

/** No-op write receipt: already stored, nothing destroyed, use credential_get, do not repeat the write. */
export function unchangedReceipt(serviceName: string, descriptionChanged: boolean): string {
  const note = descriptionChanged
    ? ' Its description was updated to the note you passed.'
    : '';
  return (
    `Credential "${serviceName}" already holds exactly these values — nothing was written, and ` +
    `no stored value was destroyed.${note} The credential is saved and ready to use: call ` +
    `credential_get(service_name="${serviceName}") at the moment you make the API call. ` +
    `Do NOT send this value again — it is already stored, and repeating an identical write is ` +
    `what the engine's identical-call brake stops.`
  );
}
