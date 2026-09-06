import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/memory-store.ts';

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
  store.seed('books', [
    { id: 1, title: 'One' },
    { id: 2, title: 'Two' },
    { id: 3, title: 'Three' },
  ]);
});

describe('MemoryStore', () => {
  it('lists everything by default', () => {
    expect(store.list('books')).toMatchObject({ total: 3 });
    expect(store.list('books').items).toHaveLength(3);
  });

  it('pages with limit and offset, reporting the unpaged total', () => {
    const page = store.list('books', { limit: 2, offset: 1 });
    expect(page.items.map((item) => item.id)).toEqual([2, 3]);
    // The total is of the collection, not of the page — a client rendering
    // pagination needs the first, and returning the second is the classic bug.
    expect(page.total).toBe(3);
  });

  it('returns an empty page past the end rather than failing', () => {
    expect(store.list('books', { offset: 99 }).items).toEqual([]);
  });

  it('finds an item whose id arrives as a string from a URL', () => {
    expect(store.get('books', '2')).toMatchObject({ title: 'Two' });
  });

  it('returns nothing for an unknown id or collection', () => {
    expect(store.get('books', 99)).toBeUndefined();
    expect(store.get('nope', 1)).toBeUndefined();
    expect(store.list('nope').items).toEqual([]);
  });

  it('creates with the next id past the highest, not past the count', () => {
    store.remove('books', 2);
    // 4, not 3: reusing 3 would hand out an id another record may still
    // reference.
    expect(store.create('books', { title: 'New' }).id).toBe(4);
  });

  it('keeps a client-supplied id', () => {
    expect(store.create('books', { id: 77, title: 'Chosen' }).id).toBe(77);
  });

  it('falls back to a string id when the collection has none', () => {
    store.seed('empty', []);
    expect(store.create('empty', { title: 'First' }).id).toBe('gen-1');
  });

  it('replaces on put and keeps the id', () => {
    const updated = store.update('books', 1, { title: 'Replaced' }, false);
    expect(updated).toEqual({ title: 'Replaced', id: 1 });
  });

  it('merges on patch', () => {
    expect(store.update('books', 1, { subtitle: 'Added' }, true)).toEqual({
      id: 1,
      title: 'One',
      subtitle: 'Added',
    });
  });

  it('reports a missing item on update rather than creating one', () => {
    expect(store.update('books', 99, { title: 'Ghost' }, true)).toBeUndefined();
    expect(store.size('books')).toBe(3);
  });

  it('removes an item once', () => {
    expect(store.remove('books', 1)).toBe(true);
    expect(store.remove('books', 1)).toBe(false);
    expect(store.size('books')).toBe(2);
  });

  it('lists its collections and their ids', () => {
    expect(store.names()).toEqual(['books']);
    expect(store.ids('books')).toEqual([1, 2, 3]);
  });

  it('does not alias the array it was seeded with', () => {
    const item = { id: 9 };
    store.seed('other', [item]);
    item.id = 10;
    // A caller mutating its own objects afterwards must not change the store.
    expect(store.get('other', 9)).toBeDefined();
  });
});
