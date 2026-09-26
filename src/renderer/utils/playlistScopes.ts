import type { Playlist } from '../types';

export interface PlaylistScope {
  /** Stable within one library: the path of names from the root. */
  key: string;
  /** `Gigs / Friday` — the folder path, so two playlists named alike are told apart. */
  label: string;
  isFolder: boolean;
  /** Every track in it, once; for a folder, every track in every playlist beneath it. */
  trackIds: string[];
}

/**
 * The playlists and folders a conversion can be limited to, in library order.
 *
 * Converting is usually the step before exporting to a USB stick, and
 * rekordbox exports playlists — so what goes on the stick is what gets
 * converted, not a whole collection. A folder stands for everything beneath
 * it, as it does when rekordbox syncs one. Empty ones are left out: there is
 * nothing to convert in them.
 */
export function playlistScopes(playlists: Playlist[]): PlaylistScope[] {
  const scopes: PlaylistScope[] = [];

  const walk = (nodes: Playlist[], trail: string[]): string[] => {
    const underHere: string[] = [];
    for (const node of nodes) {
      const path = [...trail, node.name];
      const own = node.type === 'FOLDER' ? [] : (node.tracks ?? []);
      const beneath = node.children?.length ? walk(node.children, path) : [];
      const trackIds = [...new Set([...own, ...beneath])];
      if (trackIds.length > 0) {
        scopes.push({ key: path.join('\u0000'), label: path.join(' / '), isFolder: node.type === 'FOLDER', trackIds });
      }
      underHere.push(...trackIds);
    }
    return underHere;
  };

  walk(playlists, []);
  // A parent is pushed after its children by the walk; show it first.
  const order = new Map<string, number>();
  const visit = (nodes: Playlist[], trail: string[]) => {
    for (const node of nodes) {
      const path = [...trail, node.name];
      order.set(path.join('\u0000'), order.size);
      if (node.children?.length) { visit(node.children, path); }
    }
  };
  visit(playlists, []);
  return scopes.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}
