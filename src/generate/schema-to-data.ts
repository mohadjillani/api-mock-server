import { Faker, en } from '@faker-js/faker';
import type { Schema } from '../spec/load.ts';
import { callFaker, extensionsOf } from './extensions.ts';

export interface GenerateOptions {
  seed: number;
  /** Ids already generated per collection, for `x-mock-relation`. */
  related?: Map<string, unknown[]>;
  onWarning?: (message: string) => void;
  /** Guards against a spec whose schemas nest into each other. */
  maxDepth?: number;
}

/**
 * A generator seeded once per run.
 *
 * Determinism is the feature. A mock whose data changes on every restart makes
 * a failing frontend test unreproducible — the developer reloads, the data is
 * different, and the bug is gone. Same seed, same spec, same bytes.
 */
export function createGenerator(options: GenerateOptions) {
  const faker = new Faker({ locale: en });
  faker.seed(options.seed);

  const maxDepth = options.maxDepth ?? 6;

  function generate(schema: Schema | undefined, depth = 0): unknown {
    if (!schema) return {};

    const extensions = extensionsOf(schema);
    if ('value' in extensions) return extensions.value;

    if (extensions.relation) {
      const ids = options.related?.get(extensions.relation) ?? [];
      if (ids.length > 0) return faker.helpers.arrayElement(ids);
      options.onWarning?.(
        `x-mock-relation points at "${extensions.relation}", which has no seeded items`,
      );
    }

    if (extensions.faker) {
      const value = callFaker(faker, extensions.faker);
      if (value !== undefined) return value;
      options.onWarning?.(`x-mock-faker path "${extensions.faker}" is not a faker function`);
    }

    // A schema that names its own values needs no invention.
    if (schema.enum && schema.enum.length > 0) return faker.helpers.arrayElement(schema.enum);
    if (schema.default !== undefined) return schema.default;
    if (schema.example !== undefined) return schema.example;

    // Composition: take the first branch rather than trying to satisfy all of
    // them. `allOf` is merged because it means "and"; `oneOf` and `anyOf` mean
    // "pick one", and picking the first is deterministic where picking at
    // random would not be.
    if (schema.allOf) {
      return Object.assign(
        {},
        ...schema.allOf.map((branch) => generate(branch as Schema, depth + 1)),
      ) as unknown;
    }
    if (schema.oneOf?.[0]) return generate(schema.oneOf[0] as Schema, depth + 1);
    if (schema.anyOf?.[0]) return generate(schema.anyOf[0] as Schema, depth + 1);

    if (depth > maxDepth) return null;

    switch (schema.type) {
      case 'array': {
        const count = extensions.count ?? faker.number.int({ min: 1, max: 3 });
        return Array.from({ length: count }, () => generate(schema.items as Schema, depth + 1));
      }
      case 'object':
        return generateObject(schema, depth);
      case 'integer':
        return faker.number.int({
          min: schema.minimum ?? 1,
          max: schema.maximum ?? 10_000,
        });
      case 'number':
        return Number(
          faker.number
            .float({ min: schema.minimum ?? 0, max: schema.maximum ?? 1_000, fractionDigits: 2 })
            .toFixed(2),
        );
      case 'boolean':
        return faker.datatype.boolean();
      case 'string':
        return generateString(schema);
      default:
        // No `type` at all is common in hand-written specs. An object is the
        // least surprising guess when there are properties, and a string
        // otherwise.
        return schema.properties ? generateObject(schema, depth) : faker.lorem.word();
    }
  }

  function generateObject(schema: Schema, depth: number): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      result[name] = generate(property as Schema, depth + 1);
    }
    return result;
  }

  function generateString(schema: Schema): string {
    if (schema.pattern) {
      // Honouring an arbitrary regex needs a regex-to-string engine; the
      // pattern is reported instead of being quietly ignored, because a
      // generated value that fails the spec's own pattern is worse than a
      // warning.
      options.onWarning?.(
        `pattern "${schema.pattern}" is not generated from; using a plain string`,
      );
    }

    switch (schema.format) {
      case 'date-time':
        return faker.date.recent({ days: 30 }).toISOString();
      case 'date':
        return faker.date.recent({ days: 30 }).toISOString().slice(0, 10);
      case 'email':
        return faker.internet.email();
      case 'uuid':
        return faker.string.uuid();
      case 'uri':
      case 'url':
        return faker.internet.url();
      case 'hostname':
        return faker.internet.domainName();
      case 'ipv4':
        return faker.internet.ipv4();
      case 'password':
        return faker.internet.password();
      case 'byte':
        return Buffer.from(faker.lorem.word()).toString('base64');
      default: {
        const words = faker.lorem.words({ min: 1, max: 3 });
        const min = schema.minLength ?? 0;
        const max = schema.maxLength ?? 60;
        return words.length < min ? words.padEnd(min, 'x') : words.slice(0, max);
      }
    }
  }

  return { generate, faker };
}
