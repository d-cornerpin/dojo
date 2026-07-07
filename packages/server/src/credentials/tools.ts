// ════════════════════════════════════════
// Agent Credentials Tools
// 5 tools agents call from inside techniques to manage API credentials
// for third-party services the user has them connect to.
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';
import { CREDENTIAL_FRESH_SENTINEL } from '../memory/compaction.js';
import {
  listCredentials,
  getCredentialByService,
  addCredential,
  updateCredential,
  deleteCredentialByService,
} from './store.js';

export const credentialsToolDefinitions: ToolDefinition[] = [
  {
    name: 'credential_list',
    description: '**This is the canonical place credentials live in the dojo.** API keys, OAuth tokens, PATs, passwords, secrets, and any other authentication material belong here — NEVER in vault_remember (the engine will refuse credential-shaped vault entries). Lists the names + descriptions of all stored credentials. **Never returns the actual credential values** - use credential_get for that. Useful at the start of a technique that needs a credential, so you know what is already saved and what you may need to ask the user for.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'credential_get',
    description: 'Retrieve a credential by service name. Returns the credential payload (an object with whatever fields the agent stored - api_key, token, secret, etc.). Use this at API-call time inside a technique; do NOT echo the returned values back into chat or store them elsewhere. Every read is audit-logged with timestamp + which agent accessed it.',
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Service name the credential is stored under (e.g. "openweather", "github_pat", "shopify"). Case-sensitive. Use credential_list to discover what is stored.' },
      },
      required: ['service_name'],
    },
  },
  {
    name: 'credential_add',
    description: '**This is the ONLY place credentials should be stored in the dojo. Never put API keys, tokens, passwords, or secrets in vault_remember — the engine will refuse those entries.** When the user hands you any value labeled secret/key/token/password/credential (whether for a technique you are building, a placeholder you are filling, or a service the user wants connected), store it here. Pass `credentials` as an OBJECT with whatever fields the service needs (e.g. {api_key: "..."} for a single-key API, or {api_key: "...", workspace_id: "...", secret: "..."} for a multi-field API). Description should be short but specific - what is the credential for, when did the user provide it, what service does it authenticate against. Fails if a credential for that service_name already exists - use credential_update to change an existing one.',
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Short identifier (lowercase, no spaces; e.g. "openweather", "github_pat", "shopify_admin"). Used as the key for credential_get / credential_update / credential_delete later.' },
        credentials: { type: 'object', description: 'The credential payload as an object. Single-key APIs: {api_key: "..."}. Multi-key: include each field the API requires.' },
        description: { type: 'string', description: 'Short note about what the credential is for and where the user got it (e.g., "OpenWeatherMap free-tier API key, provided by user on 2026-05-25 for the weather-dashboard technique").' },
      },
      required: ['service_name', 'credentials'],
    },
  },
  {
    name: 'credential_update',
    description: 'Update an existing credential. Pass the same service_name and the new credentials object. Optionally pass a new description; omit to leave the existing description unchanged. Use when the user rotates a token or replaces an API key.',
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Service name of the credential to update.' },
        credentials: { type: 'object', description: 'New credential payload (replaces the existing one entirely).' },
        description: { type: 'string', description: 'Optional new description.' },
      },
      required: ['service_name', 'credentials'],
    },
  },
  {
    name: 'credential_delete',
    description: 'Permanently delete a credential by service name. Use only when the user explicitly asks to remove it (e.g., they revoked the token, or the technique is no longer needed). Deletion is irreversible - no recycle bin.',
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Service name of the credential to delete.' },
      },
      required: ['service_name'],
    },
  },
];

// ── Credential-value leak scrub (NEXT-WAVE item 5, architecture rule 6) ──
// A secret handed to an agent by credential_get can end up inline in a shell
// command (the classic `sshpass -p '<pw>'`), and that command string is
// persisted in the agent's tool_use content in `messages` and broadcast to the
// dashboard, which violates rule 6 (secrets never in message content). We can't
// stop the model from constructing such a command, but we CAN keep the value out
// of the persisted/broadcast copy: track every secret value credential_get hands
// out (per agent, in-process only), then redact those values from the stored copy
// of the command while the live command still runs with the real value.
//
// In-memory only (never persisted, matching where secrets are allowed to live).
// Length-gated (>= 6 chars) so we never redact trivial values ("1", "on") that
// would appear all over normal commands.
const MIN_REDACTABLE_CREDENTIAL_LEN = 6;
const handedCredentialValues = new Map<string, Set<string>>();

/** Record the secret values credential_get just handed this agent, so they can
 *  be scrubbed out of any persisted/broadcast tool call. In-process only. */
export function noteHandedCredentialValues(agentId: string, values: string[]): void {
  if (values.length === 0) return;
  let set = handedCredentialValues.get(agentId);
  if (!set) { set = new Set<string>(); handedCredentialValues.set(agentId, set); }
  for (const v of values) {
    if (typeof v === 'string' && v.length >= MIN_REDACTABLE_CREDENTIAL_LEN) set.add(v);
  }
}

/** True if this agent has pulled any redactable credential value this process. */
export function hasHandedCredentialValues(agentId: string): boolean {
  const set = handedCredentialValues.get(agentId);
  return !!set && set.size > 0;
}

/** Replace any credential value this agent pulled via credential_get with a
 *  placeholder. Returns the input unchanged when nothing matches (the common
 *  case), so it's cheap to call on every persisted string. */
export function redactHandedCredentials(agentId: string, text: string): string {
  const set = handedCredentialValues.get(agentId);
  if (!set || set.size === 0 || !text) return text;
  let out = text;
  for (const secret of set) {
    if (out.includes(secret)) out = out.split(secret).join('<redacted-credential>');
  }
  return out;
}

// ── Executor ──

export async function executeCredentialTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
): Promise<string> {
  switch (name) {
    case 'credential_list': {
      const records = listCredentials();
      if (records.length === 0) {
        return 'No credentials stored. Use credential_add to save one when the user provides it.';
      }
      const lines = records.map(r => {
        const desc = r.description ? ` - ${r.description}` : '';
        const accessed = r.lastAccessedAt ? ` | last accessed ${r.lastAccessedAt}` : '';
        return `- ${r.serviceName}${desc}${accessed}`;
      });
      return `${records.length} credential(s) stored:\n${lines.join('\n')}\n\nUse credential_get(service_name) to retrieve a value when needed.`;
    }

    case 'credential_get': {
      const serviceName = args.service_name as string;
      if (!serviceName || typeof serviceName !== 'string') {
        return 'Error: service_name is required.';
      }
      let record;
      try {
        record = getCredentialByService(serviceName, agentId);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (!record) {
        return `No credential found for service "${serviceName}". Call credential_list to see what is stored, or ask the user to provide one and save it with credential_add.`;
      }
      const fields = Object.entries(record.credentials)
        .map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n');
      // NEXT-WAVE item 5: remember these secret values so the engine can scrub
      // them out of any persisted/broadcast tool_use command that inlines them
      // (rule 6: secrets never in message content). In-process only.
      noteHandedCredentialValues(
        agentId,
        Object.values(record.credentials).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))),
      );
      // Lead with the engine sentinel so this secret-bearing result is stubbed
      // deterministically if it ever ages into a compaction summary (Rule 6:
      // secrets never enter the memory DAG). The sentinel is invisible guidance
      // to the model; the fields below are what it uses this turn.
      return (
        `${CREDENTIAL_FRESH_SENTINEL}\n` +
        `Credential "${serviceName}":\n${fields}\n\n` +
        `Use these values to authenticate your API call. Do not echo them back in chat or store them elsewhere - they live in the encrypted credentials store and that is the only authoritative copy.`
      );
    }

    case 'credential_add': {
      const serviceName = args.service_name as string;
      const credentials = args.credentials as Record<string, unknown> | undefined;
      const description = (args.description as string | undefined) ?? null;
      if (!serviceName || typeof serviceName !== 'string') return 'Error: service_name is required.';
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
        return 'Error: credentials must be an object (e.g. {"api_key": "..."} or {"api_key": "...", "secret": "..."}). Pass a string value as {"value": "..."} if the service needs just one opaque token.';
      }
      const result = addCredential(serviceName, credentials, description, agentId);
      if (!result.ok) return `Error: ${result.error}`;
      return `Credential "${result.record.serviceName}" stored (id: ${result.record.id.slice(0, 8)}). Retrieve with credential_get(service_name="${result.record.serviceName}") when you need it for an API call.`;
    }

    case 'credential_update': {
      const serviceName = args.service_name as string;
      const credentials = args.credentials as Record<string, unknown> | undefined;
      const description = (args.description as string | undefined);
      if (!serviceName || typeof serviceName !== 'string') return 'Error: service_name is required.';
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
        return 'Error: credentials must be an object.';
      }
      const result = updateCredential(serviceName, credentials, description, agentId);
      if (!result.ok) return `Error: ${result.error}`;
      return `Credential "${result.record.serviceName}" updated.`;
    }

    case 'credential_delete': {
      const serviceName = args.service_name as string;
      if (!serviceName || typeof serviceName !== 'string') return 'Error: service_name is required.';
      const result = deleteCredentialByService(serviceName, agentId);
      if (!result.ok) return `Error: ${result.error}`;
      return `Credential "${serviceName}" deleted.`;
    }

    default:
      return `Unknown credential tool: ${name}`;
  }
}
