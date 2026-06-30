import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  recordEvent,
  markWake,
  markFirstDelivery,
  clearWakeMark,
  getAggregates,
  __resetForTest,
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
    try {
      nowSpy.mockReturnValue(1000);
      markWake('sess-1');
      nowSpy.mockReturnValue(1150);
      markFirstDelivery('sess-1');
      const agg = getAggregates();
      expect(agg.wakeLatencyMs.count).toBe(1);
      expect(agg.wakeLatencyMs.p50).toBe(150);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('markWake is set-if-absent: a second mark does not reset the start time', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1000);
      markWake('sess-q'); // first attempt (e.g. deferred by cap)
      nowSpy.mockReturnValue(1100);
      markWake('sess-q'); // retry attempt — must NOT overwrite
      nowSpy.mockReturnValue(1300);
      markFirstDelivery('sess-q');
      expect(getAggregates().wakeLatencyMs.p50).toBe(300); // 1300 - 1000, includes queue
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('clearWakeMark prevents stale wake_latency when container exits without delivery', () => {
    markWake('sess-stale');
    clearWakeMark('sess-stale');
    // After clearing, markFirstDelivery should be a no-op — no sample recorded.
    markFirstDelivery('sess-stale');
    expect(getAggregates().wakeLatencyMs.count).toBe(0);
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
