export type Item = Record<string, unknown> & { id?: unknown };

export interface Page {
  items: Item[];
  total: number;
}

/**
 * Collections with real CRUD semantics.
 *
 * The difference between this and a mock that returns a canned response is the
 * whole point: a frontend that creates a record and then lists records sees
 * the one it just created. Most bugs a mock is used to find live in exactly
 * that sequence.
 */
export class MemoryStore {
  private readonly collections = new Map<string, Item[]>();
  private counter = 0;

  seed(collection: string, items: Item[]): void {
    this.collections.set(
      collection,
      items.map((item) => ({ ...item })),
    );
  }

  list(collection: string, options: { limit?: number; offset?: number } = {}): Page {
    const items = this.collections.get(collection) ?? [];
    const offset = Math.max(0, options.offset ?? 0);
    const limit = options.limit ?? items.length;

    return { items: items.slice(offset, offset + limit), total: items.length };
  }

  get(collection: string, id: unknown): Item | undefined {
    // Loose comparison on purpose: an id arrives from a URL as a string, and
    // the seeded value may be a number. Requiring the caller to know which
    // would make every route handler carry the same conversion.
    return (this.collections.get(collection) ?? []).find((item) => String(item.id) === String(id));
  }

  create(collection: string, body: Item, idKey = 'id'): Item {
    const items = this.collections.get(collection) ?? [];
    const item: Item = { ...body };

    if (item[idKey] === undefined) {
      this.counter += 1;
      // Matches the type of the ids already there: a client that expects
      // numeric ids should not start receiving strings after the first POST.
      // One past the highest, not one past the count — deleting an item and
      // then creating one must not reuse an id that is still referenced
      // somewhere.
      const numeric = items
        .map((existing) => existing[idKey])
        .filter((id): id is number => typeof id === 'number');

      item[idKey] = numeric.length > 0 ? Math.max(...numeric) + 1 : `gen-${String(this.counter)}`;
    }

    this.collections.set(collection, [...items, item]);
    return item;
  }

  update(collection: string, id: unknown, body: Item, merge: boolean): Item | undefined {
    const items = this.collections.get(collection) ?? [];
    const index = items.findIndex((item) => String(item.id) === String(id));
    if (index === -1) return undefined;

    const existing = items[index] ?? {};
    // PUT replaces, PATCH merges — and the id survives either way, because a
    // body that omits it must not delete it.
    const next: Item = merge ? { ...existing, ...body } : { ...body, id: existing.id };
    items[index] = next;
    return next;
  }

  remove(collection: string, id: unknown): boolean {
    const items = this.collections.get(collection) ?? [];
    const next = items.filter((item) => String(item.id) !== String(id));
    this.collections.set(collection, next);
    return next.length !== items.length;
  }

  /** Ids per collection, so `x-mock-relation` can point at real values. */
  ids(collection: string): unknown[] {
    return (this.collections.get(collection) ?? [])
      .map((item) => item.id)
      .filter((id) => id !== undefined);
  }

  names(): string[] {
    return [...this.collections.keys()];
  }

  size(collection: string): number {
    return (this.collections.get(collection) ?? []).length;
  }
}
