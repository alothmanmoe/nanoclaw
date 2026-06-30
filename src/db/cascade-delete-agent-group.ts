import type Database from 'better-sqlite3';
import { hasTable } from './connection.js';

/**
 * FK-ordered cascade delete of one agent group and its dependent rows, in a
 * single better-sqlite3 transaction (rolls back atomically on any throw).
 * Shared by `ncl groups delete` and the agent-to-agent teardown path.
 * Out of scope (callers handle): killing containers, OneCLI vault agent
 * removal, on-disk groups/ + data/ cleanup.
 */
export function cascadeDeleteAgentGroup(db: Database.Database, groupId: string): Record<string, number> {
  const exists = db.prepare('SELECT 1 FROM agent_groups WHERE id = ? LIMIT 1').get(groupId);
  if (!exists) throw new Error(`group not found: ${groupId}`);

  const hasAgentDestinations = hasTable(db, 'agent_destinations');
  const hasPendingApprovals = hasTable(db, 'pending_approvals');

  const cascade = db.transaction((id: string) => {
    const counts: Record<string, number> = {
      sessions: 0,
      pending_questions: 0,
      pending_approvals: 0,
      agent_destinations_owned: 0,
      agent_destinations_pointing: 0,
      pending_sender_approvals: 0,
      pending_channel_approvals: 0,
      messaging_group_agents: 0,
      agent_group_members: 0,
      user_roles: 0,
      container_configs: 0,
    };
    if (hasAgentDestinations) {
      counts.agent_destinations_owned = db
        .prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?')
        .run(id).changes;
      counts.agent_destinations_pointing = db
        .prepare('DELETE FROM agent_destinations WHERE target_type = ? AND target_id = ?')
        .run('agent', id).changes;
    }
    counts.pending_questions = db
      .prepare('DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)')
      .run(id).changes;
    if (hasPendingApprovals) {
      counts.pending_approvals = db
        .prepare(
          'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
        )
        .run(id, id).changes;
    }
    counts.sessions = db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(id).changes;
    counts.pending_sender_approvals = db
      .prepare('DELETE FROM pending_sender_approvals WHERE agent_group_id = ?')
      .run(id).changes;
    counts.pending_channel_approvals = db
      .prepare('DELETE FROM pending_channel_approvals WHERE agent_group_id = ?')
      .run(id).changes;
    counts.messaging_group_agents = db
      .prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?')
      .run(id).changes;
    counts.agent_group_members = db.prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?').run(id).changes;
    counts.user_roles = db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(id).changes;
    counts.container_configs = db.prepare('DELETE FROM container_configs WHERE agent_group_id = ?').run(id).changes;
    db.prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
    return counts;
  });
  return cascade(groupId);
}
