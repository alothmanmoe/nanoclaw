// src/modules/agent-to-agent/teardown.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initTestDb, closeDb, createAgentGroup, getAgentGroup, getDb, runMigrations } from '../../db/index.js';

const killed: string[] = [];
vi.mock('../../container-runner.js', () => ({
  isContainerRunning: () => false,
  killContainer: (sessionId: string, _reason: string, onExit?: () => void) => {
    killed.push(sessionId);
    onExit?.();
  },
}));
const vaultDeletes: string[] = [];
vi.mock('./onecli-vault.js', () => ({
  deleteVaultAgent: (identifier: string) => {
    vaultDeletes.push(identifier);
  },
  resolveVaultUuid: () => null,
}));

import { teardownSubtree } from './teardown.js';

function mk(id: string, parent: string | null) {
  createAgentGroup(
    { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() },
    { parentAgentGroupId: parent },
  );
}

beforeEach(() => {
  killed.length = 0;
  vaultDeletes.length = 0;
  runMigrations(initTestDb());
  mk('root', null);
  mk('child', 'root');
  mk('grandchild', 'child');
  mk('bystander', null);
});
afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
});

describe('teardownSubtree', () => {
  it('deletes target and all descendants, leaves bystander', async () => {
    const res = await teardownSubtree(getDb(), 'child');
    expect(res.reaped.sort()).toEqual(['child', 'grandchild']);
    expect(getAgentGroup('child')).toBeUndefined();
    expect(getAgentGroup('grandchild')).toBeUndefined();
    expect(getAgentGroup('bystander')).toBeDefined();
    expect(getAgentGroup('root')).toBeDefined();
  });

  it('is a no-op for an already-removed id (lock + existence guard)', async () => {
    await teardownSubtree(getDb(), 'grandchild');
    const res = await teardownSubtree(getDb(), 'grandchild');
    expect(res.reaped).toEqual([]);
  });
});
