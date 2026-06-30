import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initTestDb, closeDb, runMigrations, createAgentGroup, getAgentGroup, getDb } from './index.js';
import { cascadeDeleteAgentGroup } from './cascade-delete-agent-group.js';

beforeEach(() => {
  runMigrations(initTestDb());
  createAgentGroup({ id: 'ag-x', name: 'X', folder: 'x', agent_provider: null, created_at: new Date().toISOString() });
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, container_status, last_active, created_at)
              VALUES ('s1', 'ag-x', NULL, NULL, 'active', 'stopped', ?, ?)`,
    )
    .run(new Date().toISOString(), new Date().toISOString());
});
afterEach(() => {
  closeDb();
});

describe('cascadeDeleteAgentGroup', () => {
  it('deletes the group and its sessions, returning counts', () => {
    const removed = cascadeDeleteAgentGroup(getDb(), 'ag-x');
    expect(getAgentGroup('ag-x')).toBeUndefined();
    expect(removed.sessions).toBe(1);
  });

  it('throws for an unknown group id', () => {
    expect(() => cascadeDeleteAgentGroup(getDb(), 'nope')).toThrow('group not found: nope');
  });
});
