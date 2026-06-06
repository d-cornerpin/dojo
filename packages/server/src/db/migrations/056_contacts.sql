-- v2.9.16: DOJO-native contacts store.
--
-- A place for the DOJO to keep its own records about people the owner
-- and their agents interact with - separate from the Microsoft / Google
-- contacts directories (which are channel-specific and don't carry
-- agent-authored observations) and separate from iMessage safe-senders
-- (which is the engine's allowlist, not a knowledge store).
--
-- Agents write to it via contact_remember; the owner can read and edit
-- via the dashboard Vault → Contacts tab. The notes field is freeform
-- agent-authored prose; structured fields exist for the bits an agent
-- might want to look up cleanly (channel addresses, company, role).
--
-- JSON fields stored as TEXT, validated at the API boundary.

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  preferred_name TEXT,
  emails TEXT NOT NULL DEFAULT '[]',
  phones TEXT NOT NULL DEFAULT '[]',
  imessage_handles TEXT NOT NULL DEFAULT '[]',
  company TEXT,
  role TEXT,
  notes TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  created_by_agent_id TEXT,
  last_updated_by_agent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_display_name ON contacts(display_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_contacts_updated_at ON contacts(updated_at DESC);
