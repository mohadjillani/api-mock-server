# 1. Generate responses from the spec, then validate them against it

Status: accepted

## Context

A mock's job is to let a client be built before the server exists. Its failure
mode is drift: the mock returns a shape the real API never will, the frontend
is built against it, and the mismatch surfaces during integration — the most
expensive moment to find it.

Hand-written fixtures drift immediately, because nothing connects them to the
spec. Generated responses drift more slowly, through bugs in the generator.

## Decision

Generate every response from the response schema, then validate the generated
body against that same schema before sending it. `--strict` turns a violation
into a 500 instead of a logged warning.

## Consequences

A failure here is a bug in this tool, by construction — the data came from the
schema that just rejected it. That is exactly why it is asserted in the test
suite rather than assumed: the integration tests serve every route with
`strictResponses` on and require zero warnings.

It caught a real one. A POST that echoed the request body back returned an
object missing every field the client had not sent, which the response schema
rejects. A real API fills those in; the mock now generates a complete resource
and merges the request over it.

The cost is a JSON Schema validator in the request path and the OpenAPI-to-JSON
Schema differences it has to bridge: `nullable: true` in 3.0 becomes a type
union, and `example` is dropped. Both are handled in one place.

Validation does not check requests. A mock that rejected malformed input would
be a second implementation of the API's validation, with its own bugs, and the
value of catching those bugs before the real server exists is low.
