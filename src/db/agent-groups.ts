import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';

export function createAgentGroup(
  group: AgentGroup,
  opts?: { parentAgentGroupId?: string | null; lifetime?: 'task' | 'persistent' },
): void {
  getDb()
    .prepare(
      `INSERT INTO agent_groups
         (id, name, folder, agent_provider, created_at, parent_agent_group_id, lifetime)
       VALUES (@id, @name, @folder, @agent_provider, @created_at, @parent_agent_group_id, @lifetime)`,
    )
    .run({
      id: group.id,
      name: group.name,
      folder: group.folder,
      agent_provider: group.agent_provider,
      created_at: group.created_at,
      parent_agent_group_id: opts?.parentAgentGroupId ?? group.parent_agent_group_id ?? null,
      lifetime: opts?.lifetime ?? group.lifetime ?? 'persistent',
    });
}

export function getAgentGroup(id: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as AgentGroup | undefined;
}

export function getAgentGroupByFolder(folder: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE folder = ?').get(folder) as AgentGroup | undefined;
}

export function getAllAgentGroups(): AgentGroup[] {
  return getDb().prepare('SELECT * FROM agent_groups ORDER BY name').all() as AgentGroup[];
}

export function updateAgentGroup(id: string, updates: Partial<Pick<AgentGroup, 'name' | 'agent_provider'>>): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteAgentGroup(id: string): void {
  getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
}

/** Count of live agent groups with lifetime='task' — the fleet-cap denominator. */
export function countLiveTaskAgents(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM agent_groups WHERE lifetime = 'task'").get() as { n: number };
  return row.n;
}
