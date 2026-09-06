import { describe, expect, it } from 'vitest';
import { createGenerator } from '../../src/generate/schema-to-data.ts';
import { callFaker, extensionsOf } from '../../src/generate/extensions.ts';
import type { Schema } from '../../src/spec/load.ts';

function generate(schema: Schema, seed = 42, related?: Map<string, unknown[]>): unknown {
  return createGenerator({ seed, ...(related ? { related } : {}) }).generate(schema);
}

describe('the generator', () => {
  /**
   * The property the whole tool rests on. A mock whose data changes on every
   * restart makes a failing frontend test unreproducible: reload, different
   * data, bug gone.
   */
  it('produces identical data for the same seed', () => {
    const schema: Schema = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
    };
    expect(generate(schema, 7)).toEqual(generate(schema, 7));
  });

  it('produces different data for a different seed', () => {
    const schema: Schema = { type: 'object', properties: { name: { type: 'string' } } };
    expect(generate(schema, 1)).not.toEqual(generate(schema, 2));
  });

  it('respects integer bounds', () => {
    const value = generate({ type: 'integer', minimum: 10, maximum: 12 }) as number;
    expect(value).toBeGreaterThanOrEqual(10);
    expect(value).toBeLessThanOrEqual(12);
  });

  it('picks from an enum rather than inventing a value', () => {
    const value = generate({ type: 'string', enum: ['draft', 'published'] });
    expect(['draft', 'published']).toContain(value);
  });

  it('prefers an example or a default over generating', () => {
    expect(generate({ type: 'string', example: 'from-example' })).toBe('from-example');
    expect(generate({ type: 'string', default: 'from-default' })).toBe('from-default');
  });

  it.each([
    ['date-time', /^\d{4}-\d{2}-\d{2}T/],
    ['date', /^\d{4}-\d{2}-\d{2}$/],
    ['email', /@/],
    ['uuid', /^[0-9a-f]{8}-/],
    ['uri', /^https?:\/\//],
  ])('honours the %s format', (format, pattern) => {
    expect(String(generate({ type: 'string', format }))).toMatch(pattern);
  });

  it('merges allOf branches, because allOf means and', () => {
    const value = generate({
      allOf: [
        { type: 'object', properties: { a: { type: 'string', example: 'A' } } },
        { type: 'object', properties: { b: { type: 'string', example: 'B' } } },
      ],
    });
    expect(value).toEqual({ a: 'A', b: 'B' });
  });

  it('takes the first oneOf branch, deterministically', () => {
    const schema = {
      oneOf: [
        { type: 'string', example: 'first' },
        { type: 'string', example: 'second' },
      ],
    } as Schema;
    expect(generate(schema)).toBe('first');
    expect(generate(schema, 999)).toBe('first');
  });

  it('generates x-mock-count items for an array', () => {
    const value = generate({
      type: 'array',
      items: { type: 'string' },
      'x-mock-count': 4,
    } as unknown as Schema);
    expect(value).toHaveLength(4);
  });

  it('uses x-mock-value verbatim', () => {
    expect(generate({ type: 'string', 'x-mock-value': 'exact' } as unknown as Schema)).toBe(
      'exact',
    );
  });

  it('draws x-mock-relation from the related collection', () => {
    const related = new Map<string, unknown[]>([['authors', [1, 2, 3]]]);
    const value = generate(
      { type: 'integer', 'x-mock-relation': 'authors' } as unknown as Schema,
      42,
      related,
    );
    expect([1, 2, 3]).toContain(value);
  });

  it('warns instead of failing when a relation has nothing to draw from', () => {
    const warnings: string[] = [];
    createGenerator({ seed: 1, onWarning: (message) => warnings.push(message) }).generate({
      type: 'integer',
      'x-mock-relation': 'ghosts',
    } as unknown as Schema);

    expect(warnings[0]).toContain('ghosts');
  });

  it('warns instead of failing on an unknown faker path', () => {
    const warnings: string[] = [];
    const value = createGenerator({
      seed: 1,
      onWarning: (message) => warnings.push(message),
    }).generate({ type: 'string', 'x-mock-faker': 'not.a.thing' } as unknown as Schema);

    expect(warnings[0]).toContain('not.a.thing');
    // Degraded to schema-driven generation rather than crashing the server on
    // a typo in a vendor extension.
    expect(typeof value).toBe('string');
  });

  it('warns that a pattern is not honoured rather than silently ignoring it', () => {
    const warnings: string[] = [];
    createGenerator({ seed: 1, onWarning: (message) => warnings.push(message) }).generate({
      type: 'string',
      pattern: '^[A-Z]{3}$',
    });

    expect(warnings[0]).toContain('pattern');
  });

  it('stops at the depth limit instead of recursing forever', () => {
    const node: Schema = { type: 'object', properties: {} };
    node.properties = { child: node };

    expect(() => generate(node)).not.toThrow();
  });

  it('guesses an object when a schema has properties but no type', () => {
    expect(generate({ properties: { a: { type: 'string', example: 'x' } } })).toEqual({
      a: 'x',
    });
  });
});

describe('extensionsOf', () => {
  it('reads every extension', () => {
    expect(
      extensionsOf({
        'x-mock-count': 3,
        'x-mock-faker': 'person.fullName',
        'x-mock-value': null,
        'x-mock-relation': 'authors',
      } as unknown as Schema),
    ).toEqual({ count: 3, faker: 'person.fullName', value: null, relation: 'authors' });
  });

  it('ignores an extension of the wrong type', () => {
    expect(extensionsOf({ 'x-mock-count': 'three' } as unknown as Schema)).toEqual({});
  });

  it('returns nothing for no schema', () => {
    expect(extensionsOf(undefined)).toEqual({});
  });
});

describe('callFaker', () => {
  it('returns undefined for a path that is not a function', () => {
    expect(callFaker({ person: { name: 'not callable' } }, 'person.name')).toBeUndefined();
    expect(callFaker({}, 'nothing.here')).toBeUndefined();
  });
});
