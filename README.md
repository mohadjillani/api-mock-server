# api-mock-server

[![CI](https://github.com/mohadjillani/api-mock-server/actions/workflows/ci.yml/badge.svg)](https://github.com/mohadjillani/api-mock-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Point it at an OpenAPI 3 document and it serves the API — with seeded data that
does not change between runs, CRUD that actually remembers what you created,
responses checked against the schema they came from, and scenarios for the days
the real service is slow, flaky and rate-limited.

```bash
npx @mohadjillani/api-mock-server serve openapi.yaml
```

```
Bookstore 1.0.0 → http://127.0.0.1:4010
  7 routes, scenario "happy", seed 42
  /authors: 3 seeded
  /books: 8 seeded
```

## Why not a canned-response mock

Because the bug is almost never in the happy path. It is in the sequence — create
a record, then list records — and in the bad day: a 3-second tail latency, a
sporadic 500, a 429 with a `Retry-After` nobody honours, a response that stops
mid-JSON because the upstream died.

Three things follow from that, and they are what this tool is:

**State.** `/books` and `/books/{id}` are recognised as one collection and backed
by a store. POST assigns an id and the next GET returns it. PATCH merges, PUT
replaces, DELETE 404s the second time.

**Determinism.** One seed drives the data _and_ the failures. `--seed 42
--scenario degraded` is a reproducible bad day: the same items, the same
requests failing. A mock whose data changes on reload makes a failing test
unreproducible, and a bug report nobody can act on.

**The contract.** Every response is validated against the schema it was generated
from before it is sent. A mock that drifts from the spec is worse than no mock:
the client gets built against a shape the real API will never produce.

## Chaos

```bash
apimock serve api.yaml --scenario degraded --seed 7
```

```
  chaos: latency +3000ms
  chaos: error 500 (scenario asked for 503, which this route does not declare)
  chaos: latency +304ms
```

That second line is the tool refusing to lie. `degraded` asks for a 503, the
route declares only 200 and 500, and injecting an undeclared status would teach
the client to handle a response the real API cannot return. It substitutes the
nearest declared error and says so — which usually means the spec is missing a
response the real API does return.

Built in: `happy`, `degraded` (latency with a tail, 5% 500s, 2% 503s, 60/min),
`outage`. Or write your own:

```yaml
name: black-friday
latency: { minMs: 200, maxMs: 900, slowRate: 0.1, slowMs: 8000 }
errors:
  - { rate: 0.08, status: 500 }
rateLimit: { requests: 100, windowMs: 60000 }
truncateRate: 0.02 # responses cut off mid-body
```

Every field is validated at load — rates in range, rates summing to no more
than 1, statuses that are statuses. A scenario that silently does nothing
because a rate was `50` instead of `0.5` produces a green test run that proves
nothing, which is the worst outcome for a tool whose job is simulating failure.

Full reference: [docs/scenarios.md](docs/scenarios.md).

## Making the data usable

Formats carry most of it — `date-time`, `email`, `uuid`, `uri` and the rest all
generate something that looks right, and `enum`, `minimum` and `maxLength` are
respected. Four vendor extensions cover what a schema cannot say:

```yaml
data:
  type: array
  x-mock-count: 40 # how many to seed
  items:
    type: object
    properties:
      title: { type: string, x-mock-faker: commerce.productName }
      status: { type: string, x-mock-value: active }
      authorId: { type: integer, x-mock-relation: authors } # a real author id
```

`x-mock-relation` means collections are seeded in dependency order, so authors
exist before the books referencing them regardless of the order the paths
appear in the spec. Reference cycles fall back to declaration order with a
warning.

Details and defaults: [docs/extensions.md](docs/extensions.md).

## Commands

```bash
apimock serve <spec>       # --port --seed --scenario --strict --quiet
apimock validate <spec>    # what would be served, and what would not
apimock scenarios          # the built-ins and their parameters
```

`validate` is the one to run first:

```
Bookstore 1.0.0: valid OpenAPI 3.0.3
  7 operations
  3 collections: books, authors, health
```

It also lists operations that are **not** resource-shaped, and ones that declare
no response schema and will return `{}`. Knowing which half of your spec gets
real CRUD before building on it beats discovering it from a surprising
response.

## Using it as a library

```ts
import { loadSpec, mount } from '@mohadjillani/api-mock-server';

const { app, store } = mount({
  document: await loadSpec('openapi.yaml'),
  seed: 42,
  strictResponses: true,
});

store.seed('books', [{ id: 1, title: 'A known fixture' }]);
app.listen(4010);
```

The store is exposed on purpose: seeding a known fixture for one test and
letting the generator handle everything else is usually what you want.

## Limits

**State is in memory and per process.** Restarting resets it. That is right for
tests and wrong for a long-running shared mock — persistence would need a
store, a migration story and a reset endpoint, which is a different tool.

**Collections are inferred from path shape.** The last non-parameter segment is
the collection. That covers REST-shaped specs and not RPC-shaped ones, where
routes still serve generated responses with no state behind them. `validate`
prints which is which; [ADR 3](docs/adr/0003-crud-from-path-shape.md) covers the
inference and where it was wrong.

**`pattern` is not honoured.** Matching an arbitrary regex needs a
regex-to-string engine. The tool warns when it meets one rather than generating
a value that fails the spec's own constraint.

**Requests are not validated.** A mock that rejected malformed input would be a
second implementation of the API's validation, with its own bugs.

**No record and replay.** Proxying a real API and serving the responses back is
a genuinely useful mode and is not implemented.

**Not a contract-testing tool.** It checks that this mock matches this spec. It
says nothing about whether the real service does — that needs the real service.

## Decisions

- [1. Generate responses from the spec, then validate them against it](docs/adr/0001-generate-and-validate-from-one-schema.md)
- [2. Seed everything, including the failures](docs/adr/0002-seeded-not-random.md)
- [3. Infer collections from path shape, and fall back honestly](docs/adr/0003-crud-from-path-shape.md)

## License

MIT
