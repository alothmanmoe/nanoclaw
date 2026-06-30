import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initTestDb, closeDb, createAgentGroup, getDb, runMigrations } from '../../db/index.js';

const teardown = vi.fn(async (..._args: any[]) => ({ reaped: ['ag-self'] }));
vi.mock('./teardown.js', () => ({ teardownSubtree: (...a: any[]) => teardown(...a) }));

const parentMsgs: string[] = [];
vi.mock('./notify-agent.js', () => ({
  notifyAgent: (_session: unknown, text: string) => parentMsgs.push(text),
}));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: async () => {},
  isContainerRunning: () => false,
  killContainer: () => {},
}));

import { handleFinishTask } from './finish-task.js';

function mk(id: string, parent: string | null) {
  createAgentGroup(
    { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() },
    { parentAgentGroupId: parent },
  );
}

const session = (agentGroupId: string) => ({ id: 's', agent_group_id: agentGroupId }) as any;

beforeEach(() => {
  teardown.mockClear();
  parentMsgs.length = 0;
  runMigrations(initTestDb());
  mk('root', null);
  mk('ag-self', 'root');
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, container_status, last_active, created_at)
       VALUES ('p1','root',NULL,NULL,'active','stopped',?,?)`,
    )
    .run(new Date().toISOString(), new Date().toISOString());
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
});

describe('handleFinishTask', () => {
  it('refuses for a tree root (no parent)', async () => {
    await handleFinishTask({ action: 'finish_task' }, session('root'));
    expect(teardown).not.toHaveBeenCalled();
  });

  it('reaps the caller subtree and relays summary to the parent', async () => {
    await handleFinishTask({ action: 'finish_task', summary: 'done: report ready' }, session('ag-self'));
    expect(teardown).toHaveBeenCalledWith(expect.anything(), 'ag-self');
    expect(parentMsgs.join(' ')).toMatch(/report ready/);
  });
});
