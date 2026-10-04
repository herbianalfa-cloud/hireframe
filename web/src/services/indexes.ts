import type { QuerySpec } from './query-spec';

export interface CompositeIndex {
  collectionGroup: string;
  queryScope: string;
  fields: readonly { fieldPath: string; order: 'ASCENDING' | 'DESCENDING' }[];
}

/**
 * Whether Firestore can serve `spec` with the automatic single-field indexes plus the declared
 * composites. Deliberately strict (no index merging for ordered queries), so a query that only
 * works on a lucky merge is declared explicitly instead.
 * - Equality fields (`==`, `in`) may appear in any order, then the ordered fields, in order and
 *   in the same direction. A range filter orders its own field first, ascending unless ordered.
 * - Served without a composite: one ordered field and no filters on other fields, or equality
 *   filters only with no ordering (those merge single-field indexes).
 */
export function indexServes(spec: QuerySpec, indexes: readonly CompositeIndex[]): boolean {
  const equality = new Set(spec.filters.filter((f) => f.op !== '>=').map((f) => f.field));
  const orders = spec.orderBy.map((o) => ({
    field: o.field,
    order: o.direction === 'desc' ? ('DESCENDING' as const) : ('ASCENDING' as const),
  }));
  for (const range of spec.filters.filter((f) => f.op === '>=')) {
    if (!orders.some((o) => o.field === range.field)) {
      orders.unshift({ field: range.field, order: 'ASCENDING' });
    } else if (orders[0]?.field !== range.field) {
      return false; // Firestore requires the range field to be ordered first.
    }
  }
  if (equality.size === 0 && orders.length <= 1) return true;
  if (orders.length === 0) return true;
  return indexes.some((index) => {
    if (index.collectionGroup !== spec.collection) return false;
    if (index.fields.length !== equality.size + orders.length) return false;
    const lead = index.fields.slice(0, equality.size);
    const tail = index.fields.slice(equality.size);
    return (
      lead.every((f) => equality.has(f.fieldPath)) &&
      new Set(lead.map((f) => f.fieldPath)).size === equality.size &&
      tail.every((f, i) => f.fieldPath === orders[i]?.field && f.order === orders[i].order)
    );
  });
}
