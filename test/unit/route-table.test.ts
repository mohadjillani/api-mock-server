import { describe, expect, it } from 'vitest';
import { collectionFor, toExpressPath } from '../../src/spec/route-table.ts';

describe('toExpressPath', () => {
  it('converts a template parameter', () => {
    expect(toExpressPath('/books/{id}')).toBe('/books/:id');
  });

  it('converts every parameter in a nested path', () => {
    expect(toExpressPath('/authors/{authorId}/books/{bookId}')).toBe(
      '/authors/:authorId/books/:bookId',
    );
  });

  it('leaves a path without parameters alone', () => {
    expect(toExpressPath('/health')).toBe('/health');
  });
});

describe('collectionFor', () => {
  it('reads a collection from a list path', () => {
    expect(collectionFor('/books')).toEqual({ collection: 'books' });
  });

  it('reads a collection and an id from an item path', () => {
    expect(collectionFor('/books/{id}')).toEqual({ collection: 'books', idParam: 'id' });
  });

  it('uses the nearest collection in a nested path', () => {
    expect(collectionFor('/authors/{authorId}/books')).toEqual({ collection: 'books' });
    expect(collectionFor('/authors/{authorId}/books/{bookId}')).toEqual({
      collection: 'books',
      idParam: 'bookId',
    });
  });

  it('finds nothing in a path that is only parameters', () => {
    expect(collectionFor('/{a}/{b}')).toEqual({});
  });

  it('finds nothing at the root', () => {
    expect(collectionFor('/')).toEqual({});
  });

  it('names the id parameter as the spec did', () => {
    expect(collectionFor('/books/{isbn}').idParam).toBe('isbn');
  });
});
