// A draft is an account write, not a channel send. `gmail_draft` and `outlook_draft` put a message in the
// mailbox's own Drafts folder and send nothing. Classed as a send, they would need the email channel, so an
// agent with a full grant on the owner's account and "can talk to people" off could not draft. Classed as
// nothing, a read grant could write to the mailbox. So the account door asks the full level for a write and
// asks the channel only for a send; the draft names stay out of `SEND_TO_PEOPLE`, with the reason recorded in
// `SEND_TO_PEOPLE_NA`. The acceptance case (`FXID.n8`: owner's Google account at full, channels off) may draft,
// is offered the draft tools, and is refused and not offered the send tools.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

vi.mock('../../../config/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config/platform.js')>('../../../config/platform.js');
  return {
    ...actual,
    isPrimaryAgent: (id: string) => id === 'primary',
    isPMAgent: () => false,
    isHealerAgent: () => false,
    isTrainerAgent: () => false,
    getPrimaryAgentId: () => 'primary',
  };
});

import { MOST_RESTRICTIVE_GRANTS, cloneGrants, channelOfSendTool, type AccessGrants } from '@dojo/shared';
import { forgetAccessGrants, toolCategoryGranted, mayUseChannel } from '../read.js';
import { accountRefusal, accountKindForTool, type WorkspaceProvider } from '../workspace.js';
import { channelForTool } from '../channels.js';
import { SEND_TO_PEOPLE } from '../../sensei-policy.js';
import { SEND_TO_PEOPLE_NA } from '../../../tools/__tests__/send-to-people-na.js';
import { registryToolDefinitions } from '../../tools/registry.js';
import { TOOL_CATEGORIES } from '../../../tools/categories.js';
import { FXID } from '../../../../../../deploy/checks/fixture-vocabulary.mjs';

/** Every tool the platform declares, read through the registry rather than the
 *  two definition arrays: importing `google/tools-write.ts` from here closes an
 *  import cycle through the executor. The registry is the supported reader and
 *  is asserted byte-identical to the declared order by `registry-order.test.ts`. */
const defsNamed = (names: readonly string[]) =>
  registryToolDefinitions().filter((d) => names.includes(d.name));

/** The account door on the tool's own definition, for the kind its name selects. */
const mayUse = (agentId: string, tool: string, provider: WorkspaceProvider): boolean =>
  accountRefusal(agentId, defsNamed([tool])[0], provider, { id: null, kind: accountKindForTool(tool), enabledServices: null }) === null;

const DRAFT_TOOLS = ['gmail_draft', 'outlook_draft'] as const;
const ALL_DRAFT_NAMES = ['gmail_draft', 'user_gmail_draft', 'outlook_draft', 'user_outlook_draft'];

/** The owner's FX.n8 shape: his own Google account, wide open, no human channels. */
function mrMeSeeksGrants(): AccessGrants {
  const g = cloneGrants(MOST_RESTRICTIVE_GRANTS);
  g.tools.categories = '*';
  g.integrations.google.user = 'full';
  g.integrations.microsoft.user = 'full';
  g.channels.master = false;
  return g;
}

function seedAgent(id: string, grants: AccessGrants): void {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT, classification TEXT,
      permissions TEXT, tools_policy TEXT, updated_at TEXT
    );
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare('INSERT INTO agents (id, name, classification, permissions, tools_policy) VALUES (?, ?, ?, ?, ?)')
    .run(id, id, 'apprentice', JSON.stringify({ grants }), '{}');
  mockDb.current = db;
  forgetAccessGrants();
}

beforeEach(() => { mockDb.current = null; forgetAccessGrants(); });

// ════════════════════════════════════════════════════════════════════════════
// 1 · THE DOOR — the acceptance case, driven through the real wall
// ════════════════════════════════════════════════════════════════════════════

describe('the draft door asks the account, and never the channel', () => {
  it('⚠ THE ACCEPTANCE CASE — account write + human channels OFF: drafting is allowed', () => {
    // The existence check is not decoration: the door would answer `true` for
    // any INVENTED name under a full grant, so without it this clause passes on a tool
    // that does not exist.
    const declared = new Set(registryToolDefinitions().map((d) => d.name));
    expect(declared.has('user_gmail_draft')).toBe(true);
    expect(declared.has('user_outlook_draft')).toBe(true);

    seedAgent(FXID.n8, mrMeSeeksGrants());

    expect(mayUse(FXID.n8, 'user_gmail_draft', 'google')).toBe(true);
    expect(mayUse(FXID.n8, 'user_outlook_draft', 'microsoft')).toBe(true);
  });

  it('⚠ AND IT SURVIVES THE ADVERTISED SURFACE — the two filters that could strip it', () => {
    // `surface.ts` ends with exactly two grant-driven filters: the category grant
    // (`toolCategoryGranted`, :635) and the channel grant (`channelForTool`, :660).
    // Both are called here on the real readers, on the same agent.
    seedAgent(FXID.n8, mrMeSeeksGrants());

    for (const name of ['user_gmail_draft', 'user_outlook_draft']) {
      expect(toolCategoryGranted(FXID.n8, name)).toBe(true);
      expect(channelForTool(name)).toBeNull();
    }
    // and the control: the send twin survives the category filter and is cut by the channel one
    expect(toolCategoryGranted(FXID.n8, 'user_gmail_send')).toBe(true);
    expect(mayUseChannel(FXID.n8, channelForTool('user_gmail_send')!)).toBe(false);
  });

  it('⚠ THE CONTROL THAT MAKES IT MEAN SOMETHING — the SAME agent is refused on send', () => {
    seedAgent(FXID.n8, mrMeSeeksGrants());

    expect(mayUse(FXID.n8, 'user_gmail_send', 'google')).toBe(false);
    expect(mayUse(FXID.n8, 'gmail_send', 'google')).toBe(false);
    expect(mayUse(FXID.n8, 'user_outlook_send', 'microsoft')).toBe(false);
  });

  it('a READ grant does not buy a draft — the write tier is still the first conjunct', () => {
    const g = mrMeSeeksGrants();
    g.integrations.google.user = 'read';
    seedAgent('reader', g);

    expect(mayUse('reader', 'user_gmail_search', 'google')).toBe(true);
    expect(mayUse('reader', 'user_gmail_draft', 'google')).toBe(false);
  });

  it('the AGENT slot and the USER slot are still separate grants for a draft', () => {
    const g = mrMeSeeksGrants();          // user: full, agent: none
    seedAgent('split', g);

    expect(mayUse('split', 'user_gmail_draft', 'google')).toBe(true);
    expect(mayUse('split', 'gmail_draft', 'google')).toBe(false);
  });

  it('CONTROL — turning the email channel ON changes nothing about drafting, and unlocks send', () => {
    const g = mrMeSeeksGrants();
    g.channels.master = true;
    g.channels.email = 'owner';
    seedAgent('talks', g);

    expect(mayUse('talks', 'user_gmail_draft', 'google')).toBe(true);
    expect(mayUse('talks', 'user_gmail_send', 'google')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2 · THE CLASSIFICATION — what makes the door behave that way
// ════════════════════════════════════════════════════════════════════════════

describe('a draft is on no human channel, by every reader that answers that question', () => {
  it('⚠ `channelForTool` answers null, which is what removes the second conjunct', () => {
    for (const name of ALL_DRAFT_NAMES) expect(channelForTool(name)).toBeNull();
    // the control: the send twins DO answer, from the same reader
    expect(channelForTool('gmail_send')).toBe('email');
    expect(channelForTool('user_outlook_send')).toBe('email');
  });

  it('⚠ they are NOT on the build-checked send surface, and the ledger says why', () => {
    for (const name of ALL_DRAFT_NAMES) expect(SEND_TO_PEOPLE).not.toContain(name);
    for (const name of DRAFT_TOOLS) {
      expect(SEND_TO_PEOPLE_NA[name]).toBeTruthy();
      expect(SEND_TO_PEOPLE_NA[name]).toMatch(/draft/i);
    }
  });

  it('⚠ `channelOfSendTool` answers null, so no outbound scope and no delivery row', () => {
    // A delivery row is the record of the dojo having reached a person. A draft
    // reaches nobody, so the outbound machinery must never open for it.
    for (const name of ALL_DRAFT_NAMES) expect(channelOfSendTool(name)).toBeNull();
    expect(channelOfSendTool('gmail_send')).toBe('email');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3 · THE SHAPE — category, twins, and what the description promises
// ════════════════════════════════════════════════════════════════════════════

describe('the draft tools sit with their own family and say what they do', () => {
  it('⚠ they live in the Gmail and Outlook categories, with their send siblings', () => {
    const cat = (label: string): string[] => TOOL_CATEGORIES.find((c) => c.label === label)?.tools ?? [];
    expect(cat('Gmail')).toContain('gmail_draft');
    expect(cat('Outlook')).toContain('outlook_draft');
  });

  it('⚠ each has a `user_` twin, from the same full-parity loop every other write tool uses', () => {
    const names = new Set(registryToolDefinitions().map((d) => d.name));
    for (const name of ALL_DRAFT_NAMES) expect(names.has(name)).toBe(true);
  });

  it('⚠ the description states plainly: it creates a draft, it sends nothing, you send it', () => {
    const defs = defsNamed(DRAFT_TOOLS);
    expect(defs).toHaveLength(2);
    for (const d of defs) {
      expect(d.description).toMatch(/\bdraft\b/i);
      expect(d.description).toMatch(/sends? nothing|does not send|nothing is sent/i);
      expect(d.description).toMatch(/\byou\b[^.]*\bsend\b|send it yourself/i);
    }
  });

  it('⚠ it takes a reply target, so a draft can be threaded onto an existing conversation', () => {
    const defs = defsNamed(DRAFT_TOOLS);
    expect(defs).toHaveLength(2);
    for (const d of defs) {
      const props = d.input_schema.properties as Record<string, unknown>;
      expect(props.reply_to_message_id).toBeTruthy();
      expect(props.body).toBeTruthy();
    }
  });
});
