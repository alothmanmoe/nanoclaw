/**
 * Agent management MCP tools: create_agent.
 *
 * send_to_agent was removed — sending to another agent is now just
 * send_message(to="agent-name") since agents and channels share the
 * unified destinations namespace.
 *
 * create_agent writes central-DB state. The host authorizes it by CLI scope:
 * trusted owner agent groups (scope 'global') create directly; confined groups
 * require admin approval (see src/modules/agent-to-agent/create-agent.ts). This
 * tool just writes the outbound request; authorization is enforced host-side,
 * not here — the container is untrusted and cannot be relied on to gate itself.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const createAgent: McpToolDefinition = {
  tool: {
    name: 'create_agent',
    description:
      'Create a sub-agent (research assistant, task manager, specialist) — the name becomes your destination for it. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable name (also becomes your destination name for this agent)' },
        instructions: { type: 'string', description: 'CLAUDE.md content for the new agent (personality, role, instructions)' },
        lifetime: { type: 'string', enum: ['task', 'persistent'], description: "'task' (default) self-reaps via finish_task when done; 'persistent' stays until you delete_agent it." },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!name) return err('name is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_agent',
        requestId,
        name,
        instructions: (args.instructions as string) || null,
        lifetime: (args.lifetime as string) === 'persistent' ? 'persistent' : 'task',
      }),
    });

    log(`create_agent: ${requestId} → "${name}"`);
    return ok(`Creating agent "${name}". You will be notified when it is ready.`);
  },
};

export const deleteAgent: McpToolDefinition = {
  tool: {
    name: 'delete_agent',
    description:
      'Tear down a sub-agent you created (and everything it spawned). You may only delete agents in your own subtree — never a parent, sibling, or unrelated agent. Use the destination name you gave the agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Destination name (or agent-group id) of the agent to reap.' },
      },
      required: ['target'],
    },
  },
  async handler(args) {
    const target = args.target as string;
    if (!target) return err('target is required');
    const requestId = generateId();
    writeMessageOut({ id: requestId, kind: 'system', content: JSON.stringify({ action: 'delete_agent', requestId, target }) });
    log(`delete_agent: ${requestId} → "${target}"`);
    return ok(`Tearing down "${target}"…`);
  },
};

export const finishTask: McpToolDefinition = {
  tool: {
    name: 'finish_task',
    description:
      "Declare your task complete and tear yourself down (and anything you spawned). Send your final result to your parent with send_message FIRST, then call this. Only for spawned task agents — a top-level agent cannot self-terminate.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: 'Optional one-line completion note relayed to your parent.' },
      },
    },
  },
  async handler(args) {
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'finish_task', requestId, summary: (args.summary as string) || '' }),
    });
    log(`finish_task: ${requestId}`);
    return ok('Finishing task and tearing down…');
  },
};

registerTools([createAgent, deleteAgent, finishTask]);
