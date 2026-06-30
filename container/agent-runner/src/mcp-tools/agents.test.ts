import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initTestSessionDb, closeSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { deleteAgent, finishTask } from './agents.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('delete_agent tool', () => {
  it('writes a delete_agent system row with the target', async () => {
    await deleteAgent.handler({ target: 'researcher' });
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content)).toMatchObject({ action: 'delete_agent', target: 'researcher' });
  });
});

describe('finish_task tool', () => {
  it('writes a finish_task system row with summary', async () => {
    await finishTask.handler({ summary: 'all done' });
    const out = getUndeliveredMessages();
    expect(JSON.parse(out[out.length - 1].content)).toMatchObject({ action: 'finish_task', summary: 'all done' });
  });
});
