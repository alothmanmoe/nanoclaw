# NanoClaw Parallel-Latency Improvements + Dashboard — Design

**Date:** 2026-06-30
**Status:** Approved
**Scope:** Quick wins + measurement. Horizontal scaling explicitly out of scope.
**Host target for defaults:** Apple M5 Pro, 18 cores, 48 GB RAM, Docker Desktop runtime.

---

## Problem

Running multiple agent containers in parallel makes each individual agent's turn
feel laggy. An AI investigation (`docs/nanoclaw-parallel-report.md`) attributed
this to single-host, single-event-loop coordination: sequential delivery/sweep
loops, a default 5-container cap, no resource limits, and synchronous SQLite
writes.

Verifying the report against current code: two of its "easy wins" are **already
implemented** and need only configuration (`MAX_CONCURRENT_CONTAINERS`,
`CONTAINER_CPU_LIMIT`, `CONTAINER_MEMORY_LIMIT` all exist in `src/config.ts`).
The SQLite `DELETE` journal-mode item is **rejected** — it is load-bearing for
cross-mount correctness and will not be touched. The genuine remaining code work
is parallelizing the delivery polls and making the loop intervals configurable.
Plus the user wants measurement, surfaced through the dashboard.

## Goals

1. Reduce per-agent wake→delivery latency under parallel load.
2. Make latency **measurable**, surfaced via the NanoClaw dashboard.
3. Tune runtime defaults to the user's machine.
4. Keep every change low-risk and reversible; change no load-bearing invariant.

## Non-Goals

- Horizontal scaling / multi-process sharding (future spec, only if data warrants).
- Changing the SQLite `DELETE` journal mode.
- Changing the sweep's kill / recurrence / stuck-detection logic (only its interval).

---

## Workstreams

### A. Config tuning (`.env` only — no code change)

The code already supports these; set values tuned to 18-core / 48 GB:

| Var | Current default | New value | Rationale |
|-----|-----------------|-----------|-----------|
| `MAX_CONCURRENT_CONTAINERS` | 5 (`config.ts:40`) | `10` | Agents are mostly API-wait-bound; cores oversubscribe cleanly. Doubles slot ceiling. |
| `CONTAINER_CPU_LIMIT` | `''` unbounded (`config.ts:44`) | `2` | Caps a single runaway agent at 2 vCPU; protects the other 9. |
| `CONTAINER_MEMORY_LIMIT` | `''` unbounded (`config.ts:45`) | `4g` | 10 × 4g = 40g worst case, ~8g headroom for host + runtime. |

**Docker Desktop caveat:** the Docker VM has its own RAM allocation. 10 × 4g
needs the VM at ≥40g. At apply time, confirm the VM allocation; if it is lower,
reduce `CONTAINER_MEMORY_LIMIT` (e.g. `3g`) or raise the VM. The user will raise
the VM allocation manually (requires a Docker restart) when convenient.

These values take effect only on a **NanoClaw service restart**, which kills and
respawns containers. Deferred until the user's in-flight agents finish.

### B. Code — parallelize delivery polls + configurable intervals

**File: `src/delivery.ts`**

- `pollActive` (`:124`) and `pollSweep` (`:139`) currently `await
  deliverSessionMessages(session)` sequentially in a `for` loop (`:129`, `:144`).
  Replace each loop body with a fan-out:
  `await Promise.allSettled(sessions.map((s) => deliverSessionMessages(s)))`.
- Safety: the existing `inflightDeliveries` Set guard (`:50`, `:157`) already
  prevents concurrent delivery to the *same* session. Different sessions write
  to independent `outbound.db` files — no shared mutable state. `allSettled`
  (not `all`) so one session's failure can't reject the batch.
- Make poll intervals env-overridable, defaulting to today's values:
  - `ACTIVE_POLL_MS` (`:30`, currently `1000`) ← `process.env.ACTIVE_POLL_MS`
  - `SWEEP_POLL_MS` (`:31`, currently `60_000`) ← `process.env.SWEEP_POLL_MS`

**File: `src/host-sweep.ts`**

- `SWEEP_INTERVAL_MS` (`:62`, currently hardcoded `60_000`) ← env-overridable
  via `process.env.SWEEP_INTERVAL_MS`, default unchanged.
- The sweep's per-session maintenance work (kill/recurrence/stuck) is **not**
  parallelized — only its interval becomes configurable. For this host the
  interval is set to `20000` (20 s) so agents queued beyond the slot cap start
  sooner.

**Tuned `.env` additions (B):** `SWEEP_INTERVAL_MS=20000` (and optionally
`SWEEP_POLL_MS=20000` to match the delivery sweep). `ACTIVE_POLL_MS` left at
default.

Centralize parsing in `src/config.ts` where the other runtime knobs live, keeping
`host-sweep.ts` / `delivery.ts` importing named constants rather than reading
`process.env` inline.

### C. Measurement — latency instrumentation

A single small helper emits one structured JSON log line per timing event
(level `info`, a stable `event` field so they're greppable and parseable):

- **`wake_latency`** — ms from inbound message enqueue (wake) to first outbound
  delivery for that session. The number the user perceives as "lag."
- **`poll_loop`** — duration of each `pollActive` / `pollSweep` tick and the
  number of sessions fanned out.
- **`slot_wait`** — emitted when a due message cannot wake a container because
  all `MAX_CONCURRENT_CONTAINERS` slots are busy, including how long it waited.

Always-on, cheap, no new dependency. Lines land in `logs/nanoclaw.log`.

### D. Dashboard install + metric wiring

Run the `/add-dashboard` skill: `pnpm install @nanoco/nanoclaw-dashboard`, copy
the pusher + its two tests into `src/`, wire the colocated `startDashboard()`
block into `main()` in `src/index.ts`, set `DASHBOARD_SECRET` / `DASHBOARD_PORT`,
build, run the skill's tests, restart, smoke-check `http://localhost:3100`.

**Constraint (honest):** the dashboard is a published npm package with fixed
pages (Overview, Agent Groups, Sessions, Channels, Messages, Users, Logs). A
bespoke "Performance" tab cannot be added to it. So the latency data from (C)
surfaces two ways:

1. The structured timing log lines stream live into the dashboard's existing
   **Logs** page (the pusher already tails `logs/nanoclaw.log`).
2. A `performance` block is added to the pusher's snapshot
   (`collectSnapshot()` in `dashboard-pusher.ts`) — recent rolling aggregates
   (e.g. p50/p95 `wake_latency`, last poll-loop durations, current slot
   saturation). Present in the `/api/ingest` payload and `/api/overview`
   response even if the package UI does not yet render a dedicated widget.

The `performance` aggregates are computed from an in-memory ring buffer the (C)
helper maintains (last N events), so the pusher does no extra disk I/O.

### E. Vestigial file cleanup

`git rm groups/global/CLAUDE.md groups/main/CLAUDE.md` — both are stock v1
defaults already removed from disk by `migrateGroupsToClaudeLocal()`
(`src/claude-md-compose.ts:152`). No custom content. The live owner agent is
`groups/dm-with-moe/` and is unaffected.

---

## Testing

- **Delivery parallelism:** unit test asserting `pollActive` fans out concurrently
  (e.g. two slow sessions complete in ~max, not ~sum) and that the
  `inflightDeliveries` guard still blocks same-session re-entry.
- **Interval config:** unit test that env overrides are read and defaults hold
  when unset.
- **Instrumentation:** unit test that the helper emits the expected `event`
  shape and that the ring-buffer aggregates compute correctly.
- **Dashboard:** the skill's shipped `dashboard-pusher.test.ts` and
  `dashboard-wiring.test.ts` (extended to cover the `performance` block), plus
  `pnpm run build` as the dependency guard.
- Full `pnpm test` green before commit.

## Rollout / Deferral

Non-disruptive now (no effect on running containers): all source edits,
`pnpm install`, `pnpm run build`, tests, the `git rm`, and committing.

Deferred until the user's in-flight agents finish (require a restart and/or
Docker change), handed off as a checklist:

1. Raise Docker Desktop VM memory to ≥40 GB (Docker restart).
2. Apply the tuned `.env` values.
3. Restart the NanoClaw service to pick up new env + new build.
4. Smoke-check the dashboard and confirm timing lines appear.

## Risks

- **Adapter rate limits under parallel delivery:** fanning out delivery could
  burst a channel adapter (e.g. Telegram). Acceptable — the sequential version
  had no rate-limiting either, and per-session in-flight is still serialized.
  Revisit only if a provider 429s.
- **Memory oversubscription on Docker Desktop:** mitigated by the VM-allocation
  check in (A).
- **Dashboard package may not render `performance`:** mitigated — Logs page
  always shows the raw timing lines regardless.

## Commit

Single logical change set committed to `main` on the user's fork. No AI
attribution / co-author trailer. No secrets: `.env` stays untracked; the
generated dashboard secret lives only in `.env`.
