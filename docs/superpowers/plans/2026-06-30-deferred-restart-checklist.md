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
