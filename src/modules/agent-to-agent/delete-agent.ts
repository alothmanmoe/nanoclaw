/**
 * `delete_agent` delivery-action handler.
 *
 * Authorizes and executes subtree teardown on behalf of the calling agent.
 * Only agents that own the target (i.e. the target is the caller itself or a
 * transitive descendant) may delete it. Top-level (root) agents are never
 * reaped via this path — they exist until the operator removes them.
 *
 * SECURITY: Authorization is enforced here, host-side. The container is
 * untrusted and cannot gate itself.
 */
import { getAgentGroup } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { getDestinationByName } from './db/agent-destinations.js';
import { notifyAgent } from './notify-agent.js';
import { isRoot, isSelfOrDescendant } from './ownership.js';
import { teardownSubtree } from './teardown.js';

/** Resolve a `target` (caller's destination name, else literal group id) to a group id. */
function resolveTarget(callerGroupId: string, target: string): string | null {
  const dest = getDestinationByName(callerGroupId, target);
  if (dest && dest.target_type === 'agent') return dest.target_id;
  return getAgentGroup(target) ? target : null;
}

export async function handleDeleteAgent(content: Record<string, unknown>, session: Session): Promise<void> {
  const target = typeof content.target === 'string' ? content.target : '';
  if (!target) {
    notifyAgent(session, 'delete_agent failed: target is required.');
    return;
  }

  const db = getDb();
  const targetId = resolveTarget(session.agent_group_id, target);
  if (!targetId) {
    notifyAgent(session, `delete_agent failed: no such agent "${target}".`);
    return;
  }

  if (isRoot(db, targetId)) {
    notifyAgent(session, `delete_agent denied: "${target}" is a top-level agent and cannot be reaped.`);
    return;
  }

  if (!isSelfOrDescendant(db, session.agent_group_id, targetId)) {
    notifyAgent(session, `delete_agent denied: "${target}" is not in your subtree.`);
    log.warn('delete_agent rejected (out of subtree)', { caller: session.agent_group_id, targetId });
    return;
  }

  const { reaped } = await teardownSubtree(db, targetId);
  notifyAgent(session, `Reaped "${target}" and ${Math.max(0, reaped.length - 1)} descendant(s).`);
}
