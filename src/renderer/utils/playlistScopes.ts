import type { Playlist } from '../types';

export interface PlaylistScope {
  /**
   * The node's position in the tree — `0/2/1` — not its names: rekordbox lets
   * two playlists in one folder share a name, and a key made of names picked
   * the first of them whichever was chosen.
   */
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

  // Pre-order, so a folder is listed before what is in it; its tracks are only
  // known once its children are walked, so its slot is kept and filled after.
  const walk = (nodes: Playlist[], names: string[], position: number[]): string[] => {
    const underHere: string[] = [];
    nodes.forEach((node, index) => {
      const at = [...position, index];
      const label = [...names, node.name];
      const slot = scopes.length;
      scopes.push(null as unknown as PlaylistScope);
      const own = node.type === 'FOLDER' ? [] : (node.tracks ?? []);
      const beneath = node.children?.length ? walk(node.children, label, at) : [];
      const trackIds = [...new Set([...own, ...beneath])];
      scopes[slot] = { key: at.join('/'), label: label.join(' / '), isFolder: node.type === 'FOLDER', trackIds };
      underHere.push(...trackIds);
    });
    return underHere;
  };

  walk(playlists, [], []);
  return scopes.filter((scope) => scope.trackIds.length > 0);
}
