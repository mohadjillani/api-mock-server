import express, { type Express, type Request } from 'express';
import type { Route } from '../spec/route-table.ts';
import { matcherFor, successResponse } from '../spec/route-table.ts';
import type { Document, Schema } from '../spec/load.ts';
import { buildRouteTable } from '../spec/route-table.ts';
import { createGenerator } from '../generate/schema-to-data.ts';
import { extensionsOf } from '../generate/extensions.ts';
import { MemoryStore, type Item } from '../store/memory-store.ts';
import { createValidator } from './validate-response.ts';
import { chaosMiddleware, seededRandom } from './chaos.ts';
import type { Scenario } from '../scenarios/load.ts';
import { BUILT_IN } from '../scenarios/load.ts';

export interface MountOptions {
  document: Document;
  seed?: number;
  scenario?: Scenario;
  /** Refuse to send a response that does not match the spec. Default: warn. */
  strictResponses?: boolean;
  onWarning?: (message: string) => void;
  onInjected?: (event: {
    kind: string;
    status?: number;
    delayMs?: number;
    substitutedFor?: number;
  }) => void;
}

export interface MockServer {
  app: Express;
  store: MemoryStore;
  routes: Route[];
  warnings: string[];
}

/** `items` lives only on the array branch of the schema union. */
function itemsOf(schema: Schema | undefined): Schema | undefined {
  return (schema as { items?: Schema } | undefined)?.items;
}

/** The array schema itself, whether it is the response or inside an envelope. */
function arrayContainerOf(schema: Schema | undefined): Schema | undefined {
  if (!schema) return undefined;
  if (schema.type === 'array') return schema;

  // The common envelope shape: `{ data: [...] }` or `{ items: [...] }`.
  for (const key of ['data', 'items', 'results']) {
    const property = schema.properties?.[key] as Schema | undefined;
    if (property?.type === 'array') return property;
  }
  return undefined;
}

/**
 * Gives seeded items ids a person can type.
 *
 * A generated integer id is a five-digit random number, which makes every
 * example in a README wrong and every manual `curl` a guessing game. Integer
 * ids become 1..n; string ids keep whatever the schema's format produced,
 * because a UUID that is not a UUID breaks clients that parse them.
 */
export function withPredictableId(item: Item, schema: Schema, index: number): Item {
  const idSchema = schema.properties?.id as Schema | undefined;
  const isNumeric = idSchema?.type === 'integer' || idSchema?.type === 'number';

  if (item.id === undefined || isNumeric) return { ...item, id: index + 1 };
  return item;
}

/**
 * Seeds referenced collections before the ones referencing them.
 *
 * `x-mock-relation: authors` on a book can only draw from real author ids if
 * authors exist first, and route order in the spec has nothing to do with it.
 * A cycle falls back to declaration order with a warning rather than failing:
 * two collections referencing each other is a legitimate spec, and one of them
 * simply gets generated ids.
 */
export function seedOrder(
  seeds: Map<string, { itemSchema: Schema }>,
  warn: (message: string) => void,
): string[] {
  const dependencies = new Map<string, string[]>();
  for (const [collection, seed] of seeds) {
    dependencies.set(
      collection,
      relationsIn(seed.itemSchema).filter((name) => seeds.has(name)),
    );
  }

  const ordered: string[] = [];
  const visiting = new Set<string>();

  const visit = (collection: string): void => {
    if (ordered.includes(collection)) return;
    if (visiting.has(collection)) {
      warn(
        `collections ${[...visiting].join(' → ')} reference each other; seeding in declaration order`,
      );
      return;
    }

    visiting.add(collection);
    for (const dependency of dependencies.get(collection) ?? []) visit(dependency);
    visiting.delete(collection);
    ordered.push(collection);
  };

  for (const collection of seeds.keys()) visit(collection);
  return ordered;
}

function relationsIn(schema: Schema, depth = 0): string[] {
  if (depth > 4) return [];
  const found: string[] = [];

  const relation = extensionsOf(schema).relation;
  if (relation) found.push(relation);

  for (const property of Object.values(schema.properties ?? {})) {
    found.push(...relationsIn(property as Schema, depth + 1));
  }
  const items = itemsOf(schema);
  if (items) found.push(...relationsIn(items, depth + 1));

  return found;
}

export function mount(options: MountOptions): MockServer {
  const seed = options.seed ?? 42;
  const scenario = options.scenario ?? BUILT_IN.happy ?? { name: 'happy' };
  const warnings: string[] = [];

  const warn = (message: string): void => {
    warnings.push(message);
    options.onWarning?.(message);
  };

  const routes = buildRouteTable(options.document);
  const store = new MemoryStore();
  const validator = createValidator();
  const related = new Map<string, unknown[]>();
  const generator = createGenerator({ seed, onWarning: warn, related });

  // Seed each collection once, from the item schema of its list route. Doing
  // it up front rather than per request is what makes GET-then-GET return the
  // same data, which a client caching by id depends on.
  const seeds = new Map<string, { itemSchema: Schema; count: number }>();

  for (const route of routes) {
    if (route.method !== 'get' || !route.collection || route.idParam) continue;
    if (seeds.has(route.collection)) continue;

    const arraySchema = arrayContainerOf(successResponse(route)?.schema);
    const itemSchema = itemsOf(arraySchema);
    if (!arraySchema || !itemSchema) continue;

    seeds.set(route.collection, {
      itemSchema,
      // The count lives on the array, not on the envelope around it. Reading
      // it off the response schema silently ignored every `x-mock-count` in a
      // paginated spec.
      count: extensionsOf(arraySchema).count ?? 5,
    });
  }

  for (const collection of seedOrder(seeds, warn)) {
    const seedSpec = seeds.get(collection);
    if (!seedSpec) continue;

    const items = Array.from({ length: seedSpec.count }, (_unused, index) =>
      withPredictableId(
        generator.generate(seedSpec.itemSchema) as Item,
        seedSpec.itemSchema,
        index,
      ),
    );
    store.seed(collection, items);
    // Relations resolve against what is already seeded, which is why the
    // order above matters.
    related.set(collection, store.ids(collection));
  }

  const app = express();
  app.use(express.json());

  // Matched from the path rather than from `req.route`, which does not exist
  // yet: the chaos middleware runs before the router, so the guard that keeps
  // injected statuses inside the contract silently did nothing.
  const matchers = routes.map((route) => ({ route, matcher: matcherFor(route) }));

  const declaredStatuses = (req: Request): number[] => {
    const found = matchers.find(
      ({ route, matcher }) => route.method === req.method.toLowerCase() && matcher.test(req.path),
    );
    return found?.route.responses.map((response) => response.status) ?? [];
  };

  app.use(
    chaosMiddleware({
      scenario,
      random: seededRandom(seed),
      declaredStatuses,
      ...(options.onInjected ? { onInjected: options.onInjected } : {}),
    }),
  );

  for (const route of routes) {
    const success = successResponse(route);
    const status = success?.status ?? 200;

    app[route.method](route.express, (req, res) => {
      const body = handle(route, req, store, generator, success?.schema);

      if (body === undefined) {
        res.status(404).json({ error: 'not_found', resource: route.collection ?? route.template });
        return;
      }

      const errors = validator.check(success?.schema, body);
      if (errors.length > 0) {
        const message = `${route.method.toUpperCase()} ${route.template} produced a body its own schema rejects: ${errors.join('; ')}`;
        warn(message);

        // Strict mode turns a contract drift into a 500 rather than letting a
        // frontend be built against a shape the real API cannot return.
        if (options.strictResponses) {
          res.status(500).json({ error: 'response_schema_violation', details: errors });
          return;
        }
      }

      res.status(route.method === 'post' ? (status === 200 ? 201 : status) : status).json(body);
    });
  }

  return { app, store, routes, warnings };
}

function handle(
  route: Route,
  req: Request,
  store: MemoryStore,
  generator: ReturnType<typeof createGenerator>,
  schema: Schema | undefined,
): unknown {
  // A path this tool cannot read as a resource still gets a response — it is
  // generated from the schema, with no state behind it. That is the honest
  // fallback for an RPC-shaped API, and it is why the mock is useful before
  // anyone has agreed what the resources are.
  //
  // The second condition matters as much as the first: `/health` looks exactly
  // like a collection to a path-shape heuristic, and serving it as one returned
  // an empty array where the spec declares an object. A collection nothing was
  // seeded into is not a collection.
  if (!route.collection || !store.names().includes(route.collection)) {
    return generator.generate(schema);
  }

  const id = route.idParam ? (req.params as Record<string, string>)[route.idParam] : undefined;

  switch (route.method) {
    case 'get': {
      if (id !== undefined) return store.get(route.collection, id);

      const limit = numberParam(req, 'limit');
      const offset = numberParam(req, 'offset');
      const page = store.list(route.collection, {
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });

      // The list is wrapped back into whatever envelope the schema declares,
      // so a spec that returns `{ data, total }` gets that and a spec that
      // returns a bare array gets a bare array.
      return wrap(schema, page.items, page.total);
    }
    case 'post': {
      // A real API fills in what the client did not send — the id, timestamps,
      // defaults — and returns the whole resource. Creating from the request
      // body alone returns an object its own response schema rejects, which
      // teaches the client a shape the API will never produce.
      const generated = generator.generate(schema) as Item;
      const merged: Item = { ...generated, ...(req.body as Item) };
      delete merged.id;
      return store.create(route.collection, merged);
    }
    case 'put':
      return id === undefined
        ? undefined
        : store.update(route.collection, id, req.body as Item, false);
    case 'patch':
      return id === undefined
        ? undefined
        : store.update(route.collection, id, req.body as Item, true);
    case 'delete':
      return id !== undefined && store.remove(route.collection, id) ? {} : undefined;
    default:
      return generator.generate(schema);
  }
}

function numberParam(req: Request, name: string): number | undefined {
  const raw = req.query[name];
  if (typeof raw !== 'string') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function wrap(schema: Schema | undefined, items: Item[], total: number): unknown {
  if (!schema || schema.type === 'array') return items;

  for (const key of ['data', 'items', 'results']) {
    if ((schema.properties?.[key] as Schema | undefined)?.type === 'array') {
      const envelope: Record<string, unknown> = { [key]: items };
      for (const countKey of ['total', 'count', 'totalCount']) {
        if (schema.properties?.[countKey]) envelope[countKey] = total;
      }
      return envelope;
    }
  }
  return items;
}
