## Agent fleet (`create_agent`, `delete_agent`, `finish_task`)

`mcp__nanoclaw__create_agent({ name, instructions, lifetime? })` spins up a new agent and wires it as a bidirectional destination.

### Spawning

- **No approval required** — spawning is immediate for any `cli_scope`.
- The agent's `name` becomes a destination on both sides: address it via `send_message({ to: "<name>", ... })`, and its replies arrive with `from="<name>"`.
- Each agent gets its own container, workspace, and session. `instructions` seeds the agent's `CLAUDE.local.md`.
- **Fire-and-forget:** the call returns immediately; messages queue until the agent is up.
- **Fleet cap:** `MAX_MANAGED_AGENTS` (default 100) counts live `lifetime='task'` agents. At or over the cap, `create_agent` is rejected outright — not queued or approval-gated. Reap finished task agents first with `delete_agent`, or wait for them to call `finish_task`.

### `lifetime` — task vs persistent

| Value | Behavior |
|-------|----------|
| `'task'` (default) | Short-lived work agent. Counted toward the fleet cap. Self-reaps via `finish_task` when done. |
| `'persistent'` | Long-lived companion or collaborator. Not counted toward the fleet cap. Stays until explicitly deleted. |

Pass `lifetime: 'persistent'` for agents that accumulate memory or are permanently wired (Researcher, Calendar, Builder, etc.). Omit it (or pass `'task'`) for delegated work that should clean itself up.

### When to use

- **Task agents (default)** — parallel work that finishes in one interaction: running checks, filing a PR, compiling a report. Spawn, delegate, have it `finish_task` when done.
- **Persistent companions** — a long-running presence that accumulates context over time: a `Researcher` tracking an ongoing inquiry, a `Calendar` agent managing scheduling.

For one-off lookups or short stateless work, use the SDK `Agent` tool instead — it leaves no persistent footprint.

### Subtree ownership and authorization

- A spawned agent's parent is set to the creating agent's group, forming an ownership tree.
- You may reap **only yourself or a transitive descendant** — never a parent, sibling, unrelated agent, or any top-level (root) agent.

### `delete_agent(target)` — reap a descendant

Tears down a sub-agent you created (and everything it spawned, deepest-first). `target` is the destination name you use for the agent, or its agent-group ID. Teardown is complete: kills the container, removes all DB rows, removes the OneCLI vault agent, and deletes the on-disk directories.

### `finish_task(summary?)` — self-terminate when done

Call this when your task is complete. It relays an optional `summary` to your parent and reaps your subtree. Always `send_message` your result to your parent **before** calling `finish_task` — the tool terminates the container immediately after. Top-level (root) agents cannot call `finish_task` themselves.

### Writing good `instructions`

Cover: the agent's role, who it takes tasks from (you, by name), how it should report back (on completion only? with milestones?), any domain-specific rules, and whether to call `finish_task` when done. Don't restate NanoClaw base behavior — the shared base is already loaded on the agent's end.