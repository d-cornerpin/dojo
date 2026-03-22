// ════════════════════════════════════════
// Agent Groups (Phase 6)
// Group CRUD, membership, context injection
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId, getPMAgentId, getTrainerAgentId } from '../config/platform.js';

const logger = createLogger('groups');

export const SYSTEM_GROUP_ID = 'system-group';
export const SYSTEM_GROUP_NAME = 'Masters';

const GROUP_COLORS = [
  '#7c3aed', '#06b6d4', '#f59e0b', '#10b981',
  '#ec4899', '#6366f1', '#ef4444', '#8b5cf6',
];

// ── Types ──

export interface AgentGroup {
  id: string;
  name: string;
  description: string | null;
  createdBy: string;
  color: string;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentGroupDetail extends AgentGroup {
  members: Array<{ id: string; name: string; status: string; classification: string }>;
}

// ── CRUD ──

export function createGroup(name: string, description: string | null, createdBy: string, color?: string): AgentGroup {
  const db = getDb();

  // Check if a group with this name already exists — return it instead of creating a duplicate
  const existing = db.prepare('SELECT * FROM agent_groups WHERE name = ?').get(name) as Record<string, unknown> | undefined;
  if (existing) {
    return {
      id: existing.id as string,
      name: existing.name as string,
      description: existing.description as string | null,
      createdBy: existing.created_by as string,
      color: existing.color as string,
      memberCount: 0,
      createdAt: existing.created_at as string,
      updatedAt: existing.updated_at as string,
    };
  }

  const id = uuidv4();

  // Auto-assign color if not provided
  if (!color) {
    const existingCount = (db.prepare('SELECT COUNT(*) as count FROM agent_groups').get() as { count: number }).count;
    color = GROUP_COLORS[existingCount % GROUP_COLORS.length];
  }

  db.prepare(`
    INSERT INTO agent_groups (id, name, description, created_by, color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(id, name, description, createdBy, color);

  logger.info('Group created', { id, name, createdBy });

  broadcast({ type: 'group:created', data: { id, name } } as never);

  return { id, name, description, createdBy, color, memberCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

export function getGroups(): AgentGroup[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM agents a WHERE a.group_id = g.id AND a.status != 'terminated') as member_count
    FROM agent_groups g
    ORDER BY g.name ASC
  `).all() as Array<Record<string, unknown>>;

  return rows.map(r => ({
    id: r.id as string,
    name: r.name as string,
    description: r.description as string | null,
    createdBy: r.created_by as string,
    color: r.color as string,
    memberCount: (r.member_count as number) ?? 0,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

export function getGroupDetail(id: string): AgentGroupDetail | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  const members = db.prepare(`
    SELECT id, name, status, classification FROM agents
    WHERE group_id = ? AND status != 'terminated'
    ORDER BY name ASC
  `).all(id) as Array<{ id: string; name: string; status: string; classification: string }>;

  const memberCount = (db.prepare('SELECT COUNT(*) as count FROM agents WHERE group_id = ? AND status != \'terminated\'').get(id) as { count: number }).count;

  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | null,
    createdBy: row.created_by as string,
    color: row.color as string,
    memberCount,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    members,
  };
}

export function updateGroup(id: string, updates: { name?: string; description?: string; color?: string }): boolean {
  const db = getDb();
  const parts: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  if (updates.name !== undefined) { parts.push('name = ?'); params.push(updates.name); }
  if (updates.description !== undefined) { parts.push('description = ?'); params.push(updates.description); }
  if (updates.color !== undefined) { parts.push('color = ?'); params.push(updates.color); }

  params.push(id);
  const result = db.prepare(`UPDATE agent_groups SET ${parts.join(', ')} WHERE id = ?`).run(...params);
  return result.changes > 0;
}

export function deleteGroup(id: string): boolean {
  if (id === SYSTEM_GROUP_ID) return false; // System group cannot be deleted

  const db = getDb();
  // Move agents to ungrouped
  db.prepare("UPDATE agents SET group_id = NULL, updated_at = datetime('now') WHERE group_id = ?").run(id);
  // Remove group task assignments
  db.prepare("UPDATE tasks SET assigned_to_group = NULL WHERE assigned_to_group = ?").run(id);
  const result = db.prepare('DELETE FROM agent_groups WHERE id = ?').run(id);

  if (result.changes > 0) {
    logger.info('Group deleted', { id });
    broadcast({ type: 'group:deleted', data: { id } } as never);
  }

  return result.changes > 0;
}

// ── Membership ──

export function assignAgentToGroup(agentId: string, groupId: string | null): { ok: boolean; error?: string } {
  const primaryId = getPrimaryAgentId();
  const pmId = getPMAgentId();

  // Permanent agents (primary + PM) are locked to the System Group
  if (agentId === primaryId || agentId === pmId) {
    return { ok: false, error: 'Permanent agents cannot be moved from the System group' };
  }

  // Non-permanent agents cannot be assigned to the System Group
  if (groupId === SYSTEM_GROUP_ID) {
    return { ok: false, error: 'Only permanent agents can be in the System group' };
  }

  const db = getDb();
  db.prepare("UPDATE agents SET group_id = ?, updated_at = datetime('now') WHERE id = ?").run(groupId, agentId);
  logger.info('Agent group assignment changed', { agentId, groupId });
  return { ok: true };
}

// ── Group context injection for agent prompts ──

export function assembleGroupContext(agentId: string): string {
  const db = getDb();
  const agent = db.prepare('SELECT group_id FROM agents WHERE id = ?').get(agentId) as { group_id: string | null } | undefined;
  if (!agent?.group_id) return '';

  const group = db.prepare('SELECT * FROM agent_groups WHERE id = ?').get(agent.group_id) as Record<string, unknown> | undefined;
  if (!group) return '';

  const members = db.prepare(`
    SELECT id, name, status FROM agents
    WHERE group_id = ? AND id != ? AND status != 'terminated'
  `).all(agent.group_id, agentId) as Array<{ id: string; name: string; status: string }>;

  return `
=== Group: ${group.name} ===
${group.description ?? ''}

Group Members:
${members.map(m => `- ${m.name} (${m.status})`).join('\n')}

You can communicate with other members of your group using the send_to_agent tool.
=== End Group Context ===
`;
}

// ── Check if agents can message each other (intra-group) ──

export function canMessageInGroup(senderId: string, recipientId: string): boolean {
  const db = getDb();
  const sender = db.prepare('SELECT group_id FROM agents WHERE id = ?').get(senderId) as { group_id: string | null } | undefined;
  const recipient = db.prepare('SELECT group_id FROM agents WHERE id = ?').get(recipientId) as { group_id: string | null } | undefined;

  if (!sender?.group_id || !recipient?.group_id) return false;
  return sender.group_id === recipient.group_id;
}

// ── Ensure System Group exists and permanent agents are in it ──

export function ensureSystemGroup(): void {
  const db = getDb();

  // Create system group if it doesn't exist
  const existing = db.prepare('SELECT id FROM agent_groups WHERE id = ?').get(SYSTEM_GROUP_ID);
  if (!existing) {
    db.prepare(`
      INSERT INTO agent_groups (id, name, description, created_by, color, created_at, updated_at)
      VALUES (?, ?, 'The sensei agents. Permanent members of the dojo who cannot be dismissed.', 'system', '#F5A623', datetime('now'), datetime('now'))
    `).run(SYSTEM_GROUP_ID, SYSTEM_GROUP_NAME);
    logger.info('System group created');
  }

  // Assign all sensei agents to the system group
  const primaryId = getPrimaryAgentId();
  const pmId = getPMAgentId();
  const trainerId = getTrainerAgentId();

  for (const agentId of [primaryId, pmId, trainerId]) {
    const agent = db.prepare('SELECT id, group_id FROM agents WHERE id = ?').get(agentId) as { id: string; group_id: string | null } | undefined;
    if (agent && agent.group_id !== SYSTEM_GROUP_ID) {
      db.prepare("UPDATE agents SET group_id = ?, updated_at = datetime('now') WHERE id = ?").run(SYSTEM_GROUP_ID, agentId);
      logger.info('Assigned permanent agent to system group', { agentId });
    }
  }
}
