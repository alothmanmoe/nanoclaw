import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'agent-fleet-ownership',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE agent_groups ADD COLUMN parent_agent_group_id TEXT').run();
    db.prepare("ALTER TABLE agent_groups ADD COLUMN lifetime TEXT NOT NULL DEFAULT 'persistent'").run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_agent_groups_parent ON agent_groups(parent_agent_group_id)').run();
  },
};
