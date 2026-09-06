import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSpec, type Document } from '../../src/spec/load.ts';
import { mount, type MockServer } from '../../src/server/mount.ts';
import { BUILT_IN } from '../../src/scenarios/load.ts';

// fileURLToPath, not `.pathname`: a path containing a space comes back
// percent-encoded from `.pathname` and fails to open.
const SPEC = fileURLToPath(new URL('../../fixtures/specs/bookstore.yaml', import.meta.url));
let document: Document;

interface Book {
  id: number;
  title: string;
  status: string;
  publishedAt: string;
}

/**
 * supertest types `response.body` as `any`, which turns every assertion into an
 * unchecked property access. One cast, named, beats thirty implicit ones.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the parameter is the point: it names what the caller expects the body to be
function body<T>(response: { body: unknown }): T {
  return response.body as T;
}

beforeAll(async () => {
  document = await loadSpec(SPEC);
});

function server(overrides: Partial<Parameters<typeof mount>[0]> = {}): MockServer {
  return mount({ document, seed: 42, ...overrides });
}

describe('serving a spec', () => {
  it('seeds the number of items x-mock-count asks for', () => {
    const { store } = server();
    // The count is on the array inside the envelope, not on the envelope.
    // Reading it off the response schema ignored it in every paginated spec.
    expect(store.size('books')).toBe(8);
    expect(store.size('authors')).toBe(3);
  });

  it('gives seeded items ids a person can type', async () => {
    const { app } = server();
    const response = await request(app).get('/books/1').expect(200);
    expect(response.body).toMatchObject({ id: 1 });
  });

  it('returns the envelope the schema declares, with the unpaged total', async () => {
    const { app } = server();
    const response = await request(app).get('/books?limit=2').expect(200);

    expect(body<{ data: Book[] }>(response).data).toHaveLength(2);
    expect(body<{ total: number }>(response).total).toBe(8);
  });

  it('returns a bare array where the schema declares one', async () => {
    const { app } = server();
    const response = await request(app).get('/authors').expect(200);
    expect(Array.isArray(body<unknown[]>(response))).toBe(true);
  });

  it('serves a singleton path as the object it declares, not an empty list', async () => {
    const { app } = server();
    // `/health` looks exactly like a collection to a path-shape heuristic.
    const response = await request(app).get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('resolves x-mock-relation against real ids from the other collection', async () => {
    const { app, store } = server();
    const response = await request(app).get('/books').expect(200);
    const authorIds = store.ids('authors');

    for (const book of body<{ data: { authorId: number }[] }>(response).data) {
      expect(authorIds).toContain(book.authorId);
    }
  });

  it('produces byte-identical data for the same seed', async () => {
    const first = await request(server().app).get('/books');
    const second = await request(server().app).get('/books');
    expect(first.body).toEqual(second.body);
  });

  it('produces different data for a different seed', async () => {
    const first = await request(server({ seed: 1 }).app).get('/books');
    const second = await request(server({ seed: 2 }).app).get('/books');
    expect(first.body).not.toEqual(second.body);
  });

  it('starts with no warnings on a well-formed spec', () => {
    expect(server().warnings).toEqual([]);
  });
});

describe('CRUD semantics', () => {
  it('lists back what was just created', async () => {
    const { app } = server();
    const created = await request(app)
      .post('/books')
      .send({ title: 'Written during the test', status: 'draft' })
      .expect(201);

    // The sequence most mocks get wrong, and the one most frontend bugs live
    // in: create, then list.
    const list = await request(app).get('/books').expect(200);
    expect(body<{ data: Book[] }>(list).data.map((book) => book.id)).toContain(
      body<Book>(created).id,
    );
  });

  it('returns a complete resource from a create, not just the request body', async () => {
    const { app, warnings } = server({ strictResponses: true });
    const created = await request(app).post('/books').send({ title: 'Partial' }).expect(201);

    // A real API fills in the fields the client did not send. Echoing the body
    // back returns an object the response schema rejects, which teaches the
    // client a shape the API will never produce.
    expect(body<Book>(created)).toMatchObject({ title: 'Partial' });
    expect(body<Book>(created).publishedAt).toBeDefined();
    expect(body<Book>(created).status).toBeDefined();
    expect(warnings).toEqual([]);
  });

  it('patches without losing the fields that were not sent', async () => {
    const { app } = server();
    const before = await request(app).get('/books/2').expect(200);
    await request(app).patch('/books/2').send({ title: 'Renamed' }).expect(200);

    const after = await request(app).get('/books/2').expect(200);
    expect(body<Book>(after).title).toBe('Renamed');
    expect(body<Book>(after).publishedAt).toBe(body<Book>(before).publishedAt);
  });

  it('deletes, and then reports the item as gone', async () => {
    const { app } = server();
    await request(app).delete('/books/3').expect(204);
    await request(app).get('/books/3').expect(404);
  });

  it('404s an unknown id instead of inventing one', async () => {
    const { app } = server();
    await request(app).get('/books/9999').expect(404);
    await request(app).patch('/books/9999').send({ title: 'Ghost' }).expect(404);
    await request(app).delete('/books/9999').expect(404);
  });

  it('pages with limit and offset', async () => {
    const { app } = server();
    const page = await request(app).get('/books?limit=3&offset=5').expect(200);
    expect(body<{ data: Book[] }>(page).data).toHaveLength(3);
    expect(body<{ total: number }>(page).total).toBe(8);
  });
});

describe('response validation', () => {
  it('serves bodies its own schema accepts', async () => {
    const { app, warnings } = server({ strictResponses: true });

    for (const path of ['/books', '/books/1', '/authors', '/health']) {
      await request(app).get(path).expect(200);
    }
    // Data generated from a schema that then fails the same schema is a bug in
    // this tool, which is why it is asserted rather than assumed.
    expect(warnings).toEqual([]);
  });
});

describe('scenarios', () => {
  it('fails every request during an outage', async () => {
    const { app } = server({ scenario: { name: 'outage', errors: [{ rate: 1, status: 500 }] } });

    for (let i = 0; i < 5; i += 1) {
      await request(app).get('/books').expect(500);
    }
  });

  /**
   * The built-in `outage` scenario asks for 503, and `/books` declares only
   * 200 and 500 — so the request comes back as 500, and the substitution is
   * reported rather than left to be puzzled over.
   */
  it('substitutes a declared status and says that it did', async () => {
    const events: { status?: number; substitutedFor?: number }[] = [];
    const outage = BUILT_IN.outage;
    if (!outage) throw new Error('the outage scenario is missing');
    const { app } = server({ scenario: outage, onInjected: (event) => events.push(event) });

    await request(app).get('/books').expect(500);
    expect(events.at(-1)).toMatchObject({ status: 500, substitutedFor: 503 });
  });

  it('injects only statuses the route declares', async () => {
    // The route declares 200 and 500, never 418. Injecting an undeclared
    // status would teach the client to handle a response the real API cannot
    // return.
    const { app } = server({ scenario: { name: 'teapot', errors: [{ rate: 1, status: 418 }] } });
    const response = await request(app).get('/books');
    expect(response.status).toBe(500);
  });

  it('rate limits with a Retry-After once the window is spent', async () => {
    const { app } = server({
      scenario: { name: 'tight', rateLimit: { requests: 3, windowMs: 60_000 } },
    });

    for (let i = 0; i < 3; i += 1) await request(app).get('/books').expect(200);

    const limited = await request(app).get('/books').expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('adds latency without changing the body', async () => {
    const { app } = server({ scenario: { name: 'slow', latency: { minMs: 40, maxMs: 60 } } });

    const started = Date.now();
    const response = await request(app).get('/books').expect(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(body<{ data: Book[] }>(response).data).toHaveLength(8);
  });

  it('reports what it injected', async () => {
    const events: { kind: string }[] = [];
    const outage = BUILT_IN.outage;
    if (!outage) throw new Error('the outage scenario is missing');

    const { app } = server({ scenario: outage, onInjected: (event) => events.push(event) });

    await request(app).get('/books');
    expect(events.map((event) => event.kind)).toContain('error');
  });

  it('injects the same failures for the same seed', async () => {
    const scenario = { name: 'flaky', errors: [{ rate: 0.5, status: 500 }] };
    const statuses = async (seed: number): Promise<number[]> => {
      const { app } = server({ seed, scenario });
      const results: number[] = [];
      for (let i = 0; i < 10; i += 1) results.push((await request(app).get('/books')).status);
      return results;
    };

    // An unreproducible failure in a mock is a bug report nobody can act on.
    expect(await statuses(42)).toEqual(await statuses(42));
  });
});
