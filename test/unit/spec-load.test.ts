import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSpec, SpecError } from '../../src/spec/load.ts';
import { buildRouteTable, successResponse } from '../../src/spec/route-table.ts';

const FIXTURE = fileURLToPath(new URL('../../fixtures/specs/bookstore.yaml', import.meta.url));
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'apimock-'));
});

afterAll(() => {
  // The directory is in the OS temp dir with a random suffix; leaving it is
  // cheaper than the risk of a recursive delete on a path built from a
  // variable.
});

async function write(name: string, contents: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, contents);
  return file;
}

describe('loadSpec', () => {
  it('loads a valid spec and dereferences it', async () => {
    const document = await loadSpec(FIXTURE);

    expect(document.info.title).toBe('Bookstore');
    // Dereferenced: nothing downstream should ever meet a $ref.
    expect(JSON.stringify(document)).not.toContain('$ref');
  });

  it('reports a file that is not there', async () => {
    await expect(loadSpec(path.join(dir, 'missing.yaml'))).rejects.toThrow(SpecError);
  });

  it('reports a document that is not OpenAPI at all', async () => {
    const file = await write('not-a-spec.yaml', 'hello: world\n');
    await expect(loadSpec(file)).rejects.toThrow(SpecError);
  });

  it('refuses Swagger 2 rather than half-supporting it', async () => {
    const file = await write(
      'swagger2.json',
      JSON.stringify({ swagger: '2.0', info: { title: 'Old', version: '1' }, paths: {} }),
    );
    await expect(loadSpec(file)).rejects.toThrow(SpecError);
  });

  it('reports where an invalid spec is wrong', async () => {
    const file = await write(
      'broken.yaml',
      [
        'openapi: 3.0.0',
        'info:',
        '  title: Broken',
        'paths:',
        '  /x:',
        '    get: not-an-object',
      ].join('\n'),
    );

    // The path to the offending keyword is the single most useful thing to put
    // in front of someone whose spec will not load.
    await expect(loadSpec(file)).rejects.toThrow(SpecError);
  });
});

describe('buildRouteTable', () => {
  it('finds every operation', async () => {
    const routes = buildRouteTable(await loadSpec(FIXTURE));

    expect(routes).toHaveLength(7);
    expect(routes.map((route) => `${route.method} ${route.template}`)).toContain(
      'delete /books/{id}',
    );
  });

  it('carries path-level parameters onto each operation', async () => {
    const routes = buildRouteTable(await loadSpec(FIXTURE));
    const item = routes.find((route) => route.template === '/books/{id}' && route.method === 'get');

    expect(item?.parameters.map((parameter) => parameter.name)).toContain('id');
  });

  it('sorts responses so the lowest success code is the default', async () => {
    const routes = buildRouteTable(await loadSpec(FIXTURE));
    const list = routes.find((route) => route.template === '/books' && route.method === 'get');
    if (!list) throw new Error('the list route is missing from the fixture');

    expect(successResponse(list)?.status).toBe(200);
  });

  it('treats a default response as a 500', async () => {
    const file = await write(
      'default-response.yaml',
      [
        'openapi: 3.0.0',
        'info: { title: D, version: "1" }',
        'paths:',
        '  /x:',
        '    get:',
        '      responses:',
        '        default:',
        '          description: anything',
      ].join('\n'),
    );

    const routes = buildRouteTable(await loadSpec(file));
    expect(routes[0]?.responses[0]?.status).toBe(500);
  });

  it('records an operation with no response schema rather than skipping it', async () => {
    const routes = buildRouteTable(await loadSpec(FIXTURE));
    const remove = routes.find((route) => route.method === 'delete');

    expect(remove?.responses.find((response) => response.status === 204)?.schema).toBeUndefined();
  });
});
