// src/modules/agent-to-agent/ownership.ts
import type Database from 'better-sqlite3';

/**
 * All transitive descendants of `rootId` (children, grandchildren, …),
 * excluding `rootId` itself. Walks agent_groups.parent_agent_group_id via a
 * recursive CTE. Cycles are impossible (a child's parent is set once at
 * creation to an already-existing ancestor), but UNION dedupes defensively.
 */
export function descendantsOf(db: Database.Database, rootId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM agent_groups WHERE parent_agent_group_id = @root
         UNION
         SELECT ag.id FROM agent_groups ag JOIN sub ON ag.parent_agent_group_id = sub.id
       )
       SELECT id FROM sub`,
    )
    .all({ root: rootId }) as { id: string }[];
  return rows.map((r) => r.id);
}

/** True when target is the caller itself or any transitive descendant. */
export function isSelfOrDescendant(db: Database.Database, callerId: string, targetId: string): boolean {
  if (callerId === targetId) return true;
  return descendantsOf(db, callerId).includes(targetId);
}

/** True when the group is a tree root (no parent) or does not exist. */
export function isRoot(db: Database.Database, groupId: string): boolean {
  const row = db.prepare('SELECT parent_agent_group_id AS p FROM agent_groups WHERE id = ?').get(groupId) as
    | { p: string | null }
    | undefined;
  if (!row) return true;
  return row.p == null;
}
