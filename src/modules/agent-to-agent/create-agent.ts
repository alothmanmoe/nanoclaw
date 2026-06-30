/**
 * `create_agent` delivery-action handler.
 *
 * SECURITY: `create_agent` writes to the CENTRAL DB (agent_groups,
 * container_configs, agent_destinations) and scaffolds host filesystem state —
 * a privileged operation a confined container is otherwise architecturally
 * barred from. The container's MCP tool gate is inside the (untrusted)
 * container and is trivially bypassed by writing the outbound system row
 * directly, so authorization MUST be enforced host-side.
 *
 * Spawning no longer requires approval. Any agent that can reach this action
 * may create sub-agents directly, subject to the fleet cap
 * (MAX_MANAGED_AGENTS). Parent + lifetime are recorded on every create so
 * finish_task / delete_agent can clean up correctly.
 */
import path from 'path';

import { GROUPS_DIR, MAX_MANAGED_AGENTS } from '../../config.js';
import { countLiveTaskAgents, createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

/**
 * Delivery-action entry.
 *
 * Always creates directly — no approval gate. The fleet cap
 * (MAX_MANAGED_AGENTS) is enforced before any DB write. Parent + lifetime are
 * recorded so finish_task / delete_agent can clean up the fleet.
 */
export async function handleCreateAgent(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = typeof content.name === 'string' ? content.name : '';
  const instructions = typeof content.instructions === 'string' ? content.instructions : null;
  const lifetime: 'task' | 'persistent' = content.lifetime === 'persistent' ? 'persistent' : 'task';

  if (!name) {
    notifyAgent(session, 'create_agent failed: name is required.');
    return;
  }

  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    notifyAgent(session, 'create_agent failed: source agent group not found.');
    log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return;
  }

  if (countLiveTaskAgents() >= MAX_MANAGED_AGENTS) {
    notifyAgent(
      session,
      `create_agent rejected: fleet cap of ${MAX_MANAGED_AGENTS} managed agents reached. Reap finished agents (finish_task / delete_agent) before spawning more.`,
    );
    return;
  }

  await performCreateAgent(name, instructions, lifetime, session, sourceGroup, (text) => notifyAgent(session, text));
}

/**
 * Core creation: writes the new agent group + bidirectional destinations and
 * scaffolds its filesystem, then reports via `notify`. Records the parent
 * agent group id and lifetime so the fleet can be managed.
 */
async function performCreateAgent(
  name: string,
  instructions: string | null,
  lifetime: 'task' | 'persistent',
  session: Session,
  sourceGroup: AgentGroup,
  notify: (text: string) => void,
): Promise<void> {
  const localName = normalizeName(name);

  // Collision in the creator's destination namespace
  if (getDestinationByName(sourceGroup.id, localName)) {
    notify(`Cannot create agent "${name}": you already have a destination named "${localName}".`);
    return;
  }

  // Derive a safe folder name, deduplicated globally across agent_groups.folder
  let folder = localName;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${localName}-${suffix}`;
    suffix++;
  }

  const groupPath = path.join(GROUPS_DIR, folder);
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
    notify(`Cannot create agent "${name}": invalid folder path.`);
    log.error('create_agent path traversal attempt', { folder, resolvedPath });
    return;
  }

  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const newGroup: AgentGroup = {
    id: agentGroupId,
    name,
    folder,
    agent_provider: null,
    created_at: now,
  };
  createAgentGroup(newGroup, { parentAgentGroupId: sourceGroup.id, lifetime });
  // A subagent inherits its creator's provider. Provider is a DB property; the
  // child is created provider-agnostic, then stamped with the parent's runtime
  // so a single-provider install (e.g. codex-only, where claude isn't
  // authenticated) doesn't spawn a child on a runtime it can't reach. The
  // operator can still flip a child later with `ncl groups config update
  // --provider`. claude (the built-in default) leaves the column unset.
  const parentProvider = getContainerConfig(sourceGroup.id)?.provider ?? undefined;
  initGroupFilesystem(newGroup, { instructions: instructions ?? undefined, provider: parentProvider });
  if (parentProvider) {
    updateContainerConfigScalars(newGroup.id, { provider: parentProvider });
  }

  // Insert bidirectional destination rows (= ACL grants).
  // Creator refers to child by the name it chose; child refers to creator as "parent".
  createDestination({
    agent_group_id: sourceGroup.id,
    local_name: localName,
    target_type: 'agent',
    target_id: agentGroupId,
    created_at: now,
  });
  // Handle the unlikely case where the child already has a "parent" destination
  // (shouldn't happen for a brand-new agent, but be safe).
  let parentName = 'parent';
  let parentSuffix = 2;
  while (getDestinationByName(agentGroupId, parentName)) {
    parentName = `parent-${parentSuffix}`;
    parentSuffix++;
  }
  createDestination({
    agent_group_id: agentGroupId,
    local_name: parentName,
    target_type: 'agent',
    target_id: sourceGroup.id,
    created_at: now,
  });

  // REQUIRED: project the new destination into the running container's
  // inbound.db. See the top-of-file invariant in db/agent-destinations.ts
  // — forgetting this causes "dropped: unknown destination" when the parent
  // tries to send to the newly-created child.
  writeDestinations(session.agent_group_id, session.id);

  notify(`Agent "${localName}" created. You can now message it with <message to="${localName}">...</message>.`);
  log.info('Agent group created', { agentGroupId, name, localName, folder, parent: sourceGroup.id, lifetime });
}
