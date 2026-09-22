// ════════════════════════════════════════
// Agent Credentials Tools
// 5 tools agents call from inside techniques to manage API credentials
// for third-party services the user has them connect to.
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools/types.js';
import { CREDENTIAL_FRESH_SENTINEL } from '../memory/compaction.js';
// The value set and the declared-secret-field map live together in ONE module
// (T5b): "which fields are secret" and "which values are secret" are the same
// job, and a secret is only ever learned from a DECLARED field, never a shape.
import { noteHandedCredentialValues } from './secret-values.js';
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
    effects: [{ kind: 'secrets', from: 'derived:the encrypted credential store' }],
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'credential_get',
    description: 'Retrieve a credential by service name. Returns the credential payload (an object with whatever fields the agent stored - api_key, token, secret, etc.). Use this at API-call time inside a technique; do NOT echo the returned values back into chat or store them elsewhere. Every read is audit-logged with timestamp + which agent accessed it.',
    effects: [{ kind: 'secrets', from: 'derived:the encrypted credential store' }],
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
    description: '**This is the ONLY place credentials should be stored in the dojo. Never put API keys, tokens, passwords, or secrets in vault_remember — the engine will refuse those entries.** When the user hands you any value labeled secret/key/token/password/credential (whether for a technique you are building, a placeholder you are filling, or a service the user wants connected), store it here. Pass `credentials` as an OBJECT with whatever fields the service needs (e.g. {api_key: "..."} for a single-key API, or {api_key: "...", workspace_id: "...", secret: "..."} for a multi-field API). Description should be short but specific - what is the credential for, when did the user provide it, what service does it authenticate against. If a credential is already stored under that service_name this REFUSES and tells you when that one was created and by whom: the stored value cannot be recovered once replaced, so either pick an unused service_name, or pass overwrite=true if the user has genuinely handed you a replacement for that same credential. When in doubt, ask the user first.',
    effects: [{ kind: 'secrets', from: 'derived:the encrypted credential store' }],
    fields: {
      'credentials': { secret: true },
    },
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Short identifier (lowercase, no spaces; e.g. "openweather", "github_pat", "shopify_admin"). Used as the key for credential_get / credential_update / credential_delete later.' },
        credentials: { type: 'object', description: 'The credential payload as an object. Single-key APIs: {api_key: "..."}. Multi-key: include each field the API requires.' },
        description: { type: 'string', description: 'Short note about what the credential is for and where the user got it (e.g., "OpenWeatherMap free-tier API key, provided by user on 2026-05-25 for the weather-dashboard technique").' },
        overwrite: { type: 'boolean', description: 'Authorise DESTROYING the value already stored under this service_name. Omit it (or pass false) unless the user has explicitly handed you a replacement for that exact credential — the previous value is unrecoverable and the overwrite is recorded against you.' },
      },
      required: ['service_name', 'credentials'],
    },
  },
  {
    name: 'credential_update',
    description: 'Replace the value of an existing credential. Pass the same service_name and the new credentials object. Optionally pass a new description; omit to leave the existing description unchanged. Use when the user rotates a token or replaces an API key. REQUIRES overwrite=true: replacing a credential destroys the stored value permanently (there is no prior version and no undo), so the engine refuses until you say you mean it, and the refusal tells you when the existing value was created and by whom. Never pass overwrite=true to make an error go away — if you are storing a different service\'s key, use credential_add with a service_name that is not taken.',
    effects: [{ kind: 'secrets', from: 'derived:the encrypted credential store' }],
    fields: {
      'credentials': { secret: true },
    },
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Service name of the credential to update.' },
        credentials: { type: 'object', description: 'New credential payload (replaces the existing one entirely).' },
        description: { type: 'string', description: 'Optional new description.' },
        overwrite: { type: 'boolean', description: 'Required, and must be true: you are ending the value currently stored under this service_name and it cannot be recovered.' },
      },
      required: ['service_name', 'credentials'],
    },
  },
  {
    name: 'credential_delete',
    description: 'Permanently delete a credential by service name. Use only when the user explicitly asks to remove it (e.g., they revoked the token, or the technique is no longer needed). Deletion is irreversible - no recycle bin, no prior version. REQUIRES confirm=true: the engine refuses until you say you mean it, and the refusal tells you when the credential was created and by whom. If you only want to REPLACE a value, do not delete - use credential_update with overwrite=true, which keeps the row\'s record of who created it and when.',
    effects: [{ kind: 'secrets', from: 'derived:the encrypted credential store' }],
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Service name of the credential to delete.' },
        confirm: { type: 'boolean', description: 'Required, and must be true: you are permanently removing this credential and its value cannot be recovered.' },
      },
      required: ['service_name'],
    },
  },
];

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
      // `'out'` is the direction, and it is the ONLY place that passes it: this
      // is the store handing the agent a value it can fetch again whenever it
      // likes, which is what makes the value showable on the owner's own screen
      // when he asks for it (design ruling 13). Everything else feeding this set
      // is the owner handing a secret IN, and stays redacted everywhere.
      noteHandedCredentialValues(
        agentId,
        Object.values(record.credentials).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))),
        'out',
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
      // T83: the flag is passed through EXPLICITLY and is only ever true when the model said
      // so. The store owns the rule; this layer owns nothing but the hand-off.
      const result = addCredential(serviceName, credentials, description, agentId, { overwrite: args.overwrite === true });
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
      const result = updateCredential(serviceName, credentials, description, agentId, { overwrite: args.overwrite === true });
      if (!result.ok) return `Error: ${result.error}`;
      return `Credential "${result.record.serviceName}" updated.`;
    }

    case 'credential_delete': {
      const serviceName = args.service_name as string;
      if (!serviceName || typeof serviceName !== 'string') return 'Error: service_name is required.';
      const result = deleteCredentialByService(serviceName, agentId, { confirm: args.confirm === true });
      if (!result.ok) return `Error: ${result.error}`;
      return `Credential "${serviceName}" deleted.`;
    }

    default:
      return `Unknown credential tool: ${name}`;
  }
}
