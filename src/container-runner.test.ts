import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the agent-group lookup so spawnContainer (if ever reached) early-returns
// at its `if (!agentGroup)` guard BEFORE touching Docker/OneCLI. This keeps the
// capacity-gate tests below from ever launching a real container, in both the
// gate-present and gate-absent states.
vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(() => null),
}));

import { __setActiveForTest, resolveProviderName, wakeContainer } from './container-runner.js';
import { MAX_CONCURRENT_CONTAINERS } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import type { Session } from './types.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

function makeSession(id: string): Session {
  return {
    id,
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

describe('wakeContainer capacity gate', () => {
  afterEach(() => {
    // Reset the active-container map so seeded state doesn't leak between tests.
    __setActiveForTest([]);
    vi.mocked(getAgentGroup).mockClear();
  });

  it('defers (returns false, no spawn) when at MAX_CONCURRENT_CONTAINERS', async () => {
    // Seed the active map to the cap. The gate must return before spawnContainer,
    // so getAgentGroup (spawnContainer's first call) is never consulted — proving
    // no spawn was attempted.
    __setActiveForTest(Array.from({ length: MAX_CONCURRENT_CONTAINERS }, (_, i) => `running-${i}`));
    const spawned = await wakeContainer(makeSession('sess-overflow'));
    expect(spawned).toBe(false);
    expect(getAgentGroup).not.toHaveBeenCalled();
  });

  it('passes the gate when below the cap', async () => {
    // Below the cap: the gate is not hit, so wakeContainer proceeds into
    // spawnContainer, which consults getAgentGroup (mocked → null) and
    // early-returns before any Docker/OneCLI call. wakeContainer still resolves
    // true, proving the gate let it through.
    __setActiveForTest([]);
    const spawned = await wakeContainer(makeSession('sess-ok'));
    expect(spawned).toBe(true);
    expect(getAgentGroup).toHaveBeenCalled();
  });

  it('synchronous reservation blocks the last slot for a concurrent same-tick caller', async () => {
    // Seed MAX-1 running containers so exactly one slot remains.
    __setActiveForTest(Array.from({ length: MAX_CONCURRENT_CONTAINERS - 1 }, (_, i) => `running-${i}`));

    // Call A claims the last slot synchronously (before any await inside spawnContainer).
    const pA = wakeContainer(makeSession('res-a'));
    // Call B arrives in the same tick — the reservation must already be counted.
    const pB = wakeContainer(makeSession('res-b'));

    // B is deferred because A's reservation filled the slot.
    expect(await pB).toBe(false);
    // A passed the gate; spawnContainer early-returns (getAgentGroup → null).
    expect(await pA).toBe(true);
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('per-container resource limits (structural)', () => {
  // CONTAINER_CPU_LIMIT / CONTAINER_MEMORY_LIMIT pass through to `docker run` as
  // --cpus / --memory, but only when set. The default is empty string → no flag →
  // today's unbounded behavior (don't OOM existing OSS workloads). Swap is not
  // managed here (a swapless host makes --memory a hard cap). buildContainerArgs
  // needs a live gateway to drive, so guard the wiring structurally: the flags
  // must be pushed, and each must be guarded by its env knob so empty emits nothing.
  it('reads both limit knobs from config', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('CONTAINER_CPU_LIMIT');
    expect(src).toContain('CONTAINER_MEMORY_LIMIT');
  });

  it('guards --cpus behind a truthy CONTAINER_CPU_LIMIT', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_CPU_LIMIT\)[\s\S]*?args\.push\('--cpus', CONTAINER_CPU_LIMIT\)/);
  });

  it('guards --memory behind a truthy CONTAINER_MEMORY_LIMIT (and sets no swap flag)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_MEMORY_LIMIT\) args\.push\('--memory', CONTAINER_MEMORY_LIMIT\)/);
    expect(src).not.toContain('--memory-swap');
  });

  it('defaults both knobs to empty string in config (no flag = unbounded)', () => {
    const cfg = fs.readFileSync(path.join(process.cwd(), 'src', 'config.ts'), 'utf-8');
    expect(cfg).toContain("CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || ''");
    expect(cfg).toContain("CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || ''");
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});
