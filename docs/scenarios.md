# Scenarios

A scenario describes a bad day. The point of a mock is not that the happy path
works — it is that the client handles a slow, flaky, rate-limited dependency,
and there is no other cheap way to test that.

```bash
apimock serve api.yaml --scenario degraded
apimock serve api.yaml --scenario ./scenarios/black-friday.yaml
```

## Built in

| name       | what it does                                                                         |
| ---------- | ------------------------------------------------------------------------------------ |
| `happy`    | Nothing injected. The default, and the one that proves nothing.                      |
| `degraded` | 80–400 ms latency with a 5% three-second tail, 5% 500s, 2% 503s, 60 requests/minute. |
| `outage`   | Every request fails, slowly: 1–2 s then a 503.                                       |

`apimock scenarios` prints them with their parameters.

## Writing one

```yaml
name: black-friday
description: Ten times the traffic and a database that cannot keep up.

latency:
  minMs: 200
  maxMs: 900
  # The tail is what breaks clients: a p50 nobody notices and a p99 past every
  # timeout in the stack.
  slowRate: 0.1
  slowMs: 8000

errors:
  - { rate: 0.08, status: 500 }
  - { rate: 0.04, status: 503 }

rateLimit:
  requests: 100
  windowMs: 60000

# A fraction of responses cut off mid-body, to exercise the client's parsing.
truncateRate: 0.02
```

Every field is validated at load. A scenario that silently does nothing —
because a rate was 50 instead of 0.5, or a status was mistyped — produces a
green test run that proves nothing, which is the worst possible outcome for a
tool whose job is simulating failure.

The checks: rates between 0 and 1; rates summing to no more than 1 (past that,
the later bands could never fire); statuses that are HTTP statuses;
`minMs <= maxMs`.

## Determinism

Chaos is seeded, not random. `--seed 42 --scenario degraded` injects the same
failures in the same places on every run.

That is the difference between a bug report someone can act on and "it failed
once, I refreshed, it was fine". `Math.random()` makes the second one the only
kind you get.

## Injection stays inside the contract

A scenario asking for 503 on a route that declares only 200 and 500 gets 500,
and the substitution is reported:

```
chaos: error 500 (scenario asked for 503, which this route does not declare)
```

Injecting an undeclared status would teach the client to handle a response the
real API cannot return — and hide the more interesting fact, which is usually
that the spec is missing a response the real API _does_ return.

## Rate limiting

The rate limiter returns 429 with `Retry-After` and the `RateLimit-*` headers,
per client address. It is a simple fixed window, which is enough to make a
client's retry logic run — `rate-limiting-patterns` is the repository about
getting rate limiting itself right.

## Truncation

`truncateRate` writes a partial JSON body and destroys the socket. It is the
one scenario most suites never cover: the client sees a response that starts
correctly and stops mid-object, which is what a dying upstream actually does
and what a `JSON.parse` in a `then` handles very badly.
