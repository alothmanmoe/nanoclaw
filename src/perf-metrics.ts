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
  push({ ...fields, event, t: Date.now() });
  log.info('perf', { event, ...fields });
}

export function markWake(sessionId: string): void {
  // set-if-absent: keep the earliest mark so wake_latency includes any time the
  // session spent queued behind the concurrency cap.
  if (!wakeMarks.has(sessionId)) wakeMarks.set(sessionId, Date.now());
}

export function clearWakeMark(sessionId: string): void {
  wakeMarks.delete(sessionId);
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
