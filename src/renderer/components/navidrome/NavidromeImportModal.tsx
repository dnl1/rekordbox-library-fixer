import React, { useEffect, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';

export interface NavidromeImportOptions {
  convertToAiff: boolean;
  autoHotCues: boolean;
}

interface Props {
  /** About how many tracks: a playlist's songs are only counted by the server until they are listed. */
  trackCount: number;
  destination: string;
  onConfirm: (options: NavidromeImportOptions) => void;
  onCancel: () => void;
}

/**
 * What to do with the songs on their way into rekordbox: turn the
 * high-quality files into AIFF, and give the tracks hot cues. Opens on
 * "Import into rekordbox", ticked as it was last time.
 */
export const NavidromeImportModal: React.FC<Props> = ({ trackCount, destination, onConfirm, onCancel }) => {
  const saved = useSettingsStore.getState();
  const [convertToAiff, setConvertToAiff] = useState(saved.navidromeConvertToAiff);
  const [autoHotCues, setAutoHotCues] = useState(saved.navidromeAutoHotCues);
  const importButton = useRef<HTMLButtonElement>(null);

  // Focus moves into the dialog, onto what most people press next.
  useEffect(() => { importButton.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { onCancel(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const confirm = () => {
    useSettingsStore.getState().setNavidromeImportOptions({ convertToAiff, autoHotCues });
    onConfirm({ convertToAiff, autoHotCues });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div role="dialog" aria-modal="true" aria-labelledby="navidrome-import-title" className="bg-white rounded-te shadow-xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-te-grey-200">
          <h2 id="navidrome-import-title" className="font-semibold text-te-grey-800 font-te-mono text-sm uppercase tracking-wider">
            Import into rekordbox
          </h2>
          <button onClick={onCancel} aria-label="Close" className="text-te-grey-400 hover:text-te-grey-700">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <p className="text-sm text-te-grey-600 font-te-mono">
            About {trackCount} track{trackCount === 1 ? '' : 's'}, downloaded to <span className="break-all text-te-grey-800">{destination}</span>.
          </p>

          <label htmlFor="navidrome-convert-aiff" className="flex items-start gap-3 cursor-pointer">
            <input
              id="navidrome-convert-aiff" type="checkbox" checked={convertToAiff}
              onChange={(e) => setConvertToAiff(e.target.checked)} className="mt-1 accent-te-orange"
            />
            <span className="text-sm font-medium text-te-grey-800">
              Convert to AIFF
              <span className="block text-xs font-normal font-te-mono text-te-grey-500">
                FLAC, WAV and M4A become AIFF before rekordbox sees them: every CDJ plays it, with tags and artwork.
                MP3 and AIFF stay as they are. Each downloaded original is removed once rekordbox points at its
                AIFF — the server still has it.
              </span>
            </span>
          </label>

          <label htmlFor="navidrome-auto-hot-cues" className="flex items-start gap-3 cursor-pointer">
            <input
              id="navidrome-auto-hot-cues" type="checkbox" checked={autoHotCues}
              onChange={(e) => setAutoHotCues(e.target.checked)} className="mt-1 accent-te-orange"
            />
            <span className="text-sm font-medium text-te-grey-800">
              Add hot cues
              <span className="block text-xs font-normal font-te-mono text-te-grey-500">
                From rekordbox&apos;s phrase analysis, as Auto hot cues does. rekordbox has to analyse the new tracks
                first: analyse them there, close rekordbox, and the cues are added the next time this app opens the
                library — or from the Navidrome page.
              </span>
            </span>
          </label>
        </div>

        <div className="flex gap-3 justify-end px-5 py-4 border-t border-te-grey-200 bg-te-cream">
          <button onClick={onCancel} className="btn-secondary text-xs">Cancel</button>
          <button ref={importButton} onClick={confirm} className="btn-primary text-xs flex items-center gap-1">
            <Download size={12} /> Import
          </button>
        </div>
      </div>
    </div>
  );
};
