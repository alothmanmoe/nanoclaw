# NanoClaw: Why Parallel Agents Cause Slower Individual Turns

**Repo:** https://github.com/nanocoai/nanoclaw  
**Date:** 2026-06-30

---

## 1. Why This Happens — Architecture & Scheduling Reasons

NanoClaw runs one Docker container per session and coordinates everything through a single host Node.js process and per-session SQLite databases. When multiple agents run in parallel, several mechanisms compound to slow each individual agent's turn:

### 1.1 Single-threaded host sweep loop (60 s tick)
**File:** `src/host-sweep.ts`, lines 72–100

The host sweep runs on a single 60-second interval and processes every active session sequentially within each tick. It must:
- Sync `processing_ack` status from every outbound.db → inbound.db
- Call `countDueMessages()` for every session
- Run stuck/ceiling detection on every running container
- Handle recurrence fanout for completed tasks

With N parallel agents, the sweep does O(N) SQLite operations per tick, all in one Node.js event loop. Each additional agent adds latency before the loop returns to earlier agents.

### 1.2 Active delivery poll is sequential across sessions
**File:** `src/delivery.ts`, lines 65–75 (1 s interval)

Every second, the active poll iterates all running containers and calls `deliverSessionMessages()` for each. Delivery is guarded by an `inflightDeliveries` Set (line 55) which prevents concurrent delivery to the same session, but the iteration itself is sequential — session A is drained, then B, then C. Each outbound DB read adds latency before the loop reaches the next session.

### 1.3 SQLite DELETE journal mode forces open/close on every host write
**File:** `src/session-manager.ts`, lines 94–107; `src/db/session-db.ts`, lines 11–25

```typescript
db.pragma('journal_mode = DELETE');  // WAL's mmap'd -shm doesn't refresh host→guest
```

WAL mode cannot be used because the memory-mapped `-shm` file doesn't refresh across Docker volume mounts — the container would silently miss all new messages. Instead, every host write opens a fresh connection, writes, and closes. This means each write flushes to disk synchronously. Under parallel load, these sequential flushes serialize on the host filesystem, adding latency per-agent proportional to the number of concurrent writers.

### 1.4 Default concurrency cap of 5 containers
**File:** `src/config.ts`, line 34

```typescript
export const MAX_CONCURRENT_CONTAINERS = Math.max(1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5
);
```

With the default of 5, any agents beyond the 5th are left with pending messages in the DB. They are not queued explicitly — they just wait for the next 60-second sweep tick, which re-evaluates due messages and tries to wake a container if a slot opened. This means extra agents can wait up to 60 seconds before they even start.

### 1.5 No CPU/memory limits by default → resource starvation
**File:** `src/config.ts`, lines 33–35

```typescript
export const CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || '';
export const CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || '';
```

By default, all containers are unbounded. With 5+ containers active simultaneously, they compete for the same host CPU and memory. More containers → more OS-level context switching → each container's Claude SDK API calls, internal processing, and SQLite reads take longer.

### 1.6 Shared agent-group workspace mount contention
**File:** `src/container-runner.ts`, lines 203–247 (buildMounts)

All sessions belonging to the same agent group share a single read-write mount at `/workspace/agent` (CLAUDE.md, CLAUDE.local.md, skills, custom scripts). Concurrent containers writing to this shared mount (e.g., updating CLAUDE.local.md, writing notes files) create filesystem contention on the host.

### 1.7 Host Node.js event loop under pressure
The single host process handles all container lifecycle events, DB writes, delivery polling, and sweep logic. More parallel containers means more concurrent async callbacks, Docker event listeners, and file watchers all competing in one Node.js event loop. This increases tail latency for any individual agent's wake/delivery cycle.

---

## 2. Potential Solutions and Mitigations

### 2.1 Increase `MAX_CONCURRENT_CONTAINERS` (easiest win)
```bash
MAX_CONCURRENT_CONTAINERS=10  # or higher, based on host capacity
```
Raises the slot ceiling. Combined with explicit CPU/memory limits (below), this prevents one container from starving others.

### 2.2 Set per-container resource limits
```bash
CONTAINER_CPU_LIMIT=1.5     # e.g., 1.5 vCPUs per container
CONTAINER_MEMORY_LIMIT=4g   # e.g., 4 GB per container
```
This prevents any one agent from monopolizing the host. With known per-container budgets, you can reliably fit more parallel agents on a host without starvation.

### 2.3 Reduce the sweep interval for latency-sensitive workloads
**File:** `src/host-sweep.ts`, line 60 (sweep interval constant)

The 60-second sweep is a coarse-grained heartbeat designed for low-overhead operation. For workloads running many short parallel tasks, reducing this to 10–15 seconds would shorten the wait for agents beyond the `MAX_CONCURRENT_CONTAINERS` limit.

### 2.4 Parallelize the delivery poll across sessions
**File:** `src/delivery.ts`, lines 65–75

Instead of awaiting `deliverSessionMessages()` per session sequentially, the poll could fan out all session deliveries with `Promise.allSettled()`. This would reduce delivery tail latency for individual agents under parallel load. The `inflightDeliveries` guard already handles re-entry safety, so the only risk is higher peak DB I/O.

### 2.5 Isolate agent group workspaces or use read-only mounts where possible
If agents in the same group don't need to write to the shared workspace concurrently, mount `/workspace/agent` as read-only for individual sessions and provide a session-specific scratch area. This eliminates shared-mount write contention.

### 2.6 Scale horizontally (multiple host processes / nodes)
Since coordination is SQLite-per-session, a future sharding layer could assign sessions to different host processes. NanoClaw's current design is single-host, but the per-session DB isolation makes horizontal scaling architecturally tractable.

---

## 3. Relevant Config/Code References

| Issue | File | Lines | Config Key |
|-------|------|--------|------------|
| Sweep loop interval (60 s) | `src/host-sweep.ts` | ~72 | hardcoded `60_000` ms |
| Sequential active delivery poll (1 s) | `src/delivery.ts` | 65–75 | hardcoded `1_000` ms |
| Delivery re-entry guard | `src/delivery.ts` | 52–58 | `inflightDeliveries` Set |
| Container concurrency cap | `src/config.ts` | 34 | `MAX_CONCURRENT_CONTAINERS` (default 5) |
| CPU limit (unset by default) | `src/config.ts` | 33 | `CONTAINER_CPU_LIMIT` |
| Memory limit (unset by default) | `src/config.ts` | 35 | `CONTAINER_MEMORY_LIMIT` |
| SQLite DELETE mode (no WAL) | `src/db/session-db.ts` | 11 | `journal_mode = DELETE` |
| Open/close DB on every host write | `src/session-manager.ts` | 94–107 | n/a (architectural) |
| Shared agent-group mount | `src/container-runner.ts` | 203–247 | `/workspace/agent` RW mount |
| Stuck detection ceiling | `src/host-sweep.ts` | 89 | `ABSOLUTE_CEILING_MS = 30 min` |
| Claim stuck threshold | `src/host-sweep.ts` | 91 | `CLAIM_STUCK_MS = 60 s` |
| Max retries before fail | `src/host-sweep.ts` | 81 | `MAX_TRIES = 5` |
| Retry backoff formula | `src/db/session-db.ts` | 108–111 | `5s * 2^tries` |
| Container wake deduplication | `src/container-runner.ts` | 39–50 | `wakePromises` Map |

---

## Summary

The slowdown under parallel load is systemic rather than a single bug. The root causes in priority order:

1. **Sequential sweep + delivery loops** — the O(N) host-side processing per tick means each additional parallel agent adds overhead that delays all others.
2. **SQLite DELETE journal mode** — necessary for cross-mount correctness, but forces synchronous per-write flushes that serialize under concurrent load.
3. **Default concurrency cap of 5** — agents beyond the cap wait up to 60 seconds before even starting.
4. **No default resource limits** — containers compete freely for host CPU/memory, causing starvation as N grows.

The highest-impact quick fixes are raising `MAX_CONCURRENT_CONTAINERS`, setting `CONTAINER_CPU_LIMIT`/`CONTAINER_MEMORY_LIMIT`, and parallelizing the delivery poll loop.
