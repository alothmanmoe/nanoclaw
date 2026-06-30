import { getAgentGroup } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { findSessionByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from './notify-agent.js';
import { isRoot } from './ownership.js';
import { teardownSubtree } from './teardown.js';

export async function handleFinishTask(content: Record<string, unknown>, session: Session): Promise<void> {
  const db = getDb();
  const selfId = session.agent_group_id;

  if (isRoot(db, selfId)) {
    notifyAgent(session, 'finish_task ignored: a top-level agent cannot terminate itself.');
    return;
  }

  const summary = typeof content.summary === 'string' ? content.summary : '';
  const self = getAgentGroup(selfId);
  const parentId = self?.parent_agent_group_id ?? null;
  if (summary && parentId) {
    const parentSession = findSessionByAgentGroup(parentId);
    if (parentSession) {
      notifyAgent(parentSession, `Agent "${self?.name ?? selfId}" finished: ${summary}`);
    }
  }

  await teardownSubtree(db, selfId);
  log.info('finish_task: agent self-terminated', { agentGroupId: selfId });
}
