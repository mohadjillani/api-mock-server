import type { OpenAPIV3 } from 'openapi-types';
import type { Document, Schema } from './load.ts';

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

const METHODS: Method[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export interface RouteResponse {
  status: number;
  schema?: Schema;
}

export interface Route {
  method: Method;
  /** The spec's own template, e.g. `/users/{id}`. */
  template: string;
  /** Express 5 form, e.g. `/users/:id`. */
  express: string;
  operationId?: string;
  parameters: OpenAPIV3.ParameterObject[];
  requestSchema?: Schema;
  responses: RouteResponse[];
  /** The collection this route operates on, when the path looks like a resource. */
  collection?: string;
  /** The path parameter naming a single item, when there is one. */
  idParam?: string;
}

/**
 * Converts `{id}` to `:id`.
 *
 * Express 5 moved to a stricter path parser, which is why this is a deliberate
 * conversion rather than a regex applied at request time: a template with a
 * character Express treats as a modifier would otherwise become a route that
 * silently matches something else.
 */
export function toExpressPath(template: string): string {
  return template.replace(/\{([^}]+)\}/g, ':$1');
}

/**
 * Infers the collection a path operates on from its shape.
 *
 * `/users` and `/users/{id}` are the same collection; `/users/{id}/posts` is a
 * different one. The rule is the last path segment that is not a parameter,
 * which covers the overwhelming majority of REST-shaped specs and is wrong for
 * RPC-shaped ones — where the mock still serves generated responses, just
 * without CRUD semantics.
 */
export function collectionFor(template: string): { collection?: string; idParam?: string } {
  const segments = template.split('/').filter(Boolean);
  if (segments.length === 0) return {};

  const last = segments[segments.length - 1] ?? '';
  const isParam = last.startsWith('{') && last.endsWith('}');

  if (!isParam) return { collection: last };

  const parent = segments[segments.length - 2];
  if (!parent || parent.startsWith('{')) return {};
  return { collection: parent, idParam: last.slice(1, -1) };
}

function schemaOf(
  media: Record<string, OpenAPIV3.MediaTypeObject> | undefined,
): Schema | undefined {
  const json = media?.['application/json'] ?? Object.values(media ?? {})[0];
  return json?.schema as Schema | undefined;
}

export function buildRouteTable(document: Document): Route[] {
  const routes: Route[] = [];

  for (const [template, item] of Object.entries(document.paths ?? {})) {
    if (!item) continue;
    const shared = (item.parameters ?? []) as OpenAPIV3.ParameterObject[];

    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;

      const responses: RouteResponse[] = [];
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        const code = status === 'default' ? 500 : Number(status);
        if (!Number.isFinite(code)) continue;

        const schema = schemaOf((response as OpenAPIV3.ResponseObject).content);
        responses.push({ status: code, ...(schema ? { schema } : {}) });
      }

      const requestSchema = schemaOf(
        (operation.requestBody as OpenAPIV3.RequestBodyObject | undefined)?.content,
      );

      routes.push({
        method,
        template,
        express: toExpressPath(template),
        ...(operation.operationId ? { operationId: operation.operationId } : {}),
        parameters: [...shared, ...((operation.parameters ?? []) as OpenAPIV3.ParameterObject[])],
        ...(requestSchema ? { requestSchema } : {}),
        // Ascending, so the lowest success code is the one served by default.
        responses: responses.sort((a, b) => a.status - b.status),
        ...collectionFor(template),
      });
    }
  }

  return routes;
}

/**
 * A matcher for a route's path, for use before Express has routed a request.
 *
 * Middleware that runs ahead of the router has no `req.route`, so anything
 * needing to know which operation a request belongs to — the chaos layer, for
 * one — has to work it out from the path itself.
 */
export function matcherFor(route: Route): RegExp {
  const pattern = route.template
    .split('/')
    .map((segment) =>
      segment.startsWith('{') && segment.endsWith('}')
        ? '[^/]+'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');

  return new RegExp(`^${pattern}/?$`);
}

/** The response a request should get when nothing goes wrong. */
export function successResponse(route: Route): RouteResponse | undefined {
  return route.responses.find((response) => response.status >= 200 && response.status < 300);
}
