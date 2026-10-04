import { orderBy, where, type QueryConstraint } from 'firebase/firestore';

import type { QuerySpec } from '@hireframe/shared';

/** The spec types and the index check live in `@hireframe/shared` (ADR-040 amendment). */
export { indexServes } from '@hireframe/shared';
export type { CompositeIndex, QuerySpec } from '@hireframe/shared';

export function specConstraints(spec: QuerySpec): QueryConstraint[] {
  return [
    ...spec.filters.map((filter) => where(filter.field, filter.op, filter.value)),
    ...spec.orderBy.map((order) => orderBy(order.field, order.direction)),
  ];
}
