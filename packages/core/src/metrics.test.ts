import { describe, expect, it } from 'vitest';
import { holdValue, netVsHold } from './metrics';

describe('net vs hold', () => {
  it('values the entry amounts at current prices', () => {
    expect(holdValue(10, 2000, 150, 1)).toBe(3500);
  });

  it('is zero when position plus fees equals holding', () => {
    expect(netVsHold(3400, 100, 3500)).toBeCloseTo(0);
  });

  it('counts claimed fees toward the result', () => {
    expect(netVsHold(3500, 238, 3500)).toBeCloseTo(0.068);
  });

  it('goes negative when impermanent loss beats fees', () => {
    expect(netVsHold(3200, 50, 3500)).toBeCloseTo(-0.0714, 4);
  });

  it('rejects a zero hold value', () => {
    expect(() => netVsHold(1, 0, 0)).toThrow(RangeError);
  });
});
