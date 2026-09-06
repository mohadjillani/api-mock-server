import { describe, expect, it } from 'vitest';
import { delayFor, errorFor, seededRandom } from '../../src/server/chaos.ts';
import { BUILT_IN, ScenarioError, validateScenario } from '../../src/scenarios/load.ts';

describe('seededRandom', () => {
  it('produces the same sequence for the same seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces a different sequence for a different seed', () => {
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });

  it('stays within [0, 1)', () => {
    const random = seededRandom(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('errorFor', () => {
  const scenario = {
    name: 'test',
    errors: [
      { rate: 0.1, status: 500 },
      { rate: 0.1, status: 503 },
    ],
  };

  it('injects nothing below the combined rate', () => {
    expect(errorFor(scenario, () => 0.5)).toBeUndefined();
  });

  it('picks the band the roll lands in', () => {
    expect(errorFor(scenario, () => 0.05)).toBe(500);
    expect(errorFor(scenario, () => 0.15)).toBe(503);
  });

  it('injects on every request at rate 1', () => {
    const always = { name: 'outage', errors: [{ rate: 1, status: 503 }] };
    const random = seededRandom(3);
    for (let i = 0; i < 50; i += 1) expect(errorFor(always, random)).toBe(503);
  });

  it('injects nothing when a scenario declares no errors', () => {
    expect(errorFor({ name: 'happy' }, () => 0)).toBeUndefined();
  });
});

describe('delayFor', () => {
  it('is zero without a latency block', () => {
    expect(delayFor({ name: 'happy' }, () => 0.5)).toBe(0);
  });

  it('stays inside the configured range', () => {
    const scenario = { name: 'slow', latency: { minMs: 100, maxMs: 200 } };
    expect(delayFor(scenario, () => 0)).toBe(100);
    expect(delayFor(scenario, () => 0.999)).toBeLessThanOrEqual(200);
  });

  it('takes the slow path when the roll falls under slowRate', () => {
    const scenario = {
      name: 'tail',
      latency: { minMs: 10, maxMs: 20, slowRate: 0.05, slowMs: 3000 },
    };
    expect(delayFor(scenario, () => 0.01)).toBe(3000);
    expect(delayFor(scenario, () => 0.5)).toBeLessThanOrEqual(20);
  });
});

describe('validateScenario', () => {
  it('accepts every built-in', () => {
    for (const scenario of Object.values(BUILT_IN)) {
      expect(() => {
        validateScenario(scenario);
      }).not.toThrow();
    }
  });

  it('refuses a rate outside 0 to 1', () => {
    expect(() => {
      validateScenario({ name: 'x', errors: [{ rate: 1.5, status: 500 }] });
    }).toThrow(ScenarioError);
  });

  /**
   * The check that matters most: rates summing past 1 mean the later bands can
   * never fire, and the scenario silently does less than it says.
   */
  it('refuses rates that sum past every request', () => {
    expect(() => {
      validateScenario({
        name: 'x',
        errors: [
          { rate: 0.7, status: 500 },
          { rate: 0.7, status: 503 },
        ],
      });
    }).toThrow(/sum to 1.40/);
  });

  it('refuses a status that is not an HTTP status', () => {
    expect(() => {
      validateScenario({ name: 'x', errors: [{ rate: 0.1, status: 999 }] });
    }).toThrow(/not an HTTP status/);
  });

  it('refuses an inverted latency range', () => {
    expect(() => {
      validateScenario({ name: 'x', latency: { minMs: 500, maxMs: 100 } });
    }).toThrow(/greater than maxMs/);
  });

  it('refuses a scenario with no name', () => {
    expect(() => {
      validateScenario({ name: '' });
    }).toThrow(/needs a name/);
  });

  it('refuses a truncate rate outside 0 to 1', () => {
    expect(() => {
      validateScenario({ name: 'x', truncateRate: 2 });
    }).toThrow(/truncateRate/);
  });
});
