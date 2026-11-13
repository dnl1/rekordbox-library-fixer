import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Tracks waiting for auto hot cues, by library — a Navidrome import that asked
 * for them. Hot cues are placed on rekordbox's phrase analysis, which a newly
 * imported track does not have until rekordbox analyses it, so the request is
 * kept until then. Persisted: that is usually after this app has been closed.
 */
interface PendingHotCuesState {
  /** `djmdContent.ID`s by library path. */
  byLibrary: Record<string, string[]>;
  add: (libraryPath: string, trackIds: string[]) => void;
  /** Replace a library's list with what is still waiting. */
  keep: (libraryPath: string, trackIds: string[]) => void;
  forget: (libraryPath: string) => void;
}

export const usePendingHotCuesStore = create<PendingHotCuesState>()(
  persist(
    (set) => ({
      byLibrary: {},
      add: (libraryPath, trackIds) => set((s) => ({
        byLibrary: { ...s.byLibrary, [libraryPath]: [...new Set([...(s.byLibrary[libraryPath] ?? []), ...trackIds])] },
      })),
      keep: (libraryPath, trackIds) => set((s) => {
        const byLibrary = { ...s.byLibrary };
        if (trackIds.length > 0) { byLibrary[libraryPath] = trackIds; } else { delete byLibrary[libraryPath]; }
        return { byLibrary };
      }),
      forget: (libraryPath) => set((s) => {
        const byLibrary = { ...s.byLibrary };
        delete byLibrary[libraryPath];
        return { byLibrary };
      }),
    }),
    { name: 'rekordbox-pending-hot-cues', version: 1 },
  ),
);

const NONE: string[] = [];

/** The tracks waiting for hot cues in one library. */
export const usePendingHotCues = (libraryPath: string): string[] =>
  usePendingHotCuesStore((s) => s.byLibrary[libraryPath] ?? NONE);
