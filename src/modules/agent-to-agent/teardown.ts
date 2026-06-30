// src/modules/agent-to-agent/teardown.ts
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

import { GROUPS_DIR } from '../../config.js';
import { cascadeDeleteAgentGroup } from '../../db/cascade-delete-agent-group.js';
import { getAgentGroup, getSessionsByAgentGroup, updateSession } from '../../db/index.js';
import { isContainerRunning, killContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { sessionsBaseDir } from '../../session-manager.js';
import { deleteVaultAgent } from './onecli-vault.js';
import { descendantsOf } from './ownership.js';

/** Groups currently being torn down — prevents a parent delete_agent racing a
 *  child finish_task on overlapping subtrees. */
const inProgress = new Set<string>();

/** rm -rf a path only if it resolves inside `expectedParent` (traversal guard). */
function safeRemove(target: string, expectedParent: string): void {
  const resolved = path.resolve(target);
  const parent = path.resolve(expectedParent);
  if (!resolved.startsWith(parent + path.sep)) {
    log.error('teardown refused unsafe path removal', { resolved, parent });
    return;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function reapOne(db: Database.Database, groupId: string): Promise<boolean> {
  const group = getAgentGroup(groupId);
  if (!group) return false; // already gone

  // 1. Stop respawns: close sessions so host-sweep won't restart them.
  const sessions = getSessionsByAgentGroup(groupId);
  for (const s of sessions) updateSession(s.id, { status: 'closed' });

  // 2. Kill running containers, awaiting exit so we never delete a live mount.
  await Promise.all(
    sessions
      .filter((s) => isContainerRunning(s.id))
      .map((s) => new Promise<void>((resolve) => killContainer(s.id, 'reaped (subtree teardown)', resolve))),
  );

  // 3. Cascade-delete central-DB rows (also removes destinations pointing here).
  cascadeDeleteAgentGroup(db, groupId);

  // 4. Remove OneCLI vault agent (identifier === agent group id). Best-effort.
  deleteVaultAgent(groupId);

  // 5. Clean on-disk dirs.
  safeRemove(path.join(GROUPS_DIR, group.folder), GROUPS_DIR);
  safeRemove(path.join(sessionsBaseDir(), groupId), sessionsBaseDir());
  return true;
}

/**
 * Fully tear down `rootTargetId` and every transitive descendant, deepest-first.
 * Authorization is the CALLER's responsibility — never call without an
 * isSelfOrDescendant + non-root check first.
 */
export async function teardownSubtree(db: Database.Database, rootTargetId: string): Promise<{ reaped: string[] }> {
  // Deepest-first: descendants (in insertion/CTE order) then the target last.
  const ordered = [...descendantsOf(db, rootTargetId).reverse(), rootTargetId];
  const reaped: string[] = [];
  for (const id of ordered) {
    if (inProgress.has(id)) continue;
    inProgress.add(id);
    try {
      if (await reapOne(db, id)) reaped.push(id);
    } catch (err) {
      log.error('teardown of group failed', { id, err });
    } finally {
      inProgress.delete(id);
    }
  }
  return { reaped };
}
