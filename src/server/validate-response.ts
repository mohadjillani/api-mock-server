// ajv and ajv-formats are CommonJS with `export =`. Under NodeNext with
// `verbatimModuleSyntax`, the default import is the module namespace rather
// than the constructor, so the callable lives on `.default`.
import ajvModule, { type Ajv as AjvInstance, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;
const Ajv =
  (ajvModule as unknown as { default?: AjvConstructor }).default ??
  (ajvModule as unknown as AjvConstructor);
const addFormats =
  (addFormatsModule as unknown as { default?: (ajv: AjvInstance) => void }).default ??
  (addFormatsModule as unknown as (ajv: AjvInstance) => void);
import type { Schema } from '../spec/load.ts';

/**
 * Validates what the mock is about to send against the spec it came from.
 *
 * A mock that drifts from the contract is worse than no mock: the frontend is
 * built against a shape the real API will never produce, and the mismatch is
 * discovered during integration, which is the most expensive moment to find
 * it.
 *
 * Because the data is generated from the same schema, a failure here is a bug
 * in this tool — which is exactly why it is checked in the tool's own tests
 * rather than trusted.
 */
export function createValidator() {
  const ajv = new Ajv({
    // OpenAPI 3.0 schemas are JSON Schema-*like*: `nullable`, `example` and the
    // `x-` extensions are not JSON Schema keywords, and strict mode rejects
    // the document rather than the data.
    strict: false,
    allErrors: true,
    coerceTypes: false,
  });
  addFormats(ajv);

  const cache = new Map<Schema, ValidateFunction>();

  function compile(schema: Schema): ValidateFunction {
    const cached = cache.get(schema);
    if (cached) return cached;

    const compiled = ajv.compile(toJsonSchema(schema));
    cache.set(schema, compiled);
    return compiled;
  }

  return {
    /** Returns the validation errors, or an empty array when the body fits. */
    check(schema: Schema | undefined, body: unknown): string[] {
      if (!schema) return [];

      const validate = compile(schema);
      if (validate(body)) return [];

      return (validate.errors ?? []).map(
        (error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
      );
    },
  };
}

/**
 * Translates OpenAPI 3.0's `nullable: true` into a JSON Schema union.
 *
 * 3.1 dropped `nullable` in favour of `type: ['string', 'null']`, so a
 * validator that only understands one of the two rejects half the specs in the
 * world.
 */
export function toJsonSchema(schema: Schema): object {
  const converted: Record<string, unknown> = { ...(schema as Record<string, unknown>) };

  if (converted.nullable === true && typeof converted.type === 'string') {
    converted.type = [converted.type, 'null'];
  }
  delete converted.nullable;
  // `example` is an OpenAPI keyword, not a JSON Schema one; ajv ignores it in
  // non-strict mode but it inflates every compiled schema.
  delete converted.example;

  for (const key of ['properties', 'patternProperties'] as const) {
    const value = converted[key];
    if (value && typeof value === 'object') {
      converted[key] = Object.fromEntries(
        Object.entries(value as Record<string, Schema>).map(([name, child]) => [
          name,
          toJsonSchema(child),
        ]),
      );
    }
  }

  if (converted.items && typeof converted.items === 'object') {
    converted.items = toJsonSchema(converted.items);
  }

  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const value = converted[key];
    if (Array.isArray(value)) {
      converted[key] = value.map((child) => toJsonSchema(child as Schema));
    }
  }

  return converted;
}
