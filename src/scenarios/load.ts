import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

export interface ErrorInjection {
  /** Fraction of requests, 0–1. */
  rate: number;
  /** Status to return. Must be one the spec declares for the route. */
  status: number;
}

export interface Scenario {
  name: string;
  description?: string;
  latency?: {
    /** Milliseconds added to every response. */
    minMs: number;
    maxMs: number;
    /** Fraction of requests that get the slow path instead. 0 disables it. */
    slowRate?: number;
    slowMs?: number;
  };
  errors?: ErrorInjection[];
  rateLimit?: {
    requests: number;
    windowMs: number;
  };
  /** Fraction of responses cut off mid-body, to exercise client parsing. */
  truncateRate?: number;
}

export class ScenarioError extends Error {}

/**
 * Validates a scenario before the server starts.
 *
 * A scenario is the part a developer edits most and the part with no schema
 * behind it, so every field is checked here. A typo that silently disables
 * chaos produces a green test run that proves nothing, which is the worst
 * possible failure for a tool whose job is simulating bad days.
 */
export function validateScenario(scenario: Scenario): void {
  if (!scenario.name) throw new ScenarioError('a scenario needs a name');

  for (const injection of scenario.errors ?? []) {
    if (injection.rate < 0 || injection.rate > 1) {
      throw new ScenarioError(`error rate must be between 0 and 1, got ${String(injection.rate)}`);
    }
    if (!Number.isInteger(injection.status) || injection.status < 100 || injection.status > 599) {
      throw new ScenarioError(`${String(injection.status)} is not an HTTP status code`);
    }
  }

  const total = (scenario.errors ?? []).reduce((sum, injection) => sum + injection.rate, 0);
  if (total > 1) {
    throw new ScenarioError(
      `error rates sum to ${total.toFixed(2)}, which is more than every request`,
    );
  }

  if (scenario.latency && scenario.latency.minMs > scenario.latency.maxMs) {
    throw new ScenarioError('latency minMs is greater than maxMs');
  }

  if (
    scenario.truncateRate !== undefined &&
    (scenario.truncateRate < 0 || scenario.truncateRate > 1)
  ) {
    throw new ScenarioError('truncateRate must be between 0 and 1');
  }

  if (scenario.rateLimit && scenario.rateLimit.requests < 1) {
    throw new ScenarioError('rateLimit.requests must be at least 1');
  }
}

export const BUILT_IN: Record<string, Scenario> = {
  happy: {
    name: 'happy',
    description: 'Everything works. The default, and the one that proves nothing.',
  },
  degraded: {
    name: 'degraded',
    description: 'A slow, occasionally failing, rate-limited dependency — the realistic bad day.',
    latency: { minMs: 80, maxMs: 400, slowRate: 0.05, slowMs: 3_000 },
    errors: [
      { rate: 0.05, status: 500 },
      { rate: 0.02, status: 503 },
    ],
    rateLimit: { requests: 60, windowMs: 60_000 },
  },
  outage: {
    name: 'outage',
    description: 'The dependency is down. Every request fails, slowly.',
    latency: { minMs: 1_000, maxMs: 2_000 },
    errors: [{ rate: 1, status: 503 }],
  },
};

export async function loadScenario(nameOrPath: string): Promise<Scenario> {
  const builtIn = BUILT_IN[nameOrPath];
  if (builtIn) return builtIn;

  let parsed: unknown;
  try {
    parsed = parse(await readFile(nameOrPath, 'utf8'));
  } catch (error) {
    throw new ScenarioError(
      `no built-in scenario called "${nameOrPath}" (${Object.keys(BUILT_IN).join(', ')}), and it could not be read as a file: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // The file's own name wins; the path is only a fallback for a file that
  // did not bother to name itself.
  const fromFile = parsed as Partial<Scenario>;
  const scenario: Scenario = { ...fromFile, name: fromFile.name ?? nameOrPath };
  validateScenario(scenario);
  return scenario;
}
