/** Prisma Decimal / bigint / Date → JSON-safe values. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, inner) => {
      if (typeof inner === 'bigint') return inner.toString();
      if (inner && typeof inner === 'object' && typeof inner.toNumber === 'function') {
        return inner.toNumber();
      }
      return inner;
    }),
  ) as T;
}
