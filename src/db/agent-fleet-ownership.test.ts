import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initTestDb, runMigrations, closeDb, createAgentGroup, getAgentGroup } from './index.js';

function now() {
  return new Date().toISOString();
}

beforeEach(() => {
  runMigrations(initTestDb());
});
afterEach(() => {
  closeDb();
});

describe('agent_groups ownership columns', () => {
  it('defaults parent to null and lifetime to persistent', () => {
    createAgentGroup({ id: 'ag-root', name: 'Root', folder: 'root', agent_provider: null, created_at: now() });
    const g = getAgentGroup('ag-root')!;
    expect(g.parent_agent_group_id).toBeNull();
    expect(g.lifetime).toBe('persistent');
  });

  it('records parent and lifetime when passed via opts', () => {
    createAgentGroup(
      { id: 'ag-child', name: 'Child', folder: 'child', agent_provider: null, created_at: now() },
      { parentAgentGroupId: 'ag-root', lifetime: 'task' },
    );
    const g = getAgentGroup('ag-child')!;
    expect(g.parent_agent_group_id).toBe('ag-root');
    expect(g.lifetime).toBe('task');
  });
});
