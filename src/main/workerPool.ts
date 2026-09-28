export const MIN_WORKERS = 1;
/** Past eight, the disk is the limit rather than the processor, and the app itself starts to stutter. */
export const MAX_WORKERS = 8;
export const DEFAULT_WORKERS = 4;

export const clampWorkers = (workers: number | undefined): number =>
  Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, Math.floor(Number(workers) || DEFAULT_WORKERS)));

/**
 * Run `work` over `items`, at most `workers` at a time, keeping the results in
 * the order of the items. Each call to `work` is its own ffmpeg process in
 * practice, so this is what spreads a long run over the machine's cores.
 *
 * Once `cancelToken` is set, no new item starts; the ones already running are
 * left to the caller's own cancel handling, and their slots come back empty.
 *
 * `onActive` hears how many are running whenever that changes, so a progress
 * bar can say how many workers are busy — fewer than asked near the end.
 */
export async function runPool<T, R>(
  items: T[],
  workers: number,
  work: (item: T, index: number) => Promise<R>,
  cancelToken: { cancelled: boolean },
  onActive?: (active: number) => void
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length);
  let next = 0;
  let active = 0;
  const lane = async () => {
    while (!cancelToken.cancelled && next < items.length) {
      const index = next++;
      active++; onActive?.(active);
      try {
        results[index] = await work(items[index], index);
      } finally {
        active--; onActive?.(active);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(clampWorkers(workers), items.length) }, lane));
  return results;
}
