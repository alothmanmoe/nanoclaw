import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initTestDb, closeDb, runMigrations, createAgentGroup, countManagedAgents } from './index.js';

function mk(id: string, parent: string | null, lifetime: 'task' | 'persistent') {
  createAgentGroup(
    { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() },
    { parentAgentGroupId: parent, lifetime },
  );
}
beforeEach(() => {
  runMigrations(initTestDb());
});
afterEach(() => {
  closeDb();
});

describe('countManagedAgents', () => {
  it('counts every spawned agent regardless of lifetime, excludes roots', () => {
    mk('root', null, 'persistent'); // root — not counted
    mk('task-child', 'root', 'task'); // counted
    mk('persistent-child', 'root', 'persistent'); // counted (the bypass case)
    mk('grandchild', 'task-child', 'task'); // counted
    expect(countManagedAgents()).toBe(3);
  });
});
