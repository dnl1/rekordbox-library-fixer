/**
 * The copy a duplicate set keeps: the one the user chose, if it is still in the
 * set; otherwise the strategy's recommendation; otherwise none — which, for the
 * manual strategy, means the set waits for a choice rather than keeping
 * whichever copy happens to be listed first.
 */
export function keeperOfSet<T extends { id: string }>(
  tracks: T[],
  recommended: T | null,
  chosenId: string | undefined
): T | null {
  const chosen = chosenId ? tracks.find((t) => t.id === chosenId) : undefined;
  return chosen ?? recommended ?? null;
}
