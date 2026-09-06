# 3. Infer collections from path shape, and fall back honestly

Status: accepted

## Context

The difference between a useful mock and a canned-response server is state: a
client that creates a record and then lists records must see the one it just
created. Most frontend bugs a mock is used to find live in exactly that
sequence.

OpenAPI does not say which paths are collections. It describes operations, not
resources.

## Decision

Infer it from the path: the last segment that is not a parameter is the
collection, and a trailing parameter names the item. `/users` and `/users/{id}`
are one collection; `/users/{id}/posts` is another. Back each collection with
an in-memory store implementing real CRUD.

Where the inference does not apply — an RPC-shaped path, or a collection
nothing could be seeded into — generate a response from the schema per request,
with no state behind it.

## Consequences

Most REST-shaped specs get working CRUD with no configuration.

The fallback is what makes it safe to be wrong. `/health` looks exactly like a
collection to a path-shape heuristic, and serving it as one returned an empty
array where the spec declares an object — found by the tool's own tests. The
rule now requires that something was actually seeded into the collection, which
distinguishes a resource from a singleton without a second heuristic.

`apimock validate` prints which operations get CRUD and which are generated per
request, so the inference is visible before anyone builds on it rather than
being discovered by a surprising response.

State is per-process and in memory. Restarting resets it, which is a feature
for tests and a limitation for a long-running shared mock. Persistence would
mean a store, a migration story and a reset endpoint — a different tool.
