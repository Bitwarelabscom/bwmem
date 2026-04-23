/**
 * Run `fn` over `items` with a bounded concurrency level.
 *
 * Preserves input order in the result. Each item's promise is independent;
 * a rejection from one does not cancel the others — rejections surface on
 * the returned promise once all items have settled. This is stricter than
 * `Promise.allSettled` (which never rejects) but safer than unconstrained
 * `Promise.all(items.map(fn))` which would fire every request in parallel.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const bound = Math.max(1, Math.min(limit, items.length));
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let firstError: unknown;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        if (firstError === undefined) firstError = err;
      }
    }
  }

  await Promise.all(Array.from({ length: bound }, () => worker()));
  if (firstError !== undefined) throw firstError;
  return results;
}
