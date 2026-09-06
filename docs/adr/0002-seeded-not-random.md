# 2. Seed everything, including the failures

Status: accepted

## Context

A mock generates data and, in a chaos scenario, failures. The obvious source
for both is `Math.random()`.

That makes a failing test unreproducible. A developer sees a broken screen,
reloads, gets different data, and the bug is gone. A CI run fails once in
twenty and nobody can say which request was the one that failed.

## Decision

One seed drives both. `--seed 42` fixes the generated data and the chaos
sequence: the same spec, the same seed and the same request order produce the
same bytes and the same injected failures.

Faker is seeded per run. Chaos uses a small deterministic PRNG (mulberry32)
rather than `Math.random`, because Node has no seedable `Math.random` and
pulling in a dependency for one 32-bit integer is not a trade worth making.

## Consequences

`--seed 42 --scenario degraded` is a reproducible bad day. A screenshot test
can run against it. A bug report can name a seed.

Seeded ids are made typeable — 1, 2, 3 rather than a generated five-digit
integer — so `GET /books/1` works and every README example is correct. String
ids keep the format their schema declares, because a UUID that is not a UUID
breaks clients that parse them.

Two costs. Data does not vary across restarts, so a bug that only appears with
different-shaped data is not going to appear on its own; changing the seed is
the intended answer. And the sequence depends on request _order_, so a test
that fires requests in parallel gets a different assignment of failures than
one that fires them in sequence. That is a property of any seeded stream and it
is worth knowing before writing an assertion on which request failed.
