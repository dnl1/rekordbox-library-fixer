import { create } from 'zustand';

/**
 * The copy the user chose to keep, per duplicate set, over the one the
 * strategy recommends. Read by the set's card and by the resolution alike, so
 * the copy marked "Will be kept" is the one kept. The choice used to live in
 * the card alone: the resolution never saw it, and "manual" kept the first copy
 * whatever was picked.
 *
 * Not persisted: a rescan gives metadata sets new ids, and a choice should not
 * outlive the list it was made on.
 */
interface KeeperChoiceState {
  /** Track id to keep, by duplicate set id. */
  chosen: Record<string, string>;
  choose: (setId: string, trackId: string) => void;
  clear: (setId: string) => void;
}

export const useKeeperChoiceStore = create<KeeperChoiceState>()((set) => ({
  chosen: {},
  choose: (setId, trackId) => set((s) => ({ chosen: { ...s.chosen, [setId]: trackId } })),
  clear: (setId) => set((s) => {
    const { [setId]: _dropped, ...rest } = s.chosen;
    return { chosen: rest };
  }),
}));
