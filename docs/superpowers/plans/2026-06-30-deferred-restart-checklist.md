# Deferred restart checklist — run when in-flight agents finish

These steps disrupt running containers, so they were intentionally NOT run
during implementation. Run them yourself once your agents are idle.

1. **Docker Desktop VM memory — confirm ≥ 24 GB** (Docker Desktop → Settings →
   Resources → Memory; already set to 24 GB). Sizing: `CONTAINER_MEMORY_LIMIT=2g`
   × `MAX_CONCURRENT_CONTAINERS=10` = 20 GB worst case, leaving ~4 GB VM
   headroom. The cap is enforced as a HARD cap (synchronous slot reservation in
   `wakeContainer`), so the 20 GB worst case cannot be overshot by concurrent
   cross-channel arrivals. Note `2g` is a per-container ceiling — if memory-heavy
   agents (browser/screenshot, large builds) hit OOM, either lower
   `MAX_CONCURRENT_CONTAINERS` and raise `CONTAINER_MEMORY_LIMIT` (e.g. 5 × 4g),
   or raise the Docker VM and `CONTAINER_MEMORY_LIMIT` together. Changing the VM
   size requires a Docker restart.

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
