// src/modules/agent-to-agent/ownership.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { descendantsOf, isSelfOrDescendant, isRoot } from './ownership.js';

function mk(id: string, parent: string | null) {
  createAgentGroup(
    { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() },
    { parentAgentGroupId: parent },
  );
}

beforeEach(() => {
  runMigrations(initTestDb());
  // root -> child -> grandchild ; root -> child2 ; orphan (unrelated root)
  mk('root', null);
  mk('child', 'root');
  mk('grandchild', 'child');
  mk('child2', 'root');
  mk('orphan', null);
});
afterEach(() => {
  closeDb();
});

describe('ownership helpers', () => {
  it('descendantsOf returns transitive descendants excluding root', () => {
    expect(descendantsOf(getDb(), 'root').sort()).toEqual(['child', 'child2', 'grandchild']);
    expect(descendantsOf(getDb(), 'child')).toEqual(['grandchild']);
    expect(descendantsOf(getDb(), 'grandchild')).toEqual([]);
  });

  it('isSelfOrDescendant: self and descendants true', () => {
    expect(isSelfOrDescendant(getDb(), 'root', 'root')).toBe(true);
    expect(isSelfOrDescendant(getDb(), 'root', 'grandchild')).toBe(true);
    expect(isSelfOrDescendant(getDb(), 'child', 'grandchild')).toBe(true);
  });

  it('isSelfOrDescendant: parent, sibling, unrelated false', () => {
    expect(isSelfOrDescendant(getDb(), 'child', 'root')).toBe(false); // parent
    expect(isSelfOrDescendant(getDb(), 'child', 'child2')).toBe(false); // sibling
    expect(isSelfOrDescendant(getDb(), 'child', 'orphan')).toBe(false); // unrelated
  });

  it('isRoot true for null-parent and absent groups', () => {
    expect(isRoot(getDb(), 'root')).toBe(true);
    expect(isRoot(getDb(), 'child')).toBe(false);
    expect(isRoot(getDb(), 'does-not-exist')).toBe(true);
  });
});
