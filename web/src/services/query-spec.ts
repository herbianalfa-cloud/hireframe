import {
  orderBy,
  where,
  type OrderByDirection,
  type QueryConstraint,
  type WhereFilterOp,
} from 'firebase/firestore';

/**
 * A Firestore query described as data, so the services build their constraints from it and a
 * test can check each one against `firestore.indexes.json`. The emulator doesn't enforce
 * indexes, so a missing one only shows up in production.
 */
export interface QuerySpec {
  collection: string;
  filters: readonly {
    field: string;
    op: Extract<WhereFilterOp, '==' | 'in' | '>='>;
    value: unknown;
  }[];
  orderBy: readonly { field: string; direction: OrderByDirection }[];
}

export function specConstraints(spec: QuerySpec): QueryConstraint[] {
  return [
    ...spec.filters.map((filter) => where(filter.field, filter.op, filter.value)),
    ...spec.orderBy.map((order) => orderBy(order.field, order.direction)),
  ];
}
