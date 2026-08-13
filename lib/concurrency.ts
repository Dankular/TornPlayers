/** Runs `worker` over `items` with at most `concurrency` in flight at once. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const current = next++;
      results[current] = await worker(items[current], current);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, run);
  await Promise.all(runners);
  return results;
}
