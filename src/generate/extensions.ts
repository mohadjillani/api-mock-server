import type { Schema } from '../spec/load.ts';

/**
 * The `x-mock-*` vendor extensions.
 *
 * OpenAPI already describes shape and constraints; what it cannot say is
 * "this is a person's name" or "seed forty of these". These four extensions
 * cover the cases where a spec-derived mock is otherwise useless — a list of
 * users called `string`, `string`, `string` — without inventing a second
 * schema language alongside the first.
 */
export interface MockExtensions {
  /** How many items to seed for a collection. Read from the array schema. */
  count?: number;
  /** A faker path, e.g. `person.fullName` or `internet.email`. */
  faker?: string;
  /** A fixed value, used verbatim. */
  value?: unknown;
  /** Draw the value from the ids of another seeded collection. */
  relation?: string;
}

export function extensionsOf(schema: Schema | undefined): MockExtensions {
  if (!schema) return {};
  const raw = schema as Record<string, unknown>;

  return {
    ...(typeof raw['x-mock-count'] === 'number' ? { count: raw['x-mock-count'] } : {}),
    ...(typeof raw['x-mock-faker'] === 'string' ? { faker: raw['x-mock-faker'] } : {}),
    ...('x-mock-value' in raw ? { value: raw['x-mock-value'] } : {}),
    ...(typeof raw['x-mock-relation'] === 'string' ? { relation: raw['x-mock-relation'] } : {}),
  };
}

/**
 * Resolves a dotted faker path against the faker instance.
 *
 * Returns undefined rather than throwing on an unknown path: a typo in a
 * vendor extension should degrade to schema-driven generation and a warning,
 * not stop a mock server from starting.
 */
export function callFaker(faker: object, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = faker;

  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === 'function' ? (current as () => unknown)() : undefined;
}
