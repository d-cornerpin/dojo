// ════════════════════════════════════════
// Agent Credential WRITE DOORS — what we tell the caller, and whether this is a change.
//
// One module for one job, extracted from `store.ts` by t120: every refusal text an agent can
// read out of the credential tools, plus the decision of whether an incoming payload is a
// change at all. It holds no database access on purpose — the store owns the writes, this owns
// the words and the judgement — so a reviewer auditing "does every door name a next step" has
// one file to read instead of a CRUD module to search.
//
// THE RULE THESE TEXTS SERVE (T83, and it has not moved): a write that would DESTROY a stored
// value refuses unless the caller passes `overwrite: true`, and the refusal names what it is
// protecting — created when, by whom, last changed when — and names the flag. t120 adds the
// second half: it also names the CALL that succeeds, with its arguments, because a refusal that
// leaves the caller guessing is answered by a retry, and a retry loop is what crossed the
// identical-call brake in two of the last three account-setup reds.
// ════════════════════════════════════════

import { openSecret } from './at-rest.js';

/** The row facts every door text is built out of. The store reads them; this module reads them only. */
export interface StoredRowFacts {
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by_agent_id: string | null;
  readonly description: string | null;
  readonly encrypted_credentials: Buffer;
  readonly iv: Buffer;
  readonly auth_tag: Buffer;
}

/**
 * t120 — THE OTHER HALF OF THE POINTER RULE, found by the census rather than by the triage.
 *
 * `credential_get`'s miss path has always ended with somewhere to go ("Call credential_list to
 * see what is stored, or ask the user to provide one and save it with credential_add"). The
 * WRITE doors' miss path said only `No credential found for service "x".` — a dead end on the
 * one branch whose next call is obvious and different per door: an update that finds nothing
 * wants `credential_add`, a delete that finds nothing is already done. Same defect shape as the
 * no-op receipt above, pointing the opposite way, so it closes in the same lane.
 */
export function missingRefusal(serviceName: string, verb: string): string {
  const next = verb === 'credential_update'
    ? `Nothing has been stored under that name yet, so there is no value to replace. If this is a ` +
      `credential the user has just handed you, store it with ` +
      `credential_add(service_name="${serviceName}", credentials={…}) — no overwrite flag is needed ` +
      `for a name that is free. If you expected it to exist, call credential_list() to see the names ` +
      `that ARE stored; the name is case-sensitive.`
    : `Nothing is stored under that name, so there is nothing to remove and no further call is ` +
      `needed. If you expected it to exist, call credential_list() to see the names that ARE ` +
      `stored; the name is case-sensitive.`;
  return `No credential found for service "${serviceName}". ${next}`;
}

/**
 * The READ door's text for a row this master key cannot open.
 *
 * t120: it said "Delete and re-add the credential" — the acts, but neither call. This is the
 * one refusal in the family a caller cannot reason its way out of, so it spells both, and says
 * outright that a retry will fail identically. A read that cannot teach is a read that gets
 * repeated.
 */
export function undecryptableRefusal(serviceName: string): string {
  return (
    `Credential "${serviceName}" cannot be decrypted (the master key was likely rotated), so its ` +
    `stored value is unrecoverable. Ask the user for a replacement value, then call ` +
    `credential_add(service_name="${serviceName}", credentials={…}, overwrite=true) to seal the new ` +
    `one under the same name. Do not retry this read — it will fail the same way every time.`
  );
}

/**
 * The DELETE door text (T83 fix round). Same discipline as the overwrite door below, plus the
 * one sentence that only belongs here: a caller who merely wants to replace a value is
 * redirected to `credential_update`, because a delete-then-add throws away the row's
 * provenance — which is the fact every future refusal is built out of.
 */
export function deleteRefusal(serviceName: string, row: StoredRowFacts): string {
  const by = row.created_by_agent_id ? ` by ${row.created_by_agent_id}` : '';
  const changed = row.updated_at !== row.created_at ? `, last changed ${row.updated_at}` : '';
  return (
    `"${serviceName}" is a stored credential — created ${row.created_at}${by}${changed}. ` +
    `Deleting it is permanent: the value is gone, there is no recycle bin and no prior version. ` +
    `If the user explicitly asked you to remove this credential, call ` +
    `credential_delete(service_name="${serviceName}", confirm=true) and the deletion will be recorded. ` +
    `If you are only replacing its value, do NOT delete it — call ` +
    `credential_update(service_name="${serviceName}", credentials={…}, overwrite=true) instead, which keeps ` +
    `the row's history of who created it and when. If you are unsure, ask the user before removing anything.`
  );
}

/**
 * The OVERWRITE door text. States what exists, says the prior value cannot be recovered, and
 * names the flag — in that order, because a caller who reads only the first sentence should
 * still have learned the thing that matters.
 */
export function overwriteRefusal(serviceName: string, row: StoredRowFacts, verb: string): string {
  const by = row.created_by_agent_id ? ` by ${row.created_by_agent_id}` : '';
  const changed = row.updated_at !== row.created_at ? `, last changed ${row.updated_at}` : '';
  return (
    `A credential is already stored under "${serviceName}" — created ${row.created_at}${by}${changed}. ` +
    `Replacing it destroys the stored value permanently; there is no prior version and no undo. ` +
    `If the user has genuinely handed you a replacement for THIS credential, call ` +
    `${verb}(service_name="${serviceName}", credentials={…}, overwrite=true) and the overwrite will be ` +
    `recorded. If you are storing a DIFFERENT service's key, pick a service_name that is not taken — ` +
    `credential_list() shows which names are in use. ` +
    // t120: the third case, and the one the two failed draws were actually in — the caller is
    // re-sending a value that is ALREADY in this slot. Naming it here costs one sentence and is
    // the only branch whose right answer is "write nothing at all".
    `If you think the value already stored here is the same one you were about to write, do NOT ` +
    `write it again: call credential_get(service_name="${serviceName}") to confirm it is there. ` +
    `If you are unsure which of these this is, ask the user before writing anything.`
  );
}

// ════════════════════════════════════════
// t120 — A WRITE THAT CHANGES NOTHING SAYS SO.
//
// THE DEFECT, measured off the two failed account-setup draws rather than inferred. The
// triage's stated mechanism was `credential_add` refusing on an existing name and the model
// retrying `credential_update`. The run evidence says otherwise: in BOTH reds every credential
// write SUCCEEDED and no refusal was ever issued. What the model actually did was re-send the
// SAME payload to the SAME slot — byte-identical `credentials`, byte-identical description,
// `overwrite: true` — eight times in one attempt and thirteen in another, until the
// identical-call brake blocked calls 4, 5 and 6 and the turn tripped a SAFETY invariant.
//
// WHY it did that: the receipt. A successful re-write returned `Credential "x" updated.` —
// three words that do not say whether anything changed, do not say the credential is ready to
// use, and name no next call. So nothing in the loop ever told the model its write had landed,
// and the cheapest way to check was to write again. The N-1 messages that failed to teach here
// were SUCCESS messages, not refusals. T83's own header already recorded this receipt as the
// whole of what the caller got; it fixed the authorisation and left the text.
//
// THE PROPERTY, two halves that have to hold together:
//   1. A write whose payload equals what is already sealed in the row writes NOTHING — no
//      re-seal, no `updated_at` bump, and above all NO destruction audit row. The T83 ledger
//      exists to record that a specific stored value was ended; a no-op ended nothing, and a
//      ledger that claims three unrecoverable destructions for three writes of identical bytes
//      is lying in the one place this project cannot afford a lie.
//   2. The caller is TOLD, in the result, that the value was already there and what to call
//      next. That is the half that closes the loop.
//
// A row whose ciphertext cannot be opened (master key rotated) is treated as NOT identical, so
// the overwrite proceeds exactly as it does today: the recovery path must never be blocked by
// a comparison that cannot be made.
// ════════════════════════════════════════

/**
 * Is `credentials` byte-for-byte what this row already holds?
 *
 * Compared on the PLAINTEXT, canonically keyed — never on the ciphertext, which carries a
 * random IV per seal and so differs on every write of the same value.
 */
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

/**
 * The note a no-op write should apply, or `null` for "leave the column alone".
 *
 * A no-op NEVER clears the existing note: `description` arrives as `null` from `credential_add`
 * whenever the caller simply omitted it, and a write that changed nothing has no business
 * dropping the one column that records what the slot is FOR. A deliberate clear goes through
 * `annotateCredential`, which is the door that says so.
 */
export function noteToApply(incoming: string | null | undefined, existing: string | null): string | null {
  const note = typeof incoming === 'string' && incoming.trim() !== '' ? incoming : null;
  return note !== null && note !== existing ? note : null;
}

// ════════════════════════════════════════
// t120 — THE RECEIPT IS THE AFFORDANCE.
//
// Both failed account-setup draws looped here, and neither looped on a refusal: every write
// succeeded and the model re-sent the identical payload until the identical-call brake blocked
// it and the turn failed a SAFETY invariant. `credential_update`'s whole receipt was
// `Credential "x" updated.` — it named no state and no next call, so the model had no way to
// learn its write had landed and the cheapest check available to it was writing again.
//
// So every write result now ends with the SAME next step `credential_add`'s success has always
// ended with (`credential_get(service_name=…)`), and a write that changed nothing says that
// plainly instead of reporting as a change. This is per-turn tool-result text: no tool
// description moves, so the assembled prompt prefix is byte-unchanged (G2).
//
// It lives here rather than in `tools.ts` because this module is where the words live: every
// text an agent can read out of the credential tools, refusal and receipt alike, in one file.
// ════════════════════════════════════════

/**
 * What a write that changed nothing tells the caller.
 *
 * Says the value is already there, says nothing was destroyed (the honest counterpart of the
 * T83 destruction ledger, which no longer records a row for this case), names the one call that
 * is actually useful next, and says outright not to repeat the write — because the model that
 * repeated it is the reader.
 */
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
