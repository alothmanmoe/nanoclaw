import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initTestDb, closeDb, createAgentGroup, getDb, runMigrations } from '../../db/index.js';

const teardown = vi.fn(async (..._args: any[]) => ({ reaped: ['ag-child'] }));
vi.mock('./teardown.js', () => ({ teardownSubtree: (...a: any[]) => teardown(...a) }));

const notes: string[] = [];
vi.mock('./notify-agent.js', () => ({
  notifyAgent: (_session: unknown, text: string) => notes.push(text),
}));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: async () => {},
  isContainerRunning: () => false,
  killContainer: () => {},
}));

import { handleDeleteAgent } from './delete-agent.js';

function mk(id: string, parent: string | null) {
  createAgentGroup(
    { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() },
    { parentAgentGroupId: parent },
  );
}

const session = (agentGroupId: string) => ({ id: 's', agent_group_id: agentGroupId }) as any;

beforeEach(() => {
  teardown.mockClear();
  notes.length = 0;
  runMigrations(initTestDb());
  mk('root', null);
  mk('child', 'root');
  mk('sibling', 'root');
  getDb()
    .prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES ('root', 'child', 'agent', 'child', ?)`,
    )
    .run(new Date().toISOString());
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
});

describe('handleDeleteAgent authorization', () => {
  it('tears down a descendant resolved by destination name', async () => {
    mk('ag-child', 'root');
    getDb().prepare(`UPDATE agent_destinations SET target_id='ag-child' WHERE local_name='child'`).run();
    await handleDeleteAgent({ action: 'delete_agent', target: 'child' }, session('root'));
    expect(teardown).toHaveBeenCalledWith(expect.anything(), 'ag-child');
  });

  it('refuses a sibling (not in subtree)', async () => {
    await handleDeleteAgent({ action: 'delete_agent', target: 'sibling' }, session('child'));
    expect(teardown).not.toHaveBeenCalled();
    expect(notes.join(' ')).toMatch(/not in your subtree|denied/i);
  });

  it('refuses a tree root target', async () => {
    await handleDeleteAgent({ action: 'delete_agent', target: 'root' }, session('root'));
    expect(teardown).not.toHaveBeenCalled();
  });
});
