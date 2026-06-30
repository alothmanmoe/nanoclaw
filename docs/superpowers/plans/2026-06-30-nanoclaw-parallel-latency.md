# NanoClaw Parallel-Latency Improvements + Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce per-agent latency under parallel load (parallel delivery polls + configurable loop intervals + tuned resource caps + a *newly-enforced* concurrency cap), make latency measurable via a perf-metrics module, and install the NanoClaw dashboard with those metrics wired into it.

**Architecture:** Host-side only. Centralize tunable interval constants in `src/config.ts`; fan out the two delivery poll loops in `src/delivery.ts` with `Promise.allSettled`; enforce `MAX_CONCURRENT_CONTAINERS` with a capacity gate in `wakeContainer` that defers over-cap wakes to the existing host-sweep retry path; add a dependency-free `src/perf-metrics.ts` ring-buffer module that records timing events as structured log lines and exposes rolling aggregates; install the `@nanoco/nanoclaw-dashboard` skill and extend its pusher snapshot with a `performance` block fed by the perf module.

**Tech Stack:** Node + TypeScript (host, pnpm), vitest, better-sqlite3, `@nanoco/nanoclaw-dashboard`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-30-nanoclaw-parallel-latency-design.md`.
- Do **not** restart the NanoClaw service or Docker during implementation — the user has agents mid-task. All work here is non-disruptive (edits, install, build, tests, commits). Restart-dependent steps are staged and handed off, never executed.
- Do **not** touch the SQLite `DELETE` journal mode — load-bearing for cross-mount correctness.
- Do **not** change the sweep's kill / recurrence / stuck-detection logic — only its *interval*.
- No AI attribution / co-author trailer in any commit.
- No secrets committed: `.env` stays untracked.
- Env-var defaults must preserve today's behavior when the var is unset.
- A pre-commit hook runs `prettier --write` on `src/**/*.ts`; let it run, then `git add -u` re-staged files if needed.
- Host tests: `pnpm test` (vitest). Build: `pnpm run build`.

---

### Task 1: Remove vestigial v1 CLAUDE.md files

Both files are stock v1 defaults already removed from disk by `migrateGroupsToClaudeLocal()` (`src/claude-md-compose.ts:152`). No custom content. Pure git bookkeeping — no test cycle applies.

**Files:**
- Delete: `groups/global/CLAUDE.md`
- Delete: `groups/main/CLAUDE.md`

- [ ] **Step 1: Stage the deletions**

```bash
cd /Users/moe/Documents/projects/ai/nanoclaw
git rm groups/global/CLAUDE.md groups/main/CLAUDE.md
```

- [ ] **Step 2: Verify only those two paths are staged as deletions**

Run: `git status --short groups/`
Expected: `D  groups/global/CLAUDE.md` and `D  groups/main/CLAUDE.md`, nothing else.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: remove vestigial v1 stock CLAUDE.md files (global/main)"
```

---

### Task 2: Centralize tunable interval constants in config.ts

Make the three loop intervals env-overridable via a small pure helper, defaulting to today's values.

**Files:**
- Modify: `src/config.ts` (add helper + 3 constants)
- Modify: `src/delivery.ts:30-31` (import instead of local const)
- Modify: `src/host-sweep.ts:62` (import instead of local const)
- Test: `src/config.test.ts` (create)

**Interfaces:**
- Produces: `parseIntEnv(name: string, fallback: number): number`; constants `ACTIVE_POLL_MS`, `SWEEP_POLL_MS`, `SWEEP_INTERVAL_MS` (all `number`), exported from `src/config.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/config.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { parseIntEnv } from './config.js';

describe('parseIntEnv', () => {
  const KEY = 'NANOCLAW_TEST_INT';
  afterEach(() => { delete process.env[KEY]; });

  it('returns the fallback when the var is unset', () => {
    delete process.env[KEY];
    expect(parseIntEnv(KEY, 1000)).toBe(1000);
  });

  it('returns the fallback when the var is empty', () => {
    process.env[KEY] = '';
    expect(parseIntEnv(KEY, 1000)).toBe(1000);
  });

  it('parses a positive integer override', () => {
    process.env[KEY] = '20000';
    expect(parseIntEnv(KEY, 1000)).toBe(20000);
  });

  it('rejects non-positive or non-numeric values, using the fallback', () => {
    process.env[KEY] = '0';
    expect(parseIntEnv(KEY, 1000)).toBe(1000);
    process.env[KEY] = 'abc';
    expect(parseIntEnv(KEY, 1000)).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/config.test.ts`
Expected: FAIL — `parseIntEnv` is not exported.

- [ ] **Step 3: Add the helper and constants to config.ts**

In `src/config.ts`, add after the existing `MAX_CONCURRENT_CONTAINERS` block (~line 45):

```typescript
/**
 * Parse a positive-integer env override, falling back to a default.
 * Empty, zero, negative, and non-numeric values fall back — so an unset or
 * malformed env var never changes today's behavior.
 */
export function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Loop intervals (ms). Defaults preserve pre-tuning behavior.
export const ACTIVE_POLL_MS = parseIntEnv('ACTIVE_POLL_MS', 1000);
export const SWEEP_POLL_MS = parseIntEnv('SWEEP_POLL_MS', 60_000);
export const SWEEP_INTERVAL_MS = parseIntEnv('SWEEP_INTERVAL_MS', 60_000);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Switch delivery.ts to the shared constants**

In `src/delivery.ts`, delete the local declarations at lines 30-31:

```typescript
const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;
```

Add `ACTIVE_POLL_MS, SWEEP_POLL_MS` to the existing import from `./config.js`. There is no current `./config.js` import in delivery.ts, so add one near the other imports:

```typescript
import { ACTIVE_POLL_MS, SWEEP_POLL_MS } from './config.js';
```

- [ ] **Step 6: Switch host-sweep.ts to the shared constant**

In `src/host-sweep.ts`, delete the local declaration at line 62:

```typescript
const SWEEP_INTERVAL_MS = 60_000;
```

Add to imports at the top of the file:

```typescript
import { SWEEP_INTERVAL_MS } from './config.js';
```

(If `host-sweep.ts` already imports from `./config.js`, add `SWEEP_INTERVAL_MS` to that import list instead of adding a new line.)

- [ ] **Step 7: Typecheck + full host tests**

Run: `pnpm run build && pnpm test`
Expected: build succeeds; all tests pass (no behavior change — defaults equal old literals).

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/config.test.ts src/delivery.ts src/host-sweep.ts
git commit -m "feat: make loop intervals env-configurable (defaults unchanged)"
```

---

### Task 3: Parallelize the delivery poll loops

Replace the sequential `for…await` in both poll loops with a fan-out helper.

**Files:**
- Modify: `src/delivery.ts` (`pollActive` ~124, `pollSweep` ~139; add exported `deliverAllSessions`)
- Test: `src/delivery.test.ts` (add a concurrency test)

**Interfaces:**
- Consumes: `deliverSessionMessages(session: Session): Promise<void>` (existing, `delivery.ts:154`).
- Produces: `deliverAllSessions(sessions: Session[]): Promise<void>` exported from `src/delivery.ts` — delivers all sessions concurrently, never rejects (uses `Promise.allSettled`).

- [ ] **Step 1: Write the failing test**

Append to `src/delivery.test.ts` (inside the top-level `describe`, reusing its `seedAgentAndChannel`/session helpers — mirror how existing tests seed two sessions and set the adapter; if a helper to seed a second session does not exist, seed it inline the way the existing tests do):

```typescript
import { deliverAllSessions } from './delivery.js';

it('delivers sessions concurrently, not sequentially', async () => {
  // Two sessions each with one undelivered outbound message.
  const s1 = /* seed session A with an undelivered message */ seedSessionWithMessage('thread-a');
  const s2 = /* seed session B with an undelivered message */ seedSessionWithMessage('thread-b');

  // Adapter whose deliver() takes ~50ms each.
  setDeliveryAdapter({
    deliver: async () => { await new Promise((r) => setTimeout(r, 50)); return 'mid-1'; },
  });

  const start = Date.now();
  await deliverAllSessions([s1, s2]);
  const elapsed = Date.now() - start;

  // Sequential would be ~100ms; concurrent ~50ms. Assert well under the sum.
  expect(elapsed).toBeLessThan(85);
});
```

If the file has no `seedSessionWithMessage`-style helper, write one in the test file that: creates a session via `resolveSession`, opens its outbound DB, inserts one row into `messages_out` with a future-safe `seq`/timestamp, and returns the `Session`. Model the exact insert on the existing seeding code already in `delivery.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/delivery.test.ts -t "concurrently"`
Expected: FAIL — `deliverAllSessions` is not exported.

- [ ] **Step 3: Add the fan-out helper and use it in both loops**

In `src/delivery.ts`, add the exported helper (place it just above `pollActive`):

```typescript
/**
 * Deliver every session's outbound queue concurrently. Never rejects — one
 * session's failure can't block the others (allSettled). Per-session re-entry
 * is still serialized by the inflightDeliveries guard in deliverSessionMessages.
 */
export async function deliverAllSessions(sessions: Session[]): Promise<void> {
  await Promise.allSettled(sessions.map((s) => deliverSessionMessages(s)));
}
```

Replace the body of `pollActive` (lines ~127-131) so the `for` loop becomes:

```typescript
    const sessions = getRunningSessions();
    await deliverAllSessions(sessions);
```

Replace the body of `pollSweep` (lines ~143-146) so the `for` loop becomes:

```typescript
    const sessions = getActiveSessions();
    await deliverAllSessions(sessions);
```

- [ ] **Step 4: Run the concurrency test to verify it passes**

Run: `pnpm exec vitest run src/delivery.test.ts -t "concurrently"`
Expected: PASS.

- [ ] **Step 5: Run the full delivery suite (guards the dedup/race behavior)**

Run: `pnpm exec vitest run src/delivery.test.ts`
Expected: PASS — existing race/idempotency tests still green (the `inflightDeliveries` guard is unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/delivery.ts src/delivery.test.ts
git commit -m "perf: fan out delivery poll loops concurrently"
```

---

### Task 4: Perf-metrics module (ring buffer + structured events + aggregates)

A dependency-free module that records timing events (one structured log line each, greppable by `event=`) into a bounded in-memory ring, tracks per-session cold-wake timestamps, and computes rolling aggregates for the dashboard.

**Files:**
- Create: `src/perf-metrics.ts`
- Test: `src/perf-metrics.test.ts`

**Interfaces:**
- Produces, all exported from `src/perf-metrics.ts`:
  - `recordEvent(event: string, fields: Record<string, number | string>): void` — pushes `{ event, ...fields, t }` into the ring and emits `log.info('perf', { event, ...fields })`.
  - `markWake(sessionId: string): void` — records a wake start time for a session, **set-if-absent** (keeps the earliest mark, so latency counts queue time too).
  - `markFirstDelivery(sessionId: string): void` — if a wake mark exists for the session, records a `wake_latency` event with `ms` = now − wake time and clears the mark; no-op otherwise.
  - `getAggregates(): PerfAggregates` — `{ wakeLatencyMs: { p50: number | null; p95: number | null; count: number }; pollLoops: Array<{ kind: string; sessions: number; ms: number; t: number }>; events: number }` computed over the current ring.
  - `__resetForTest(): void` — clears the ring and pending wake marks (test hook only).

- [ ] **Step 1: Write the failing tests**

Create `src/perf-metrics.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  recordEvent, markWake, markFirstDelivery, getAggregates, __resetForTest,
} from './perf-metrics.js';

describe('perf-metrics', () => {
  beforeEach(() => __resetForTest());

  it('records events into the ring and reports a count', () => {
    recordEvent('poll_loop', { kind: 'active', sessions: 3, ms: 12 });
    recordEvent('poll_loop', { kind: 'sweep', sessions: 8, ms: 40 });
    const agg = getAggregates();
    expect(agg.events).toBe(2);
    expect(agg.pollLoops).toHaveLength(2);
    expect(agg.pollLoops[1]).toMatchObject({ kind: 'sweep', sessions: 8, ms: 40 });
  });

  it('computes wake latency from markWake -> markFirstDelivery', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1000);
    markWake('sess-1');
    nowSpy.mockReturnValue(1150);
    markFirstDelivery('sess-1');
    const agg = getAggregates();
    expect(agg.wakeLatencyMs.count).toBe(1);
    expect(agg.wakeLatencyMs.p50).toBe(150);
    nowSpy.mockRestore();
  });

  it('markWake is set-if-absent: a second mark does not reset the start time', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1000);
    markWake('sess-q');       // first attempt (e.g. deferred by cap)
    nowSpy.mockReturnValue(1100);
    markWake('sess-q');       // retry attempt — must NOT overwrite
    nowSpy.mockReturnValue(1300);
    markFirstDelivery('sess-q');
    expect(getAggregates().wakeLatencyMs.p50).toBe(300); // 1300 - 1000, includes queue
    nowSpy.mockRestore();
  });

  it('markFirstDelivery is a no-op without a prior markWake', () => {
    markFirstDelivery('sess-unknown');
    expect(getAggregates().wakeLatencyMs.count).toBe(0);
  });

  it('clears the wake mark after first delivery (no double count)', () => {
    markWake('sess-2');
    markFirstDelivery('sess-2');
    markFirstDelivery('sess-2');
    expect(getAggregates().wakeLatencyMs.count).toBe(1);
  });

  it('caps the ring so memory is bounded', () => {
    for (let i = 0; i < 1000; i++) recordEvent('poll_loop', { kind: 'active', sessions: 1, ms: 1 });
    expect(getAggregates().events).toBeLessThanOrEqual(500);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/perf-metrics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `src/perf-metrics.ts`:

```typescript
/**
 * Lightweight, dependency-free latency instrumentation.
 *
 * Each recorded event is both pushed into a bounded in-memory ring (for
 * dashboard aggregates) and emitted as a structured `perf` log line (greppable
 * by `event=`, streamed live into the dashboard Logs page). No disk I/O.
 */
import { log } from './log.js';

const RING_CAP = 500;

interface PerfEvent {
  event: string;
  t: number;
  [k: string]: number | string;
}

export interface PerfAggregates {
  wakeLatencyMs: { p50: number | null; p95: number | null; count: number };
  pollLoops: Array<{ kind: string; sessions: number; ms: number; t: number }>;
  events: number;
}

const ring: PerfEvent[] = [];
const wakeMarks = new Map<string, number>();

function push(e: PerfEvent): void {
  ring.push(e);
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
}

export function recordEvent(event: string, fields: Record<string, number | string>): void {
  push({ event, t: Date.now(), ...fields });
  log.info('perf', { event, ...fields });
}

export function markWake(sessionId: string): void {
  // set-if-absent: keep the earliest mark so wake_latency includes any time the
  // session spent queued behind the concurrency cap.
  if (!wakeMarks.has(sessionId)) wakeMarks.set(sessionId, Date.now());
}

export function markFirstDelivery(sessionId: string): void {
  const started = wakeMarks.get(sessionId);
  if (started === undefined) return;
  wakeMarks.delete(sessionId);
  recordEvent('wake_latency', { sessionId, ms: Date.now() - started });
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function getAggregates(): PerfAggregates {
  const waits = ring
    .filter((e) => e.event === 'wake_latency' && typeof e.ms === 'number')
    .map((e) => e.ms as number)
    .sort((a, b) => a - b);

  const pollLoops = ring
    .filter((e) => e.event === 'poll_loop')
    .slice(-20)
    .map((e) => ({
      kind: String(e.kind),
      sessions: Number(e.sessions),
      ms: Number(e.ms),
      t: e.t,
    }));

  return {
    wakeLatencyMs: { p50: percentile(waits, 50), p95: percentile(waits, 95), count: waits.length },
    pollLoops,
    events: ring.length,
  };
}

export function __resetForTest(): void {
  ring.length = 0;
  wakeMarks.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/perf-metrics.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/perf-metrics.ts src/perf-metrics.test.ts
git commit -m "feat: add perf-metrics ring buffer + wake-latency instrumentation"
```

---

### Task 5: Wire perf metrics into the delivery loops

Hook the perf module into delivery: time the poll loops and mark first delivery.

**Files:**
- Modify: `src/delivery.ts` (`deliverAllSessions` timing; first-delivery mark)
- Test: `src/delivery.test.ts` (Task-3 test call updated)

**Interfaces:**
- Consumes: `recordEvent`, `markFirstDelivery` from `./perf-metrics.js`.

- [ ] **Step 1: Time the poll loops**

In `src/delivery.ts`, update `deliverAllSessions` (from Task 3) to take a `kind` label and record loop duration:

```typescript
export async function deliverAllSessions(sessions: Session[], kind = 'active'): Promise<void> {
  const start = Date.now();
  await Promise.allSettled(sessions.map((s) => deliverSessionMessages(s)));
  if (sessions.length > 0) {
    recordEvent('poll_loop', { kind, sessions: sessions.length, ms: Date.now() - start });
  }
}
```

Update the call in `pollActive` to `await deliverAllSessions(sessions, 'active');` and in `pollSweep` to `await deliverAllSessions(sessions, 'sweep');`. Add the import:

```typescript
import { recordEvent, markFirstDelivery } from './perf-metrics.js';
```

The Task-3 concurrency test calls `deliverAllSessions([s1, s2])` with no second arg (defaults to `'active'`) — it still asserts `< 85ms`. No test change needed.

- [ ] **Step 2: Mark first delivery**

In `src/delivery.ts`, inside `deliverSessionMessages`, in the `for (const msg of undelivered)` loop (delivery.ts ~193), immediately after the successful `markDelivered(inDb, msg.id, platformMsgId ?? null);` line, add:

```typescript
        markFirstDelivery(session.id); // no-op unless a wake is pending; self-clears
```

(`markFirstDelivery` self-clears after the first call per wake, so calling it for each delivered message is safe — only the first records a `wake_latency`.)

- [ ] **Step 3: Build + full suite**

Run: `pnpm run build && pnpm test`
Expected: build clean; all tests green.

- [ ] **Step 4: Commit**

```bash
git add src/delivery.ts src/delivery.test.ts
git commit -m "feat: instrument delivery poll loops and first-delivery latency"
```

---

### Task 6: Enforce the concurrency cap (backpressure) + slot_wait

`MAX_CONCURRENT_CONTAINERS` is currently defined but never enforced — `wakeContainer` spawns for every due session. Add a capacity gate that defers over-cap wakes to the existing host-sweep retry path, and mark the wake start (set-if-absent) so queue time is counted.

**Files:**
- Modify: `src/container-runner.ts` (`wakeContainer` ~88-111; add cap gate, `markWake`, `slot_wait`)
- Test: `src/container-runner.test.ts` (add cap-gate tests)

**Interfaces:**
- Consumes: `MAX_CONCURRENT_CONTAINERS` from `./config.js`; `markWake`, `recordEvent` from `./perf-metrics.js`; existing `activeContainers` Map, `isContainerRunning`.

- [ ] **Step 1: Write the failing test**

Open `src/container-runner.test.ts` and read its existing setup (it already mocks the spawn path — follow that pattern; `spawnContainer` actually launches Docker, so the test must mock or spy the spawn so no real container starts). Add a describe block:

```typescript
import { wakeContainer, getActiveContainerCount } from './container-runner.js';

// NOTE: match the file's existing mocking of the Docker spawn path so
// wakeContainer does not launch a real container. The assertion below is on
// the boolean contract + that no spawn happens at capacity.

describe('wakeContainer capacity gate', () => {
  it('defers (returns false, no spawn) when at MAX_CONCURRENT_CONTAINERS', async () => {
    // Arrange: force activeContainers.size to the cap using the file's test
    // hook / the same mechanism existing tests use to simulate running
    // containers. If none exists, expose a __setActiveForTest(n) helper in
    // container-runner.ts guarded for tests, mirroring perf-metrics' __resetForTest.
    fillActiveContainersToCap(); // helper: brings size to MAX_CONCURRENT_CONTAINERS
    const session = makeSession('sess-overflow');
    const spawned = await wakeContainer(session);
    expect(spawned).toBe(false);
    expect(spawnSpy).not.toHaveBeenCalled(); // the mocked spawn path
  });

  it('spawns normally when below the cap', async () => {
    const session = makeSession('sess-ok');
    const spawned = await wakeContainer(session);
    expect(spawned).toBe(true);
    expect(spawnSpy).toHaveBeenCalledOnce();
  });
});
```

If `container-runner.test.ts` has no clean way to set `activeContainers` size, add a tiny test-only hook in `src/container-runner.ts` next to `getActiveContainerCount`:

```typescript
/** Test-only: seed the active-container map to simulate N running containers. */
export function __setActiveForTest(ids: string[]): void {
  activeContainers.clear();
  for (const id of ids) activeContainers.set(id, { process: null as never, containerName: id });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/container-runner.test.ts -t "capacity gate"`
Expected: FAIL — over-cap wake still returns `true` / still spawns.

- [ ] **Step 3: Add the capacity gate to wakeContainer**

In `src/container-runner.ts`, edit `wakeContainer` (currently lines ~88-111). After the `activeContainers.has(session.id)` early-return and the `wakePromises.get` in-flight check, but **before** building the spawn promise, insert the gate; and add the `markWake` at the very top for any non-running session:

```typescript
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  // Mark the wake start (set-if-absent) so wake_latency includes queue time.
  markWake(session.id);

  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }

  // Capacity gate: at the cap, defer. The inbound row stays pending and
  // host-sweep re-wakes on its next tick (same path as transient spawn
  // failure). This is the system's backpressure — see the spec, Workstream F.
  if (activeContainers.size >= MAX_CONCURRENT_CONTAINERS) {
    recordEvent('slot_wait', { sessionId: session.id, active: activeContainers.size });
    log.debug('At container capacity — deferring wake', {
      sessionId: session.id,
      active: activeContainers.size,
      cap: MAX_CONCURRENT_CONTAINERS,
    });
    return Promise.resolve(false);
  }

  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}
```

Add the imports at the top of `container-runner.ts`:

```typescript
import { MAX_CONCURRENT_CONTAINERS } from './config.js';
import { markWake, recordEvent } from './perf-metrics.js';
```

(If `./config.js` is already imported, add `MAX_CONCURRENT_CONTAINERS` to that import list.)

- [ ] **Step 4: Run cap tests to verify they pass**

Run: `pnpm exec vitest run src/container-runner.test.ts`
Expected: PASS — defers at cap, spawns below cap; existing container-runner tests still green.

- [ ] **Step 5: Build + full suite**

Run: `pnpm run build && pnpm test`
Expected: all green. (Note: `host-core.test.ts` and others mock `getActiveContainerCount`; the new gate reads `activeContainers.size` directly, so those mocks are unaffected.)

- [ ] **Step 6: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat: enforce MAX_CONCURRENT_CONTAINERS with host-sweep-backed backpressure"
```

---

### Task 7: Install the dashboard skill

Run the `/add-dashboard` skill's apply steps. This installs the package, copies the pusher + its tests, wires `index.ts`, and sets env vars. **No service restart** — the build + tests are non-disruptive; the running service keeps using its current build until the user restarts later.

**Files:**
- Create: `src/dashboard-pusher.ts`, `src/dashboard-pusher.test.ts`, `src/dashboard-wiring.test.ts` (copied from `.claude/skills/add-dashboard/resources/`)
- Modify: `src/index.ts` (colocated `startDashboard()` block in `main()`)
- Modify: `package.json` / `pnpm-lock.yaml` (dependency)
- Modify: `.env` (add `DASHBOARD_SECRET`, `DASHBOARD_PORT`) — untracked, not committed

- [ ] **Step 1: Install the package**

```bash
cd /Users/moe/Documents/projects/ai/nanoclaw
pnpm install @nanoco/nanoclaw-dashboard
```

- [ ] **Step 2: Copy the three resource files into src/**

```bash
cp .claude/skills/add-dashboard/resources/dashboard-pusher.ts      src/dashboard-pusher.ts
cp .claude/skills/add-dashboard/resources/dashboard-pusher.test.ts src/dashboard-pusher.test.ts
cp .claude/skills/add-dashboard/resources/dashboard-wiring.test.ts src/dashboard-wiring.test.ts
```

- [ ] **Step 3: Wire into src/index.ts**

In `src/index.ts`, inside `main()`, immediately before the `log.info('NanoClaw running')` line (match the exact existing boot-complete log string in the file), add:

```typescript
  // Dashboard (optional; no-ops without DASHBOARD_SECRET)
  const { startDashboard } = await import('./dashboard-pusher.js');
  await startDashboard();
```

- [ ] **Step 4: Add env vars to .env (untracked)**

Generate a secret and append both vars to `.env` (do not overwrite existing keys):

```bash
SECRET=$(node -e "console.log('nc-' + require('crypto').randomBytes(16).toString('hex'))")
printf '\nDASHBOARD_SECRET=%s\nDASHBOARD_PORT=3100\n' "$SECRET" >> .env
grep -E '^DASHBOARD_' .env
```

- [ ] **Step 5: Build (dependency guard) + run the skill's tests**

```bash
pnpm run build
pnpm exec vitest run src/dashboard-pusher.test.ts src/dashboard-wiring.test.ts
```

Expected: build succeeds (proves the package is installed); both tests pass (wiring + behavior).

- [ ] **Step 6: Commit (code only — .env stays out)**

```bash
git add src/dashboard-pusher.ts src/dashboard-pusher.test.ts src/dashboard-wiring.test.ts src/index.ts package.json pnpm-lock.yaml
git commit -m "feat: install nanoclaw dashboard pusher"
```

Confirm `.env` is **not** staged: `git status --short .env` should show it untracked/ignored, never staged.

---

### Task 8: Add a `performance` block to the dashboard snapshot

Feed the perf-metrics aggregates into the pusher's snapshot so they ride along in `/api/ingest` and `/api/overview`.

**Files:**
- Modify: `src/dashboard-pusher.ts` (`collectSnapshot`)
- Modify: `src/dashboard-pusher.test.ts` (assert the new block)

**Interfaces:**
- Consumes: `getAggregates()` from `./perf-metrics.js`.

- [ ] **Step 1: Write the failing test**

In `src/dashboard-pusher.test.ts`, add a test asserting the snapshot includes a `performance` key shaped like the aggregates. Use the file's existing snapshot-capture mechanism (it already posts a snapshot to a fake dashboard — assert on that captured body). Minimal addition:

```typescript
import { recordEvent, __resetForTest } from './perf-metrics.js';

it('includes a performance block in the snapshot', async () => {
  __resetForTest();
  recordEvent('poll_loop', { kind: 'active', sessions: 2, ms: 9 });
  const snap = collectSnapshotForTest(); // use the file's existing snapshot accessor
  expect(snap.performance).toBeDefined();
  expect(snap.performance.pollLoops.length).toBeGreaterThan(0);
  expect(snap.performance.wakeLatencyMs).toHaveProperty('count');
});
```

If `collectSnapshot` is not exported by the copied pusher, export it (rename-free) so the test can call it directly; the behavior test already in the file shows how it accesses snapshot data — follow that pattern rather than adding a new export if one already exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/dashboard-pusher.test.ts -t "performance block"`
Expected: FAIL — `performance` is undefined on the snapshot.

- [ ] **Step 3: Add the block to collectSnapshot**

In `src/dashboard-pusher.ts`, add the import:

```typescript
import { getAggregates } from './perf-metrics.js';
```

In `collectSnapshot()`, add one field to the returned object:

```typescript
    performance: getAggregates(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/dashboard-pusher.test.ts`
Expected: PASS (existing pusher tests + the new one).

- [ ] **Step 5: Build + full suite**

Run: `pnpm run build && pnpm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard-pusher.ts src/dashboard-pusher.test.ts
git commit -m "feat: surface perf aggregates in dashboard snapshot"
```

---

### Task 9: Stage tuned `.env` values + write the deferred handoff checklist

Write the tuned runtime values into `.env` (non-disruptive — they take effect only on the next service restart, which we are NOT doing) and produce the operator checklist for the restart-dependent steps.

**Files:**
- Modify: `.env` (untracked — append/overwrite tuning keys)
- Create: `docs/superpowers/plans/2026-06-30-deferred-restart-checklist.md`

- [ ] **Step 1: Set the tuned values in .env (idempotent)**

For each key, overwrite if present else append. Run:

```bash
cd /Users/moe/Documents/projects/ai/nanoclaw
set_env() {
  local k="$1" v="$2"
  if grep -q "^${k}=" .env; then
    sed -i.bak "s|^${k}=.*|${k}=${v}|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$k" "$v" >> .env
  fi
}
set_env MAX_CONCURRENT_CONTAINERS 10
set_env CONTAINER_CPU_LIMIT 2
set_env CONTAINER_MEMORY_LIMIT 4g
set_env SWEEP_INTERVAL_MS 20000
set_env SWEEP_POLL_MS 20000
grep -E '^(MAX_CONCURRENT_CONTAINERS|CONTAINER_CPU_LIMIT|CONTAINER_MEMORY_LIMIT|SWEEP_INTERVAL_MS|SWEEP_POLL_MS)=' .env
```

Expected: the five lines echo back the tuned values.

- [ ] **Step 2: Confirm .env is not tracked**

Run: `git status --short .env`
Expected: untracked or ignored — never staged. Do not commit `.env`.

- [ ] **Step 3: Write the deferred checklist doc**

Create `docs/superpowers/plans/2026-06-30-deferred-restart-checklist.md`:

```markdown
# Deferred restart checklist — run when in-flight agents finish

These steps disrupt running containers, so they were intentionally NOT run
during implementation. Run them yourself once your agents are idle.

1. **Raise Docker Desktop VM memory to ≥ 40 GB** (Docker Desktop → Settings →
   Resources → Memory). Needed because `CONTAINER_MEMORY_LIMIT=4g` ×
   `MAX_CONCURRENT_CONTAINERS=10` = 40 GB worst case. This requires a Docker
   restart. If you prefer not to raise it that high, lower
   `CONTAINER_MEMORY_LIMIT` to `3g` in `.env` instead.

2. **Restart NanoClaw** to pick up the new `.env` values and the new build:
   `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

3. **Verify the dashboard is live:**
   - `curl -s http://localhost:3100/api/status`
   - Open `http://localhost:3100/dashboard`
   - Confirm timing lines appear: tail the log and look for `perf` entries:
     `grep 'perf ' logs/nanoclaw.log | tail` (events: `poll_loop`,
     `wake_latency`, `slot_wait`).

4. **Sanity-check parallel latency:** run a few agents in parallel and watch
   `wake_latency` p50/p95 and `poll_loop` durations on the dashboard Logs page
   or via grep. If `slot_wait` events are frequent, raise
   `MAX_CONCURRENT_CONTAINERS`; if containers OOM, lower
   `CONTAINER_MEMORY_LIMIT`.
```

- [ ] **Step 4: Commit the checklist doc**

```bash
git add docs/superpowers/plans/2026-06-30-deferred-restart-checklist.md
git commit -m "docs: deferred restart checklist for parallel-latency tuning"
```

---

## Self-Review

**Spec coverage:**
- A (config tuning) → Task 9 (`.env`) + deferred checklist.
- B (parallelize polls + configurable intervals) → Task 2 (intervals) + Task 3 (fan-out).
- C (measurement) → Task 4 (module) + Task 5 (delivery wiring); `slot_wait` + `markWake` in Task 6.
- D (dashboard install + metric wiring) → Task 7 (install) + Task 8 (`performance` block).
- E (vestigial cleanup) → Task 1.
- F (enforce concurrency cap / backpressure) → Task 6.
- Non-goals (journal mode, sweep logic, horizontal scaling) → respected; called out in Global Constraints.
- Deferral/rollout → Task 9 checklist.

**Placeholder scan:** Code blocks are concrete. The "match the existing pattern" notes (delivery.test seeding helper in Task 3; container-runner spawn-mock + active-map seeding in Task 6; snapshot accessor in Task 8) point at existing in-file patterns and supply a concrete fallback hook (`__setActiveForTest`) where one may be missing — acceptable because the exact insert/accessor is codebase-specific and the surrounding tests already demonstrate it.

**Type consistency:** `recordEvent`, `markWake`, `markFirstDelivery`, `getAggregates`, `PerfAggregates`, `deliverAllSessions(sessions, kind)` are named identically across Tasks 3–8. `parseIntEnv` / `ACTIVE_POLL_MS` / `SWEEP_POLL_MS` / `SWEEP_INTERVAL_MS` consistent across Tasks 2–5. `MAX_CONCURRENT_CONTAINERS` consumed in Task 6, set in Task 9.

**Open verification point (flagged, not a gap):** Task 6 Step 1 — `container-runner.test.ts`'s existing Docker-spawn mocking mechanism and a way to seed `activeContainers` size must be located at implementation time; the step supplies a concrete `__setActiveForTest` fallback so the uncertainty is bounded.
