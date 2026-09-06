import type { NextFunction, Request, Response } from 'express';
import type { Scenario } from '../scenarios/load.ts';

export interface ChaosOptions {
  scenario: Scenario;
  /** Deterministic when seeded, so a failing run can be reproduced exactly. */
  random: () => number;
  /** Statuses the spec declares for a route, so injection stays in contract. */
  declaredStatuses?: (req: Request) => number[];
  onInjected?: (event: {
    kind: string;
    status?: number;
    delayMs?: number;
    /** Set when the scenario asked for a status the route does not declare. */
    substitutedFor?: number;
  }) => void;
}

/**
 * Injects the failures a real dependency produces.
 *
 * Seeded rather than random. `Math.random()` makes a failure that a developer
 * hit once unreproducible, and an unreproducible failure in a mock is a bug
 * report nobody can act on. With a seed, `--seed 42 --scenario degraded` fails
 * in the same places every time.
 */
export function chaosMiddleware(options: ChaosOptions) {
  const { scenario, random } = options;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return async function chaos(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (scenario.rateLimit) {
      const now = Date.now();
      const bucket = buckets.get(req.ip ?? 'anonymous');

      if (!bucket || bucket.resetAt <= now) {
        buckets.set(req.ip ?? 'anonymous', {
          count: 1,
          resetAt: now + scenario.rateLimit.windowMs,
        });
      } else {
        bucket.count += 1;
        if (bucket.count > scenario.rateLimit.requests) {
          const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
          res.setHeader('Retry-After', retryAfter);
          res.setHeader('RateLimit-Limit', scenario.rateLimit.requests);
          res.setHeader('RateLimit-Remaining', 0);
          options.onInjected?.({ kind: 'rate-limit', status: 429 });
          res.status(429).json({ error: 'rate_limited', retryAfterSeconds: retryAfter });
          return;
        }
      }
    }

    const delay = delayFor(scenario, random);
    if (delay > 0) {
      options.onInjected?.({ kind: 'latency', delayMs: delay });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const injected = errorFor(scenario, random);
    if (injected !== undefined) {
      const declared = options.declaredStatuses?.(req) ?? [];
      // Injecting a status the spec never declares would teach the client to
      // handle a response the real API cannot return. If the route does not
      // declare it, the nearest declared error is used instead.
      const status = declared.includes(injected)
        ? injected
        : (declared.find((code) => code >= 400) ?? injected);

      // Reported rather than silent: a scenario configured for 503 that
      // delivers 500 is confusing until you know why, and the substitution is
      // usually a sign the spec is missing a response the real API returns.
      options.onInjected?.({
        kind: 'error',
        status,
        ...(status === injected ? {} : { substitutedFor: injected }),
      });
      res.status(status).json({ error: 'injected_failure', scenario: scenario.name, status });
      return;
    }

    if (scenario.truncateRate && random() < scenario.truncateRate) {
      options.onInjected?.({ kind: 'truncated' });
      // Headers claim more than the body delivers: the client sees a socket
      // that closes mid-JSON, which is what a dying upstream actually does and
      // what almost no test suite covers.
      res.setHeader('content-type', 'application/json');
      res.write('{"partial": true, "items": [{"id"');
      res.destroy();
      return;
    }

    next();
  };
}

export function delayFor(scenario: Scenario, random: () => number): number {
  const latency = scenario.latency;
  if (!latency) return 0;

  if (latency.slowRate && latency.slowMs && random() < latency.slowRate) return latency.slowMs;
  return Math.round(latency.minMs + random() * (latency.maxMs - latency.minMs));
}

export function errorFor(scenario: Scenario, random: () => number): number | undefined {
  const roll = random();
  let cumulative = 0;

  for (const injection of scenario.errors ?? []) {
    cumulative += injection.rate;
    if (roll < cumulative) return injection.status;
  }
  return undefined;
}

/**
 * A small deterministic PRNG (mulberry32).
 *
 * Node has no seedable `Math.random`, and pulling in a dependency to produce
 * one 32-bit integer is not a trade worth making.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
