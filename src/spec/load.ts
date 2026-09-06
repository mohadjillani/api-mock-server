import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3 } from 'openapi-types';

export type Document = OpenAPIV3.Document;
export type Schema = OpenAPIV3.SchemaObject;

export class SpecError extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'SpecError';
  }
}

/**
 * Loads, validates and dereferences a spec.
 *
 * Dereferencing up front is what makes everything downstream simple: the route
 * table, the generator and the response validator all work on plain schemas
 * and never have to think about `$ref`, remote documents, or a cycle between
 * two components.
 *
 * It also means a spec that only *looks* valid fails here, with the JSON path
 * to the problem, rather than three layers in as a confusing generation bug.
 */
export async function loadSpec(path: string): Promise<Document> {
  try {
    const parsed = await SwaggerParser.validate(path, { dereference: { circular: 'ignore' } });

    if (!('openapi' in parsed) || !parsed.openapi.startsWith('3.')) {
      throw new SpecError(
        `only OpenAPI 3.x is supported; this document declares ${
          'swagger' in parsed ? `swagger ${parsed.swagger}` : 'no version'
        }`,
      );
    }
    return parsed as Document;
  } catch (error) {
    if (error instanceof SpecError) throw error;
    // swagger-parser's messages carry the JSON path to the offending keyword,
    // which is the single most useful thing to put in front of someone whose
    // spec will not load.
    throw new SpecError(error instanceof Error ? error.message : String(error));
  }
}
