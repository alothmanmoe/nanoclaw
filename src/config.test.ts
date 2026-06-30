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
